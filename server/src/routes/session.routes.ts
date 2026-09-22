/**
 * 12306 会话路由（需求 3）：扫码登录、会话状态、保活。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { RailwayAccountRepo, PassengersRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import {
  getSessionState,
  startQrLogin,
  getQrLogin,
  refreshQrLogin,
  setQrAutoRefresh,
  cancelQrLogin,
  closeSession,
  checkLoggedIn,
  getContext,
} from '../bot/session.js';
import { URLS } from '../bot/constants.js';

const logger = new Logger('session');

export const sessionRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 会话状态 */
  app.get('/api/session', async (request) => {
    const user = currentUser(request);
    return getSessionState(user.id);
  });

  /**
   * 发起 12306 扫码登录（不保存密码、不需要手机号）。
   * 异步：立即返回"已发起"，浏览器在后台打开扫码页并把二维码通过 WS（qr_code 消息）推送。
   * 用户在管理台扫码确认后，登录结果通过 session 消息推送，前端不阻塞等待此 HTTP 响应。
   */
  const attemptSchema = z.object({ attemptId: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/) });
  app.post('/api/session/login', async (request, reply) => {
    const user = currentUser(request);
    const parsed = attemptSchema.extend({ autoRefresh: z.boolean().default(true) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求参数无效，请刷新管理台页面重试' });
    try { return startQrLogin(user.id, parsed.data.attemptId, parsed.data.autoRefresh); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '登录正在进行中' }); }
  });
  app.get('/api/session/qr', async (request, reply) => {
    const parsed = attemptSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求参数无效' });
    const snapshot = getQrLogin(currentUser(request).id, parsed.data.attemptId);
    if (!snapshot) return reply.code(404).send({ error: '登录已结束，请刷新二维码重新开始' });
    reply.header('Cache-Control', 'no-store');
    return snapshot;
  });
  app.post('/api/session/refresh-qr', async (request, reply) => {
    const parsed = attemptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求参数无效' });
    const user = currentUser(request);
    if (!refreshQrLogin(user.id, parsed.data.attemptId)) return reply.code(409).send({ error: '当前无法刷新，请等待二维码生成或在手机上确认登录' });
    return getQrLogin(user.id, parsed.data.attemptId);
  });
  app.post('/api/session/qr-options', async (request, reply) => {
    const parsed = attemptSchema.extend({ autoRefresh: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求参数无效' });
    const user = currentUser(request);
    if (!setQrAutoRefresh(user.id, parsed.data.attemptId, parsed.data.autoRefresh)) return reply.code(409).send({ error: '登录已结束' });
    return getQrLogin(user.id, parsed.data.attemptId);
  });
  app.post('/api/session/cancel-login', async (request, reply) => {
    const parsed = attemptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求参数无效' });
    cancelQrLogin(currentUser(request).id, parsed.data.attemptId);
    return { ok: true };
  });

  /** 主动检查一次会话有效性 */
  app.post('/api/session/check', async (request) => {
    const user = currentUser(request);
    const ctx = await getContext(user.id).catch(() => null);
    if (!ctx) {
      // 浏览器起不来也必须把状态标成失活，否则前端一直显示"已连接"
      RailwayAccountRepo.updateStatus(user.id, 'invalid', '浏览器未启动');
      wsHub.broadcastToUser(user.id, { type: 'session', payload: getSessionState(user.id) });
      return { loggedIn: false, state: getSessionState(user.id) };
    }
    const ok = await checkLoggedIn(ctx);
    if (ok) {
      RailwayAccountRepo.touchCheck(user.id);
    } else {
      // 关键：检查失败必须落库，否则 DB 里永远是 active，前端一直显示"已连接"
      RailwayAccountRepo.updateStatus(user.id, 'invalid', '会话已失活，请重新扫码登录');
      wsHub.broadcastToUser(user.id, { type: 'session', payload: getSessionState(user.id) });
    }
    return { loggedIn: ok, state: getSessionState(user.id) };
  });

  /** 退出登录 */
  app.post('/api/session/logout', async (request) => {
    const user = currentUser(request);
    await closeSession(user.id);
    return { ok: true };
  });

  /** 从 12306 同步常用联系人（登录后可用） */
  app.post('/api/session/sync-passengers', async (request, reply) => {
    const user = currentUser(request);
    const acc = RailwayAccountRepo.get(user.id);
    if (!acc || acc.status !== 'active') return reply.code(400).send({ error: '12306 未登录，请先在会话页登录' });
    const ctx = await getContext(user.id);
    const page = await ctx.newPage();
    try {
      // 先走一次确认页 UAM 预热，否则联系人接口返回"查询失败"
      await page.goto(`${URLS.CONFIRM_INIT_DC}`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => undefined);
      // 常用联系人必须 GET + 分页参数（POST 无参数返回"查询失败"）
      const raw = await page.evaluate(async (u: string) => {
        const res = await fetch(u, { credentials: 'include' });
        return res.text();
      }, `${URLS.PASSENGERS}?pageIndex=1&pageSize=100`);
      const data = JSON.parse(raw) as {
        data?: { datas?: Array<{ passenger_name: string; passenger_id_type_code: string; passenger_id_no: string; mobile_no: string; passenger_type: string }> };
      };
      const list = data.data?.datas ?? [];
      // 12306 passenger_type: 1=成人 2=儿童 3=学生 4=残军
      const typeMap: Record<string, string> = { '1': '成人', '2': '儿童', '3': '学生', '4': '残军' };
      const mapped = list.map((p) => ({
        name: p.passenger_name,
        idTypeCode: p.passenger_id_type_code || '1',
        idNo: p.passenger_id_no,
        phone: p.mobile_no || null,
        passengerType: typeMap[p.passenger_type] ?? '成人',
        source: '12306' as const,
      }));
      PassengersRepo.bulkUpsert(user.id, mapped);
      logger.info('同步常用联系人', { count: mapped.length, by: user.username });
      return { synced: mapped.length };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      await page.close().catch(() => undefined);
    }
  });

  done();
};
