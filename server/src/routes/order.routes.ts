/**
 * 已购车票路由（需求：管理台「已购车票」主页面）。
 *
 * 页面会定时刷新，为防止请求过于频繁被 12306 封禁，服务端对同一用户做了
 * 最小间隔限制：ORDER_MIN_INTERVAL_MS 内的重复请求直接返回最近一次的缓存结果。
 * 前端另有更长的定时刷新间隔（5 分钟）和「支付截止时刻」的确定刷新节点。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { RailwayAccountRepo, TasksRepo, PlansRepo, PassengersRepo } from '../db/repo.js';
import { verifiedOrderResult } from '../bot/order-result.js';
import { currentUser } from './auth.routes.js';
import { getContext } from '../bot/session.js';
import { queryOrders, type OrderRow } from '../bot/orders.js';
import { warmOrderPage } from '../bot/orderApi.js';
import { refundTickets, RefundRejected } from '../bot/return-ticket.js';
import { rankChangeOptions } from '../bot/change-options.js';
import { queryTrains, queryTransfers } from '../bot/tickets.js';
import { withUserLock } from '../bot/user-lock.js';
import { Logger } from '../logger.js';

const logger = new Logger('orders');

/** 同一用户两次真实查询 12306 的最小间隔（毫秒），之内返回缓存 */
const ORDER_MIN_INTERVAL_MS = 20_000;

interface CacheEntry {
  ts: number;
  rows: OrderRow[];
}
const cache = new Map<string, CacheEntry>();

export function repairTaskResults(userId: string, orders: OrderRow[]): void {
  const passengers = PassengersRepo.list(userId);
  for (const task of TasksRepo.listSuccessful(userId)) {
    const plan = PlansRepo.get(task.planId);
    if (!plan || plan.userId !== userId) continue;
    const names = Array.isArray(task.result?.passengers) && task.result.passengers.every(name => typeof name === 'string')
      ? task.result.passengers as string[] : plan.passengerIds.map(id => passengers.find(p => p.id === id)?.name ?? '');
    const result = verifiedOrderResult(task, plan, names, orders);
    if (result && JSON.stringify(result) !== JSON.stringify(task.result)) TasksRepo.update(task.id, { result });
  }
}

export const orderRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 查询已购车票（已支付 + 待支付） */
  app.get('/api/orders', async (request, reply) => {
    const user = currentUser(request);
    const acc = RailwayAccountRepo.get(user.id);
    if (!acc || acc.status !== 'active') {
      return reply.code(400).send({ error: '12306 未登录，请先点击顶部「连接 12306」扫码登录' });
    }

    // 节流：间隔内的请求返回缓存（防止前端/异常情况打爆 12306）
    const now = Date.now();
    const hit = cache.get(user.id);
    if (hit && now - hit.ts < ORDER_MIN_INTERVAL_MS) {
      repairTaskResults(user.id, hit.rows);
      return { orders: hit.rows, fetchedAt: hit.ts, cached: true };
    }

    try {
      const ctx = await getContext(user.id);
      const rows = await queryOrders(ctx);
      repairTaskResults(user.id, rows);
      cache.set(user.id, { ts: now, rows });
      logger.info('已购票查询成功', { by: user.username, count: rows.length, unpaid: rows.filter((r) => r.status === 'unpaid').length });
      return { orders: rows, fetchedAt: now, cached: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('已购票查询失败', { by: user.username, error: msg });
      // 失败时若有旧缓存，降级返回（标注过期时间），避免页面空白
      if (hit) return { orders: hit.rows, fetchedAt: hit.ts, cached: true, stale: true, error: msg };
      return reply.code(400).send({ error: msg });
    }
  });

  /** 退已支付车票，或取消待支付订单。换乘可只退选中的程。 */
  app.post('/api/orders/refund', async (request, reply) => {
    const user = currentUser(request);
    const parsed = z.object({
      legs: z.array(z.object({
        orderNo: z.string().min(1),
        trainCode: z.string().min(1),
        fromStation: z.string().min(1),
        toStation: z.string().min(1),
      })).min(1).max(3),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请选择要退的行程' });
    const acc = RailwayAccountRepo.get(user.id);
    if (!acc || acc.status !== 'active') return reply.code(400).send({ error: '12306 未登录' });
    try {
      await withUserLock(user.id, async () => {
        const ctx = await getContext(user.id);
        const rows = await queryOrders(ctx);
        const wanted = parsed.data.legs;
        const hits = rows.filter((row) => row.status !== 'refunded' && wanted.some((leg) =>
          leg.orderNo === row.orderNo && leg.trainCode === row.trainCode && leg.fromStation === row.fromStation && leg.toStation === row.toStation));
        if (hits.length !== wanted.length) throw new RefundRejected('有车票已变化，请刷新后再退');
        const tickets = hits.flatMap((row) => row.refundTickets.map((ticket) => ({ ...ticket, orderNo: row.orderNo, unpaid: row.status === 'unpaid' })));
        if (!tickets.length) throw new RefundRejected('没有可退的车票');
        const page = await ctx.newPage();
        try {
          await warmOrderPage(page);
          await refundTickets(page, tickets);
        } finally {
          await page.close().catch(() => undefined);
        }
        cache.delete(user.id);
      });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('退票失败', { by: user.username, error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  /** 智能改签只给出可买方案。新票支付成功前不退旧票。 */
  app.post('/api/orders/change-options', async (request, reply) => {
    const user = currentUser(request);
    const parsed = z.object({
      mode: z.enum(['to-direct', 'to-transfer']),
      fromStation: z.string().trim().min(1),
      toStation: z.string().trim().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      departTime: z.string().regex(/^\d{2}:\d{2}$/),
      currentTrains: z.array(z.string()).max(3),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '改签查询条件不完整' });
    const acc = RailwayAccountRepo.get(user.id);
    if (!acc || acc.status !== 'active') return reply.code(400).send({ error: '12306 未登录' });
    try {
      const options = await withUserLock(user.id, async () => {
        const ctx = await getContext(user.id);
        const query = { trainDate: parsed.data.date, fromStation: parsed.data.fromStation, toStation: parsed.data.toStation };
        const trains = parsed.data.mode === 'to-direct' ? await queryTrains(ctx, query) : [];
        const schemes = parsed.data.mode === 'to-transfer' ? await queryTransfers(ctx, query) : [];
        return rankChangeOptions({ ...parsed.data, trains, schemes });
      });
      return { options };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: msg });
    }
  });

  done();
};
