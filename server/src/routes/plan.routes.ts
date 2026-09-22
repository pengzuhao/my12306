/**
 * 购票计划与乘车人路由（需求 2）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { PassengersRepo, PlansRepo, PlanDatesRepo, TasksRepo, RailwayAccountRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { previewForPlan } from '../plans/date-engine.js';
import { ensureYears, isWorkday, holidayName, addDays, isYearDegraded, today } from '../calendar/holidays.js';
import { Logger } from '../logger.js';
import { nanoid } from 'nanoid';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import { wsHub } from '../ws/hub.js';
import { SEAT_NAMES } from '../bot/constants.js';
import { trainQueryErrorMessage } from '../bot/train-query-error.js';

const logger = new Logger('plan');

const passengerSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  idTypeCode: z.string().default('1'),
  idNo: z.string().min(1),
  phone: z.string().optional(),
  passengerType: z.string().default('成人'),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine((value) => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '日期无效');
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm');
const dateFields = {
  dateMode: z.enum(['single', 'recurring', 'workweek']),
  travelDate: dateSchema.nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  weekEdge: z.enum(['start', 'end']).nullable().optional(),
  weekInterval: z.number().int().min(1).max(4).default(1),
  offsetDays: z.number().int().min(-6).max(6).default(0),
  validFrom: dateSchema,
  validUntil: dateSchema.nullable().optional(),
  timeFrom: timeSchema.nullable().optional(),
  timeTo: timeSchema.nullable().optional(),
};
const dateRuleSchema = z.object(dateFields);
type DateInput = z.infer<typeof dateRuleSchema>;
function validateDates(body: DateInput, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (body.dateMode === 'single' && !body.travelDate) issue('travelDate', '单次模式必须指定具体乘车日期');
  if (body.dateMode === 'single' && body.travelDate && body.travelDate < today()) issue('travelDate', '乘车日期不能早于今天');
  if (body.dateMode === 'recurring' && !body.weekday) issue('weekday', '周期模式必须指定周几');
  if (body.dateMode === 'workweek' && !body.weekEdge) issue('weekEdge', '工作周模式必须选择工作周开始或工作周结束');
  if (body.dateMode !== 'single' && body.validUntil && body.validUntil < body.validFrom) issue('validUntil', '结束日期不能早于开始日期');
  if (body.timeFrom && body.timeTo && body.timeFrom > body.timeTo) issue('timeTo', '出发时间段的结束时间不能早于开始时间');
}
const previewSchema = dateRuleSchema.superRefine(validateDates);
const planSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, '请填写计划名称').max(64),
  fromStation: z.string().trim().min(1, '请填写出发站'),
  toStation: z.string().trim().min(1, '请填写到达站'),
  ...dateFields,
  trainNumbers: z.array(z.string()).nullable().optional(),
  trainSegments: z.array(z.object({ trainCode: z.string().trim().min(1), fromStation: z.string().trim().min(1), toStation: z.string().trim().min(1) })).default([]),
  seatPositions: z.array(z.enum(['A', 'B', 'C', 'D', 'F'])).nullable().default([]),
  /** 席别（必选多选）：订票时严格按所选席别匹配，不回退未选席别 */
  seatTypes: z.array(z.enum(['ZE', 'ZY', 'TZ', 'GR', 'RW', 'YW', 'RZ', 'YZ'])).min(1, '请至少选择一个席别'),
  allowNoSeat: z.boolean().default(false),
  passengerIds: z.array(z.string()).min(1, '请至少选择一名乘车人'),
}).superRefine((body, ctx) => {
  validateDates(body, ctx);
  if (body.fromStation === body.toStation) ctx.addIssue({ code: 'custom', path: ['toStation'], message: '出发站和到达站不能相同' });
});

