/**
 * 购票调度器（需求 5 + 用户强调的及时性）。
 *
 * 核心原则：**在车票起售时刻触发购买，而不是按出发时间**。
 *
 * 状态机：
 *   pending（已推算日期，待查起售时间）
 *     → queried（已知起售时间 saleAt，等待到点）
 *     → queued（进入秒级触发队列）
 *     → running（机器人执行中，含失败退避重试）
 *     → success / failed / cancelled
 *
 * 三个定时任务：
 *   A. 计划扫描（每 5 分钟）：为活跃计划生成未来任务，推算日期入库
 *   B. 起售查询（每 1 分钟）：为 pending 任务提前查询起售时间（预售期内才能查到）
 *   C. 到点触发（每 1 秒）：saleAt <= now 且状态 queried 的任务立即执行
 */
import { PlansRepo, PlanDatesRepo, TasksRepo, PassengersRepo, RailwayAccountRepo } from '../db/repo.js';
import { computeDates } from '../plans/date-engine.js';
import { Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import { today, addDays } from '../calendar/holidays.js';
import { getContext, getSessionState } from '../bot/session.js';
import { purchaseTicket } from '../bot/order.js';
import { querySaleTime } from '../bot/tickets.js';
import { queryPurchasedTickets } from '../bot/reconcile.js';
import { notifyOrderSuccess, notifyTaskFailed } from '../notify/feishu.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import type { Plan, Task } from '../types.js';

const logger = new Logger('scheduler');

/** 单个任务的最大重试次数 */
const MAX_ATTEMPTS = 3;

/** 对账节流：同一用户至少间隔 N 分钟才全量查一次订单，避免每秒触发都打接口 */
const RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastReconcileAt = new Map<string, number>();

/** 任务 → 互斥锁，避免同一任务并发执行 */
const runningLocks = new Set<string>();

/** 计划扫描：生成未来任务 */
async function scanPlans(): Promise<void> {
  const plans = PlansRepo.listActive();
  for (const plan of plans) {
    try {
      const entries = await computeDates({
        dateMode: plan.dateMode,
        travelDate: plan.travelDate,
        weekday: plan.weekday,
        weekInterval: plan.weekInterval,
        validFrom: plan.validFrom,
        validUntil: plan.validUntil,
      });
      PlanDatesRepo.replaceForPlan(plan.id, entries.map((e) => ({ travelDate: e.travelDate, originalDate: e.originalDate, postponed: e.postponed, weekday: e.weekday })));

      for (const e of entries) {
        // 只为"预售期内"的日期创建任务（太远的起售时间还查不到）
        const saleDateGuess = addDays(e.travelDate, -DEFAULT_PRESALE_DAYS);
        if (saleDateGuess > addDays(today(), 2)) continue; // 暂不为遥远日期建任务，等扫描推进
        const existing = TasksRepo.list(plan.userId, 200).find((t) => t.planId === plan.id && t.travelDate === e.travelDate);
        if (existing) continue;
        const pd = PlanDatesRepo.list(plan.id).find((d) => d.travelDate === e.travelDate);
        TasksRepo.create({
          planId: plan.id,
          planDateId: pd?.id ?? null,
          userId: plan.userId,
          travelDate: e.travelDate,
          trainNumber: plan.trainNumbers?.[0] ?? null,
          saleAt: null,
        });
        logger.info('已创建购票任务', { plan: plan.name, travelDate: e.travelDate, postponed: e.postponed });
      }
    } catch (e) {
      logger.error('计划扫描失败', { plan: plan.name, error: e });
    }
  }
}

/** 起售时间查询：pending → queried */
async function resolveSaleTimes(): Promise<void> {
  const pending = TasksRepo.listPending(50);
  for (const task of pending) {
    if (!task.trainNumber) {
      // 无指定车次：先标 queried，saleAt 用预售期推算值（触发时再实时选车次）
      const est = `${addDays(task.travelDate, -DEFAULT_PRESALE_DAYS)}T08:00:00+08:00`;
      TasksRepo.update(task.id, { status: 'queried', saleAt: est });
      logger.info('任务待触发（按预售期推算起售）', { taskId: task.id, saleAt: est });
      continue;
    }
    const plan = PlansRepo.get(task.planId);
    if (!plan) continue;
    const acc = RailwayAccountRepo.get(task.userId);
    if (!acc || acc.status !== 'active') continue; // 未登录不查
    try {
      const ctx = await getContext(task.userId);
      const page = await ctx.newPage();
      try {
        const { saleAt, source } = await querySaleTime(page, {
          trainDate: task.travelDate,
          trainCode: task.trainNumber,
          fromStation: plan.fromStation,
          toStation: plan.toStation,
        });
        TasksRepo.update(task.id, { status: 'queried', saleAt });
        logger.info('起售时间已确定', { taskId: task.id, saleAt, source });
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (e) {
      logger.warn('起售时间查询失败', { taskId: task.id, error: e });
    }
  }
}

/** 到点触发：queried → running → success/failed（先对账再执行，起售窗口仍完整留给购票） */
async function triggerDueTasks(): Promise<void> {
  const nowIso = new Date().toISOString();
  const due = TasksRepo.listDue(nowIso, 10);
  // 只在"确有到点任务"时对账一次：没有待执行任务时跑全量对账纯属浪费
  if (due.length) {
    await reconcileBeforeSale().catch((e) => logger.warn('对账循环异常', e));
  }
  for (const task of due) {
    if (runningLocks.has(task.id)) continue;
    void runTask(task);
  }
}

/**
 * 起售前对账（需求：预购车票含已支付和未支付的；未支付最终没付要回滚为未完成）。
 *
 * 扫描所有 active 计划中 status='done' 且乘车日未过去的记录，查 12306 实际订单：
 *  - 仍在未完成/已完成订单里 → 保持 done
 *  - 两边都查不到（未支付订单已超时取消且未补票）→ 回滚 pending，并把关联的
 *    success 任务重置为 queried，让触发器在起售时刻重新执行购票。
 *
 * 在 triggerDueTasks 之前、同一次触发循环里执行：到点任务先对账再执行，
 * 起售时间窗仍完整留给购票（对账只对"已标记完成"的日期动手，没占额外窗口）。
 */
async function reconcileBeforeSale(): Promise<void> {
  const todayStr = today();
  const plans = PlansRepo.listActive();
  for (const plan of plans) {
    const acc = RailwayAccountRepo.get(plan.userId);
    if (!acc || acc.status !== 'active') continue;
    // 用户级节流：10 分钟内已对账过则跳过（真到起售那一刻若有任务，triggerDueTasks 会再触发一轮）
    const last = lastReconcileAt.get(plan.userId) ?? 0;
    if (Date.now() - last < RECONCILE_MIN_INTERVAL_MS) continue;
    const dates = PlanDatesRepo.list(plan.id).filter((d) => d.status === 'done' && d.travelDate >= todayStr);
    if (!dates.length) continue;
    lastReconcileAt.set(plan.userId, Date.now());
    let ctx;
    try {
      ctx = await getContext(plan.userId);
    } catch (e) {
      logger.warn('对账：浏览器上下文获取失败', { plan: plan.name, error: e });
      continue;
    }
    const purchased = await queryPurchasedTickets(ctx);
    if (!purchased) {
      logger.warn('对账：订单查询全部失败，跳过本轮', { plan: plan.name });
      continue;
    }
    for (const d of dates) {
      const hit = findByDateAndAnyCode(purchased, d.travelDate);
      if (hit) continue; // 票还在（未支付或已支付），保持 done
      // 回滚：票没了（未支付已超时取消），标记未完成并重置任务等待重新执行
      PlanDatesRepo.markPending(plan.id, d.travelDate);
      const tasks = TasksRepo.findByPlanDate(plan.id, d.travelDate);
      for (const t of tasks) {
        if (t.status === 'success') {
          // 保留 saleAt（起售时刻不变）；重置为 queried 后触发器会重新执行
          TasksRepo.update(t.id, { status: 'queried', result: null, error: '对账回滚：未支付订单已失效，重新执行', finishedAt: null });
          logger.info('对账回滚：重新等待执行', { taskId: t.id, plan: plan.name, travelDate: d.travelDate, saleAt: t.saleAt });
        }
      }
      logger.info('对账回滚：当日车票已失效', { plan: plan.name, travelDate: d.travelDate });
    }
  }
}

/** 已购集合里是否存在该日期的任一车次（查重/对账用，车次未指定时按日期匹配） */
function findByDateAndAnyCode(purchased: Map<string, { orderNo: string; status: string }>, travelDate: string): boolean {
  const prefix = `${travelDate.replace(/\D/g, '')}|`;
  for (const key of purchased.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** 执行单个购票任务（含退避重试） */
async function runTask(task: Task): Promise<void> {
  runningLocks.add(task.id);
  const plan = PlansRepo.get(task.planId);
  try {
    // 过期计划：乘车日期已过（车已开），再下单毫无意义，直接作废不执行
    if (task.travelDate < today()) {
      TasksRepo.update(task.id, {
        status: 'cancelled',
        error: '乘车日期已过，视为过期计划，未执行',
        finishedAt: new Date().toISOString(),
      });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      logger.info('任务已过期，跳过执行', { taskId: task.id, travelDate: task.travelDate });
      return;
    }
    TasksRepo.update(task.id, { status: 'running', startedAt: new Date().toISOString(), attempts: task.attempts + 1 });
    wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });

    const acc = RailwayAccountRepo.get(task.userId);
    if (!acc || acc.status !== 'active') {
      throw new Error('12306 会话不可用，请重新登录');
    }
    if (!plan) throw new Error('计划不存在');

    const passengers = PassengersRepo.list(task.userId).filter((p) => plan.passengerIds.includes(p.id));
    if (!passengers.length) throw new Error('未选择乘车人');

    const ctx = await getContext(task.userId);
    logger.info('触发购票（起售时刻）', { taskId: task.id, train: task.trainNumber, travelDate: task.travelDate });

    const result = await purchaseTicket(ctx, {
      trainDate: task.travelDate,
      fromStation: plan.fromStation,
      toStation: plan.toStation,
      trainNumbers: plan.trainNumbers,
      timeFrom: plan.timeFrom,
      timeTo: plan.timeTo,
      seatPositions: plan.seatPositions,
      passengers,
    });

    if (result.ok) {
      TasksRepo.update(task.id, {
        status: 'success',
        result: { ...result },
        trainNumber: result.trainCode,
        finishedAt: new Date().toISOString(),
      });
      if (result.duplicated) {
        // 查重命中（已购同车次）：标记当日计划完成即可，未实际下单，不触发付款提醒
        PlanDatesRepo.markDone(plan.id, task.travelDate);
        logger.info('已购同车次，标记当日计划完成', { taskId: task.id, train: result.trainCode, orderNo: result.orderNo });
      } else {
        // 需求 5：成功不付款，飞书提醒用户付款
        await notifyOrderSuccess({
          userId: task.userId,
          planName: plan.name,
          trainNumber: result.trainCode,
          travelDate: task.travelDate,
          passengers: result.passengers,
          seatInfo: result.seatInfo,
          payDeadline: result.payDeadline,
        });
        logger.info('购票成功，已提醒用户付款', { taskId: task.id, orderNo: result.orderNo });
      }
    } else {
      // 失败退避重试
      const nextAttempt = task.attempts + 1;
      if (nextAttempt < MAX_ATTEMPTS) {
        const retryAt = new Date(Date.now() + 20 * 1000 * 2 ** (nextAttempt - 1)).toISOString();
        TasksRepo.update(task.id, { status: 'queried', saleAt: retryAt, error: result.error, finishedAt: new Date().toISOString() });
        logger.warn('购票失败，安排重试', { taskId: task.id, error: result.error, retryAt });
      } else {
        TasksRepo.update(task.id, { status: 'failed', error: result.error, finishedAt: new Date().toISOString() });
        await notifyTaskFailed({ userId: task.userId, planName: plan.name, travelDate: task.travelDate, error: result.error ?? '未知错误' });
      }
    }
    wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    TasksRepo.update(task.id, { status: 'failed', error: msg, finishedAt: new Date().toISOString() });
    logger.error('任务执行异常', { taskId: task.id, error: e });
    if (plan) {
      await notifyTaskFailed({ userId: task.userId, planName: plan.name, travelDate: task.travelDate, error: msg }).catch(() => undefined);
    }
  } finally {
    runningLocks.delete(task.id);
    void getSessionState(task.userId);
  }
}

let scanTimer: NodeJS.Timeout | null = null;
let saleTimer: NodeJS.Timeout | null = null;
let triggerTimer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (scanTimer) return;
  // 首次立即执行一次
  void scanPlans().then(() => void resolveSaleTimes());
  scanTimer = setInterval(() => void scanPlans(), 5 * 60 * 1000);
  saleTimer = setInterval(() => void resolveSaleTimes(), 60 * 1000);
  // 秒级触发：确保在起售时刻第一时间购票
  triggerTimer = setInterval(() => void triggerDueTasks(), 1000);
  logger.info('调度器已启动（计划扫描 5 分钟 / 起售查询 1 分钟 / 触发器 1 秒）');
}

export function stopScheduler(): void {
  for (const t of [scanTimer, saleTimer, triggerTimer]) {
    if (t) clearInterval(t);
  }
  scanTimer = saleTimer = triggerTimer = null;
}
