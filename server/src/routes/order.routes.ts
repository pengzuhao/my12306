/**
 * 已购车票路由（需求：管理台「已购车票」主页面）。
 *
 * 页面会定时刷新，为防止请求过于频繁被 12306 封禁，服务端对同一用户做了
 * 最小间隔限制：ORDER_MIN_INTERVAL_MS 内的重复请求直接返回最近一次的缓存结果。
 * 前端另有更长的定时刷新间隔（5 分钟）和「支付截止时刻」的确定刷新节点。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { RailwayAccountRepo, TasksRepo, PlansRepo, PassengersRepo } from '../db/repo.js';
import { verifiedOrderResult } from '../bot/order-result.js';
import { currentUser } from './auth.routes.js';
import { getContext } from '../bot/session.js';
import { queryOrders, type OrderRow } from '../bot/orders.js';
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

  done();
};
