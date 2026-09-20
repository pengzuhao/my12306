/**
 * 购票计划与乘车人路由（需求 2）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { PassengersRepo, PlansRepo, PlanDatesRepo, TasksRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { previewForPlan } from '../plans/date-engine.js';
import { ensureYears, isWorkday, holidayName } from '../calendar/holidays.js';
import { Logger } from '../logger.js';
import { nanoid } from 'nanoid';

const logger = new Logger('plan');

const passengerSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  idTypeCode: z.string().default('1'),
  idNo: z.string().min(1),
  phone: z.string().optional(),
  passengerType: z.string().default('成人'),
});

const planSchema = z.object({
  name: z.string().min(1).max(64),
  fromStation: z.string().min(1),
  toStation: z.string().min(1),
  dateMode: z.enum(['single', 'recurring', 'workweek']),
  travelDate: z.string().nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  weekEdge: z.enum(['start', 'end']).nullable().optional(),
  weekInterval: z.number().int().min(1).max(4).default(1),
  offsetDays: z.number().int().min(-6).max(6).default(0),
  validFrom: z.string(),
  validUntil: z.string().nullable().optional(),
  timeFrom: z.string().nullable().optional(),
  timeTo: z.string().nullable().optional(),
  trainNumbers: z.array(z.string()).nullable().optional(),
  seatPositions: z.array(z.enum(['A', 'B', 'C', 'D', 'F'])).min(1, '请至少选择一个座位席别'),
  allowNoSeat: z.boolean().default(false),
  passengerIds: z.array(z.string()).min(1),
});

export const planRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 乘车人列表 */
  app.get('/api/passengers', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    return PassengersRepo.list(user.id);
  });

  /** 新增/更新乘车人 */
  app.post('/api/passengers', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const parsed = passengerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    return PassengersRepo.upsert(user.id, { ...parsed.data, source: 'manual', phone: parsed.data.phone ?? null });
  });

  app.delete('/api/passengers/:id', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    PassengersRepo.delete(id);
    return { ok: true };
  });

  /** 计划列表 */
  app.get('/api/plans', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    return PlansRepo.list(user.id);
  });

  /** 新建/更新计划 */
  app.post('/api/plans', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    const body = parsed.data;
    // 校验：single 必须有 travelDate；recurring 必须有 weekday；workweek 必须选工作周开始/结束
    if (body.dateMode === 'single' && !body.travelDate) {
      return reply.code(400).send({ error: '单次模式必须指定具体乘车日期' });
    }
    if (body.dateMode === 'recurring' && !body.weekday) {
      return reply.code(400).send({ error: '周期模式必须指定周几' });
    }
    if (body.dateMode === 'workweek' && !body.weekEdge) {
      return reply.code(400).send({ error: '工作周模式必须选择工作周开始或工作周结束' });
    }
    const id = (request.body as { id?: string })?.id ?? nanoid();
    const plan = PlansRepo.save({
      id,
      userId: user.id,
      name: body.name,
      status: 'active',
      fromStation: body.fromStation,
      toStation: body.toStation,
      dateMode: body.dateMode,
      travelDate: body.travelDate ?? null,
      weekday: body.weekday ?? null,
      weekEdge: body.weekEdge ?? null,
      weekInterval: body.weekInterval,
      offsetDays: body.offsetDays,
      validFrom: body.validFrom,
      validUntil: body.validUntil ?? null,
      timeFrom: body.timeFrom ?? null,
      timeTo: body.timeTo ?? null,
      trainNumbers: body.trainNumbers ?? null,
      seatPositions: body.seatPositions ?? null,
      allowNoSeat: body.allowNoSeat,
      passengerIds: body.passengerIds,
    });
    logger.info('保存计划', { planId: plan.id, name: plan.name, by: user.username });
    return plan;
  });

  /** 暂停/恢复/删除计划 */
  app.post('/api/plans/:id/status', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const { status } = z.object({ status: z.enum(['active', 'paused', 'deleted']) }).parse(request.body);
    const plan = PlansRepo.get(id);
    if (!plan || plan.userId !== user.id) return reply.code(404).send({ error: '计划不存在' });
    PlansRepo.setStatus(id, status);
    return { ok: true };
  });

  /**
   * 日期推算预览（需求 2）：给出具体购票日期列表，顺延的额外标注。
   * 支持不存库直接预览（新建计划前先看推算结果）。
   */
  app.post('/api/plans/preview-dates', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    const body = parsed.data;
    // 预估起售日期 = 乘车日期 - 预售期（精确起售时刻由起售查询接口确定）
    const entries = await previewForPlan({
      dateMode: body.dateMode,
      travelDate: body.travelDate ?? null,
      weekday: body.weekday ?? null,
      weekEdge: body.weekEdge ?? null,
      weekInterval: body.weekInterval,
      offsetDays: body.offsetDays,
      validFrom: body.validFrom,
      validUntil: body.validUntil ?? null,
    });
    return entries;
  });

  /** 已保存计划的推算日期 + 关联任务状态 */
  app.get('/api/plans/:id/dates', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const plan = PlansRepo.get(id);
    if (!plan || plan.userId !== user.id) return reply.code(404).send({ error: '计划不存在' });
    const entries = await previewForPlan(plan);
    const tasks = TasksRepo.list(user.id, 200);
    return entries.map((e) => {
      const task = tasks.find((t) => t.travelDate === e.travelDate);
      return { ...e, task: task ?? null };
    });
  });

  /** 站点搜索（下拉提示） */
  app.get('/api/stations', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { keyword } = request.query as { keyword?: string };
    if (!keyword) return [];
    const { searchStations } = await import('../bot/stations.js');
    return searchStations(keyword, 12);
  });

  /**
   * 节假日日历：给定年月，返回该月每天的节假日信息（供前端日历标记）。
   * 节假日数据可能跨年（如 10 月含国庆），自动加载相邻年份。
   */
  app.get('/api/calendar/holidays', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { year, month } = request.query as { year?: string; month?: string };
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      return reply.code(400).send({ error: 'year/month 参数无效' });
    }
    await ensureYears([y - 1, y, y + 1]);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out: Array<{ date: string; isWorkday: boolean; holiday: string | null }> = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ date: dateStr, isWorkday: isWorkday(dateStr), holiday: holidayName(dateStr) });
    }
    return out;
  });

  done();
};
