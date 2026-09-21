/**
 * 12306 会话路由（需求 3）：扫码登录、会话状态、保活。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { RailwayAccountRepo, PassengersRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { Logger } from '../logger.js';
import {
  getSessionState,
  loginInteractive,
  cancelQrLogin,
  closeSession,
  checkLoggedIn,
  getContext,
} from '../bot/session.js';
import { URLS } from '../bot/constants.js';

const logger = new Logger('session');

export const sessionRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 会话状态 */
  app.get('/api/session', async () => {
    const user = currentUser();
    return getSessionState(user.id);
  });

  /**
   * 发起 12306 扫码登录（不保存密码、不需要手机号）。
   * 异步：立即返回"已发起"，浏览器在后台打开扫码页并把二维码通过 WS（qr_code 消息）推送。
   * 用户在管理台扫码确认后，登录结果通过 session 消息推送，前端不阻塞等待此 HTTP 响应。
   */
  app.post('/api/session/login', async () => {
    const user = currentUser();
    // 异步发起，不阻塞 HTTP；并发重复登录由 loginInteractive 内部锁拦截
    void loginInteractive(user.id).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('登录失败', { by: user.username, error: msg });
    });
    return { ok: true, status: 'logging_in', message: '二维码即将显示，请使用 12306 APP 扫码登录' };
  });

  /** 取消扫码登录 */
  app.post('/api/session/cancel-login', async () => {
    const user = currentUser();
    cancelQrLogin(user.id);
    return { ok: true };
  });

  /** 主动检查一次会话有效性 */
  app.post('/api/session/check', async () => {
    const user = currentUser();
    const ctx = await getContext(user.id).catch(() => null);
    if (!ctx) return { loggedIn: false, state: getSessionState(user.id) };
    const ok = await checkLoggedIn(ctx);
    if (ok) RailwayAccountRepo.touchCheck(user.id);
    return { loggedIn: ok, state: getSessionState(user.id) };
  });

  /** 退出登录 */
  app.post('/api/session/logout', async () => {
    const user = currentUser();
    await closeSession(user.id);
    return { ok: true };
  });

  /** 从 12306 同步常用联系人（登录后可用） */
  app.post('/api/session/sync-passengers', async (request, reply) => {
    const user = currentUser();
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