export const planRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 乘车人列表 */
  app.get('/api/passengers', async (request) => {
    const user = currentUser(request);
    return PassengersRepo.list(user.id);
  });

  /** 新增/更新乘车人 */
  app.post('/api/passengers', async (request, reply) => {
    const user = currentUser(request);
    const parsed = passengerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误', detail: parsed.error.flatten() });
    if (parsed.data.id && !PassengersRepo.list(user.id).some(p => p.id === parsed.data.id)) return reply.code(404).send({ error: '乘车人不存在' });
    return PassengersRepo.upsert(user.id, { ...parsed.data, source: 'manual', phone: parsed.data.phone ?? null });
  });

  app.delete('/api/passengers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!PassengersRepo.list(currentUser(request).id).some(p => p.id === id)) return reply.code(404).send({ error: '乘车人不存在' });
    PassengersRepo.delete(id);
    return { ok: true };
  });

  /** 计划列表 */
  app.get('/api/plans', async (request) => {
    const user = currentUser(request);
    return PlansRepo.list(user.id);
  });

  /** 新建/更新计划 */
  app.post('/api/plans', async (request, reply) => {
    const user = currentUser(request);
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误', detail: parsed.error.flatten() });
    const body = parsed.data;
    const existing = body.id ? PlansRepo.get(body.id) : null;
    if (body.id && (!existing || existing.userId !== user.id || existing.status === 'deleted')) {
      return reply.code(404).send({ error: '计划不存在，请重新打开计划列表' });
    }
    const passengerIds = new Set(PassengersRepo.list(user.id).map((p) => p.id));
    if (body.passengerIds.some((id) => !passengerIds.has(id))) return reply.code(400).send({ error: '乘车人不存在，请重新同步并选择' });
    const id = body.id ?? nanoid();
    const plan = PlansRepo.save({
      id,
      userId: user.id,
      name: body.name,
      status: existing?.status ?? 'active',
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
      trainSegments: body.trainSegments.filter(segment => body.trainNumbers?.includes(segment.trainCode)),
      seatPositions: body.seatPositions ?? null,
      seatTypes: body.seatTypes,
      allowNoSeat: body.allowNoSeat,
      passengerIds: body.passengerIds,
    });
    logger.info('保存计划', { planId: plan.id, name: plan.name, by: user.username });
    return plan;
  });

  /** 暂停/恢复/删除计划 */
  app.post('/api/plans/:id/status', async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = z.object({ status: z.enum(['active', 'paused', 'deleted']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '计划状态无效' });
    const { status } = parsed.data;
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
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误', detail: parsed.error.flatten() });
    const body = parsed.data;
    // 预估起售日期 = 乘车日期 - 预售期（精确起售时刻由起售查询接口确定）
    // 节假日数据是工作周推算的前提，缺失时返回可读错误而不是 500
    try {
      const entries = await previewForPlan({
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
      });
      return entries;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('推算预览失败', { by: user.username, error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  /** 已保存计划的推算日期 + 关联任务状态 */
  app.get('/api/plans/:id/dates', async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const plan = PlansRepo.get(id);
    if (!plan || plan.userId !== user.id) return reply.code(404).send({ error: '计划不存在' });
    const tasks = TasksRepo.list(user.id, 200);

    // 1) 优先返回已持久化的推算结果（调度器每 5 分钟刷新入库）。
    //    详情展示的是"执行历史"，用库里的数据即可，不必每次实时推算——
    //    实时推算依赖节假日网络数据，缺年份时会抛错导致 500。
    const saved = PlanDatesRepo.list(id);
    if (saved.length) {
      return saved.map((d) => {
        const task = tasks.find((t) => t.planId === id && t.travelDate === d.travelDate) ?? null;
        return {
          travelDate: d.travelDate,
          originalDate: d.originalDate,
          weekday: d.weekday,
          postponed: d.postponed,
          isWorkday: isWorkday(d.travelDate),
          note: undefined,
          calendarPending: isYearDegraded(Number(d.travelDate.slice(0, 4))) || undefined,
          estimatedSaleDate: addDays(d.travelDate, -DEFAULT_PRESALE_DAYS),
          task,
        };
      });
    }

    // 2) 表为空（计划刚建、调度器还没扫描到）：实时推算兜底；失败也不 500，
    //    返回空列表让前端正常渲染，调度器扫描后自然有数据。
    try {
      const entries = await previewForPlan(plan);
      return entries.map((e) => {
        const task = tasks.find((t) => t.planId === id && t.travelDate === e.travelDate) ?? null;
        return { ...e, task };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('计划详情推算失败，返回空列表等调度器刷新', { plan: plan.name, error: msg });
      return [];
    }
  });

  /**
   * 手动重试失败/已跳过的任务（用户在管理台点「重试」）。
   *
   * 典型场景：购票因"12306 登录失效"失败后任务进入 failed，自动重试次数已用尽，
   * 用户重新扫码登录后需要一个人工触发入口——重置为 queried 后触发器 1 秒内重新执行。
   * saleAt 设为当前时间即"立即到期"，等价于马上跑。
   */
  app.post('/api/plans/:id/tasks/:taskId/retry', async (request, reply) => {
    const user = currentUser(request);
    const { id, taskId } = request.params as { id: string; taskId: string };
    const plan = PlansRepo.get(id);
    if (!plan || plan.userId !== user.id) return reply.code(404).send({ error: '计划不存在' });
    const task = TasksRepo.get(taskId);
    if (!task || task.planId !== id) return reply.code(404).send({ error: '任务不存在' });
    if (plan.status !== 'active') return reply.code(409).send({ error: '请先恢复计划后再重试' });
    if (!['failed', 'skipped'].includes(task.status)) return reply.code(409).send({ error: '只能重试失败或已跳过的任务' });
    if (task.travelDate < today()) return reply.code(400).send({ error: '乘车日期已过，无法重试' });

    TasksRepo.update(taskId, {
      status: 'queried',
      saleAt: new Date().toISOString(),
      result: null,
      error: null,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    });
    const updated = TasksRepo.get(taskId);
    wsHub.broadcastToUser(user.id, { type: 'task', payload: updated });
    logger.info('手动重试任务', { taskId, plan: plan.name, travelDate: task.travelDate });
    return updated;
  });

  /** 站点搜索（下拉提示） */
  app.get('/api/stations', async (request) => {
    const { keyword } = request.query as { keyword?: string };
    if (!keyword) return [];
    const { searchStations } = await import('../bot/stations.js');
    return searchStations(keyword, 12);
  });

  /**
   * 节假日日历：year 必填、month 可选。
   *  - 传 month：返回该月每天的节假日信息（兼容旧调用方）
   *  - 不传 month：返回该自然年全部 12 个月（供前端按年缓存，切月份时零延迟）
   * 节假日数据可能跨年（如 10 月含国庆），自动加载相邻年份。
   * 后端按自然年缓存（holidays.json 持久化 + 内存），只有首次查询某年才调外部接口。
   *
   * 返回体额外带 calendarPending：该年放假安排尚未发布（数据源拉取失败），
   * 工作日判定退回自然周兜底。前端据此提示"该年放假安排尚未公布"，
   * 数据就绪后调度器会自动重算，前端刷新即可看到更新。
   */
  app.get('/api/calendar/holidays', async (request, reply) => {
    const { year, month } = request.query as { year?: string; month?: string };
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      return reply.code(400).send({ error: 'year 参数无效' });
    }
    const m = month !== undefined && month !== '' ? Number(month) : null;
    if (m !== null && (!Number.isInteger(m) || m < 1 || m > 12)) {
      return reply.code(400).send({ error: 'month 参数无效' });
    }
    await ensureYears([y - 1, y, y + 1]);
    const months = m !== null ? [m] : Array.from({ length: 12 }, (_, i) => i + 1);
    const out: Array<{ date: string; isWorkday: boolean; holiday: string | null }> = [];
    for (const mm of months) {
      const daysInMonth = new Date(Date.UTC(y, mm, 0)).getUTCDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        out.push({ date: dateStr, isWorkday: isWorkday(dateStr), holiday: holidayName(dateStr) });
      }
    }
    return { days: out, calendarPending: isYearDegraded(y) };
  });

  /**
   * 席别选项（从 12306 透传，不写死在前端）。
   * 来源于余票查询接口的席别字段映射（SEAT_NAMES），
   * 12306 调整席别时只需改 constants.ts，前端自动同步。
   * 商务座不纳入可选：用户明确要求不买商务座，常规席别售罄即失败告警。
   */
  app.get('/api/meta/seat-types', async (request) => {
    return Object.entries(SEAT_NAMES)
      .filter(([code]) => code !== 'SWZ' && code !== 'WZ' && code !== 'QT')
      .map(([code, name]) => ({ code, name }));
  });

  /**
   * 查询实际可购车次（从 12306 透传，不写死车次列表）。
   * 需已登录 12306：用真实余票查询结果帮用户选车次，避免填错车次号。
   */
  app.get('/api/trains/search', async (request, reply) => {
    const user = currentUser(request);
    const { from, to, date } = request.query as { from?: string; to?: string; date?: string };
    if (!from || !to || !date) return reply.code(400).send({ error: '请提供出发站、到达站和乘车日期' });
    // 过去日期 12306 不卖票，查询必然失败——直接挡掉，给可读提示
    if (!dateSchema.safeParse(date).success) return reply.code(400).send({ error: '乘车日期无效，请使用 YYYY-MM-DD 格式' });
    if (from.trim() === to.trim()) return reply.code(400).send({ error: '出发站和到达站不能相同' });
    if (date < today()) return reply.code(400).send({ error: '不能查询过去日期的车次，请选择今天或以后的日期' });
    const lastDate = addDays(today(), DEFAULT_PRESALE_DAYS);
    if (date > lastDate) return reply.code(400).send({ code: 'NOT_ON_SALE', error: `${date} 尚未开售，当前可查询至 ${lastDate}。可先保存计划，开售后自动查询。` });
    const acc = RailwayAccountRepo.get(user.id);
    if (!acc || acc.status !== 'active') {
      return reply.code(400).send({ error: '12306 未登录，请先在顶栏扫码登录后查询车次' });
    }
    try {
      const { getContext } = await import('../bot/session.js');
      const { queryTrains } = await import('../bot/tickets.js');
      const ctx = await getContext(user.id);
      const trains = await queryTrains(ctx, { trainDate: date, fromStation: from, toStation: to });
      return {
        trains: trains.map((t) => ({
          trainCode: t.trainCode,
          fromStation: t.fromStation,
          toStation: t.toStation,
          departTime: t.departTime,
          arriveTime: t.arriveTime,
          duration: t.duration,
          /** 余票里出现的席别（透传给前端做选项，不写死） */
          seatTypes: Object.entries(SEAT_NAMES).filter(([, name]) => name in t.seats).map(([code]) => code),
          /** 各席别余票文本（车次查询页展示用） */
          seats: t.seats,
        })),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('车次查询失败', { by: user.username, from, to, date, error: msg });
      return reply.code(502).send({ error: trainQueryErrorMessage(e) });
    }
  });

  done();
};
