/**
 * 购票计划与乘车人路由（需求 2）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { PassengersRepo, PlansRepo, PlanDatesRepo, TasksRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { previewForPlan } from '../plans/date-engine.js';
import { ensureYears, isWorkday, holidayName, addDays } from '../calendar/holidays.js';
import { Logger } from '../logger.js';
import { nanoid } from 'nanoid';
import { DEFAULT_PRESALE_DAYS } from '../config.js';

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
  /** 席别（必选多选）：订票时严格按所选席别匹配，不回退未选席别 */
  seatTypes: z.array(z.enum(['ZE', 'ZY', 'TZ', 'GR', 'RW', 'YW', 'RZ', 'YZ'])).min(1, '请至少选择一个席别'),
  allowNoSeat: z.boolean().default(false),
  passengerIds: z.array(z.string()).min(1),
});

export const planRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 乘车人列表 */
  app.get('/api/passengers', async () => {
    const user = currentUser();
    return PassengersRepo.list(user.id);
  });

  /** 新增/更新乘车人 */
  app.post('/api/passengers', async (request, reply) => {
    const user = currentUser();
    const parsed = passengerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    return PassengersRepo.upsert(user.id, { ...parsed.data, source: 'manual', phone: parsed.data.phone ?? null });
  });

  app.delete('/api/passengers/:id', async (request) => {
    const { id } = request.params as { id: string };
    PassengersRepo.delete(id);
    return { ok: true };
  });

  /** 计划列表 */
  app.get('/api/plans', async () => {
    const user = currentUser();
    return PlansRepo.list(user.id);
  });

  /** 新建/更新计划 */
  app.post('/api/plans', async (request, reply) => {
    const user = currentUser();
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
      seatTypes: body.seatTypes,
      allowNoSeat: body.allowNoSeat,
      passengerIds: body.passengerIds,
    });
    logger.info('保存计划', { planId: plan.id, name: plan.name, by: user.username });
    return plan;
  });

  /** 暂停/恢复/删除计划 */
  app.post('/api/plans/:id/status', async (request, reply) => {
    const user = currentUser();
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
    const user = currentUser();
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
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
    const user = currentUser();
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
   */
  app.get('/api/calendar/holidays', async (request, reply) => {
    const { year, month } = request.query as { year?: string; month?: string };
    const y = Number(year);
    if (!Number.isInteger(y)) {
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
    return out;
  });

  done();
};
