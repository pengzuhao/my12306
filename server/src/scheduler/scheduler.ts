import { userCanRun } from '../db/repo.js';
import { logContext } from '../logger.js';
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
 * success 之后的未支付订单由"支付到期闹钟"接管：
 *   success（未支付，带 payDeadlineTs）
 *     → 到点（payDeadline + 1 分钟）重查订单
 *     → 票已失效 → 回滚 plan_date 为 pending、任务重置为 queried 立即重订
 *     → 票仍在（仍未支付）→ 5 分钟后复检，最多 3 次，之后交给 10 分钟对账兜底
 *
 * 三个定时任务 + 一个到期闹钟：
 *   A. 计划扫描（每 5 分钟）：为活跃计划生成未来任务，推算日期入库
 *   B. 起售查询（每 1 分钟）：为 pending 任务提前查询起售时间（预售期内才能查到）
 *   C. 到点触发（每 1 秒）：saleAt <= now 且状态 queried 的任务立即执行
 *   D. 对账（每 10 分钟）：未支付订单失效后回滚重订，并作为到期闹钟的兜底
 */
import { PlansRepo, PlanDatesRepo, PlanDateSkipsRepo, TasksRepo, PassengersRepo, RailwayAccountRepo } from '../db/repo.js';
import { computeDates } from '../plans/date-engine.js';
import { Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import { today, addDays, isDateReady, onCalendarReady } from '../calendar/holidays.js';
import { getContext, getSessionState } from '../bot/session.js';
import { purchaseTicket } from '../bot/order.js';
import { findBlockingUnpaid } from '../bot/orders.js';
import { querySaleTime } from '../bot/tickets.js';
import { queryPurchasedTickets, type PurchasedTicket } from '../bot/reconcile.js';
import { notifyOrderSuccess, notifyTaskFailed, notifyDuplicatedOrder } from '../notify/feishu.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import type { Passenger, Plan, Task } from '../types.js';
import type { PurchaseResult } from '../bot/order.js';

const logger = new Logger('scheduler');

/** 单个任务的最大重试次数 */
const MAX_ATTEMPTS = 3;

/**
 * 未支付订单拦截时的延后策略（用户要求：有未支付订单就不要继续下个时间点的购票，
 * 直到用户支付或订单失效）。
 *
 * - 知道支付截止时间：等到截止后 1 分钟（给 12306 留出取消订单的缓冲）再重试
 * - 不知道截止时间：15 分钟后兜底重试
 * - 无论哪种，延后都不计重试次数、不发飞书告警——这不是失败，是"等待"
 */
const UNPAID_EXPIRY_BUFFER_MS = 60_000;
const UNPAID_RETRY_FALLBACK_MS = 15 * 60 * 1000;

/** 对账节流：同一用户至少间隔 N 分钟才全量查一次订单，避免每秒触发都打接口 */
const RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastReconcileAt = new Map<string, number>();

/**
 * 支付到期定时器（需求：到点刷新车票状态，失效则自动重订）。
 *
 * 任务成功且订单未支付时，按 12306 下发的支付截止时间（payDeadlineTs）
 * 定一个到点闹钟：到期后立即重查订单，票已失效则回滚 plan_date 并把任务
 * 重置为 queried，触发器 1 秒内重新下单。比被动等 10 分钟对账快得多
 * （抢票窗口里 10 分钟可能就没票了）。
 *
 * 防自激：到期时间已过去太久（超过 30 分钟）的视为陈旧数据，不设定闹钟，
 * 交给 10 分钟对账兜底——否则查重命中一个永不消失的影子订单会每 30 秒
 * 空转一轮（2026-09-20 的 EQ96319535 就是这类脏数据）。
 */
const PAY_DEADLINE_BUFFER_MS = 60_000; // 给 12306 留出取消订单的缓冲
const PAY_DEADLINE_MIN_DELAY_MS = 30_000; // 到期时间已过时，最短 30 秒后查一次
const PAY_DEADLINE_STALE_MS = 30 * 60_000; // 超过这个时间未支付视为陈旧，不设定闹钟
const PAY_DEADLINE_RECHECK_MS = 5 * 60_000; // 到期后票仍在，隔 5 分钟再查
const PAY_DEADLINE_MAX_RECHECKS = 3; // 最多复检 3 次，之后交给 10 分钟对账
const payDeadlineTimers = new Map<string, NodeJS.Timeout>();

function clearPayDeadlineTimer(taskId: string): void {
  const t = payDeadlineTimers.get(taskId);
  if (t) {
    clearTimeout(t);
    payDeadlineTimers.delete(taskId);
  }
}

/** 任务 → 互斥锁，避免同一任务并发执行 */
const runningLocks = new Set<string>();

/**
 * 用户级互斥锁：同一 12306 会话同一时刻只能跑一个浏览器流程（购票/对账）。
 *
 * 监控发现的关键问题：同一用户的多个任务并发执行时，它们共享同一个浏览器上下文
 * （同一份 cookie/UAM 状态），两个流程几乎同时做 UAM 预热、同时点"预订"按钮，
 * 互相踩踏导致"点击预订后未进入确认页"。任务级锁（runningLocks）管不到这件事，
 * 必须按用户串行。
 */
import { withUserLock } from '../bot/user-lock.js';

/**
 * 过期判断（用户要求：发车时间已过的任务应跳过，而不是执行后失败）。
 *
 * 乘车日期 < 今天 → 一定过期。
 * 乘车日期 == 今天 → 看发车时间：
 *   - 计划填写 timeTo 时，只有整个时间窗口结束后才过期。
 *   - 未指定时间上限时，由实时余票查询过滤已发车车次，不能按起售时间判定。
 */
export function isExpired(task: Task, plan: Plan | null | undefined): boolean {
  const t = task.travelDate;
  const todayStr = today();
  if (t < todayStr) return true;
  if (t > todayStr) return false;
  // 同日只在整个出发窗口结束后过期；起售时间不能用于推断发车时间。
  if (plan?.timeTo) return nowHmCn() > plan.timeTo;
  return false;
}

/** 过期原因（写入 task.error，详情页展示给用户看） */
function expiredReason(task: Task, plan: Plan | null | undefined): string {
  const t = task.travelDate;
  if (t < today()) return '乘车日期已过，跳过执行';
  if (plan?.timeTo) return `今日出发时间段已于 ${plan.timeTo} 结束，跳过执行`;
  return '列车已发车，跳过执行';
}

/** 当前北京时间 HH:mm（用于同日发车时间比较） */
function nowHmCn(): string {
  const d = new Date();
  const cn = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60_000);
  return `${String(cn.getHours()).padStart(2, '0')}:${String(cn.getMinutes()).padStart(2, '0')}`;
}

/** 计划扫描：生成未来任务 */
async function scanPlans(): Promise<void> {
  const plans = PlansRepo.listActive();
  for (const plan of plans) {
    try {
      const entries = await computeDates({
        dateMode: plan.dateMode,
        travelDate: plan.travelDate,
        weekday: plan.weekday,
        weekEdge: plan.weekEdge,
        weekInterval: plan.weekInterval,
        offsetDays: plan.offsetDays,
        validFrom: plan.validFrom,
        validUntil: plan.validUntil,
        timeFrom: plan.timeFrom,
        timeTo: plan.timeTo,
      });
      PlanDatesRepo.replaceForPlan(plan.id, entries.map((e) => ({ travelDate: e.travelDate, originalDate: e.originalDate, postponed: e.postponed, weekday: e.weekday })));

      for (const e of entries) {
        if (PlanDateSkipsRepo.has(plan.id, e.travelDate)) continue;
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
        logger.info('已创建购票任务', { userId: plan.userId, plan: plan.name, travelDate: e.travelDate, postponed: e.postponed });
      }
    } catch (e) {
      logger.error('计划扫描失败', { userId: plan.userId, plan: plan.name, error: e });
    }
  }
}

/** 起售时间查询：pending → queried */
async function resolveSaleTimes(): Promise<void> {
  const pending = TasksRepo.listPending(50);
  for (const task of pending) {
    if (PlanDateSkipsRepo.has(task.planId, task.travelDate) || TasksRepo.get(task.id)?.status !== 'pending') continue;
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
        const { saleAt, source } = await logContext.run(task.userId, () => querySaleTime(page, {
          trainDate: task.travelDate,
          trainCode: task.trainNumber!,
          fromStation: plan.fromStation,
          toStation: plan.toStation,
        }));
        if (PlanDateSkipsRepo.has(task.planId, task.travelDate) || TasksRepo.get(task.id)?.status !== 'pending') continue;
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
  for (const task of due) {
    if (runningLocks.has(task.id)) continue;
    void logContext.run(task.userId, () => runTask(task));
  }
}

/**
 * 订单对账（需求：预购车票含已支付和未支付的；未支付最终没付要回滚为未完成）。
 *
 * 扫描所有 active 计划中 status='done' 且乘车日未过去的记录，查 12306 实际订单：
 *  - 仍在未完成/已完成订单里 → 保持 done
 *  - 两边都查不到（未支付订单已超时取消且未补票）→ 回滚 pending，并把关联的
 *    success 任务重置为 queried，让触发器在起售时刻重新执行购票。
 *
 * 独立定时运行（每 10 分钟），不依赖"是否有到点任务"——否则任务全部成功后
 * 对账就再也不跑，未支付订单过期无人重买（2026-09-20 的实际故障）。
 * 起售时刻若有到点任务，下一轮对账在分钟级内自然执行，不占用宝贵的起售窗口。
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
    // 对账也走用户锁：不能和正在执行的购票流程共用同一会话，否则互相踩踏
    await withUserLock(plan.userId, async () => {
      let ctx;
      try {
        ctx = await getContext(plan.userId);
      } catch (e) {
        logger.warn('对账：浏览器上下文获取失败', { userId: plan.userId, plan: plan.name, error: e });
        return;
      }
      // 整轮对账包一层：订单预热/查询任何一步失败（如登录态失效被重定向到登录页）
      // 都不能让异常冒泡成 unhandled rejection 拖垮整个服务进程
      let purchased: Map<string, PurchasedTicket> | null;
      try {
        purchased = await queryPurchasedTickets(ctx);
      } catch (e) {
        logger.warn('对账：订单查询异常', { userId: plan.userId, plan: plan.name, error: e });
        return;
      }
      if (!purchased) {
        logger.warn('对账：订单查询不完整，跳过本轮', { plan: plan.name });
        return;
      }
      for (const d of dates) {
        if (PlanDateSkipsRepo.has(plan.id, d.travelDate)) continue;
        const hit = findByDateAndAnyCode(purchased, d.travelDate);
        if (hit) continue; // 票还在（未支付或已支付），保持 done
        // 回滚：票没了（未支付已超时取消），标记未完成并重置任务等待重新执行
        PlanDatesRepo.markPending(plan.id, d.travelDate);
        const tasks = TasksRepo.findByPlanDate(plan.id, d.travelDate);
        for (const t of tasks) {
          if (t.status === 'success') {
            // 保留 saleAt（起售时刻不变）；重置为 queried 后触发器会重新执行
            // 同时清掉可能挂着的支付到期闹钟（闹钟里会校验状态，但清掉更省一次空查）
            clearPayDeadlineTimer(t.id);
            TasksRepo.update(t.id, { status: 'queried', result: null, error: '对账回滚：未支付订单已失效，重新执行', finishedAt: null });
            logger.info('对账回滚：重新等待执行', { taskId: t.id, plan: plan.name, travelDate: d.travelDate, saleAt: t.saleAt });
          }
        }
        logger.info('对账回滚：当日车票已失效', { userId: plan.userId, plan: plan.name, travelDate: d.travelDate });
      }
    });
  }
}

/** 已购集合里是否存在该日期的任一车次（查重/对账用，车次未指定时按日期匹配） */
function findByDateAndAnyCode(purchased: Map<string, { orderNo: string; status: string }>, travelDate: string): boolean {
  // 对账集合统一使用 YYYYMMDD|车次，与票面时分无关
  const prefix = `${travelDate.replace(/\D/g, '').slice(0, 8)}|`;
  for (const key of purchased.keys()) {
    if (key.slice(0, prefix.length) === prefix) return true;
  }
  return false;
}

/** 已购集合里该日期的全部车票（支付到期检查用，需知道是否已支付） */
function entriesForDate(purchased: Map<string, PurchasedTicket>, travelDate: string): PurchasedTicket[] {
  const prefix = `${travelDate.replace(/\D/g, '').slice(0, 8)}|`;
  const out: PurchasedTicket[] = [];
  for (const [key, v] of purchased) {
    if (key.slice(0, prefix.length) === prefix) out.push(v);
  }
  return out;
}

/**
 * 支付到期闹钟：到点后重查订单，票已失效则回滚重订（用户需求：到期自动刷新 + 重订）。
 *
 * 触发时机 = payDeadlineTs + 60 秒缓冲（12306 取消订单有延迟，立刻查可能还在）。
 * 到点后票仍在且仍未支付：5 分钟后再查，最多 3 次，之后交给 10 分钟对账兜底。
 */
function schedulePayDeadlineCheck(task: Task, plan: Plan, payDeadlineTs: number): void {
  // 陈旧数据（到期时间已过去太久）不设定闹钟，交给对账兜底，避免空转自激
  if (payDeadlineTs + PAY_DEADLINE_STALE_MS < Date.now()) {
    logger.info('支付截止时间已过期较久，交给对账兜底，不设定闹钟', { taskId: task.id, travelDate: task.travelDate });
    return;
  }
  clearPayDeadlineTimer(task.id);
  const delay = Math.max(payDeadlineTs - Date.now() + PAY_DEADLINE_BUFFER_MS, PAY_DEADLINE_MIN_DELAY_MS);
  const timer = setTimeout(() => {
    payDeadlineTimers.delete(task.id);
    void onPayDeadlineReached(task, plan, 0);
  }, delay);
  payDeadlineTimers.set(task.id, timer);
  logger.info('已设定支付到期定时器', {
    taskId: task.id,
    travelDate: task.travelDate,
    fireAt: new Date(Date.now() + delay).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  });
}

/** 支付到期闹钟触发：重查订单，决定保持 done 还是回滚重订 */
async function onPayDeadlineReached(task: Task, plan: Plan, recheck: number): Promise<void> {
  if (!userCanRun(task.userId) || PlanDateSkipsRepo.has(task.planId, task.travelDate)) return;
  // 任务已不在 success（被对账回滚/取消/重跑过），闹钟作废
  const cur = TasksRepo.get(task.id);
  if (!cur || cur.status !== 'success') {
    logger.info('支付到期检查：任务已离开 success，跳过', { taskId: task.id, status: cur?.status ?? '不存在' });
    return;
  }
  const pd = PlanDatesRepo.list(plan.id).find((d) => d.travelDate === task.travelDate);
  if (!pd || pd.status !== 'done') {
    logger.info('支付到期检查：当日计划已不在 done，跳过', { taskId: task.id, travelDate: task.travelDate });
    return;
  }

  let purchased: Map<string, PurchasedTicket> | null = null;
  try {
    // 到期检查也走用户锁：和正在执行的购票/对账共用同一浏览器上下文，串行避免踩踏
    purchased = await withUserLock(plan.userId, async () => {
      const ctx = await getContext(plan.userId);
      return queryPurchasedTickets(ctx);
    });
  } catch (e) {
    logger.warn('支付到期检查：订单查询异常', { taskId: task.id, error: e });
  }
  if (!purchased) {
    // 查询失败也要重试，别让到点检查静默丢失（登录态失效等情况）
    if (recheck < PAY_DEADLINE_MAX_RECHECKS) {
      logger.warn('支付到期检查：查询失败，稍后重试', { taskId: task.id, recheck: recheck + 1 });
      const t = setTimeout(() => void onPayDeadlineReached(task, plan, recheck + 1), PAY_DEADLINE_RECHECK_MS);
      payDeadlineTimers.set(task.id, t);
    } else {
      logger.error('支付到期检查：连续查询失败，交给对账兜底', { taskId: task.id });
    }
    return;
  }

  const hits = entriesForDate(purchased, task.travelDate);
  if (hits.length) {
    // 票还在：用户可能已支付，或 12306 还没来得及取消未支付订单
    if (hits.every((h) => h.status === 'paid')) {
      logger.info('支付到期检查：用户已支付，保持完成', { taskId: task.id, travelDate: task.travelDate });
      return;
    }
    // 仍未支付：订单应该马上要被取消，隔几分钟再查
    if (recheck < PAY_DEADLINE_MAX_RECHECKS) {
      logger.info('支付到期检查：仍未支付，稍后复检', { taskId: task.id, travelDate: task.travelDate, recheck: recheck + 1 });
      const t = setTimeout(() => void onPayDeadlineReached(task, plan, recheck + 1), PAY_DEADLINE_RECHECK_MS);
      payDeadlineTimers.set(task.id, t);
    } else {
      logger.warn('支付到期检查：复检上限已到，交给对账兜底', { taskId: task.id, travelDate: task.travelDate });
    }
    return;
  }

  if (PlanDateSkipsRepo.has(plan.id, task.travelDate) || TasksRepo.get(task.id)?.status !== 'success') return;
  // 票没了：未支付订单已被 12306 取消且未补票 → 回滚重订
  PlanDatesRepo.markPending(plan.id, task.travelDate);
  TasksRepo.update(task.id, {
    status: 'queried',
    result: null,
    error: '支付到期：未支付订单已失效，重新执行',
    finishedAt: null,
  });
  wsHub.broadcastToUser(plan.userId, { type: 'task', payload: TasksRepo.get(task.id) });
  logger.info('支付到期：订单已失效，已回滚并安排立即重订', { taskId: task.id, plan: plan.name, travelDate: task.travelDate, saleAt: cur.saleAt });
}

/**
 * 锁内执行一次完整购票流程（查询 → 预热 → 点预订 → 确认页 → 提交）。
 *
 * 包一层即时重试：监控发现"点击预订后未进入确认页"这类瞬态失败很常见
 * （UAM 预热未生效 / 页面跳转慢），在仍持锁的情况下立刻重跑一次，
 * 比放开锁后走退避重试更可靠——避免重新排队时另一个任务插进来又踩踏。
 */
async function purchaseTicketWithRetry(task: Task, plan: Plan, passengers: Passenger[]): Promise<PurchaseResult> {
  const ctx = await getContext(task.userId);
  logger.info('触发购票（起售时刻）', { taskId: task.id, train: task.trainNumber, travelDate: task.travelDate });
  const params = {
    trainDate: task.travelDate,
    fromStation: plan.fromStation,
    toStation: plan.toStation,
    trainNumbers: plan.trainNumbers,
    trainSegments: plan.trainSegments,
    timeFrom: plan.timeFrom,
    timeTo: plan.timeTo,
    seatPositions: plan.seatPositions,
    seatTypes: plan.seatTypes,
    allowNoSeat: plan.allowNoSeat,
    passengers,
  };
  const first = await purchaseTicket(ctx, params);
  if (first.ok || !isTransientFailure(first.error)) return first;
  logger.warn('瞬态失败，持锁立即重试一次', { taskId: task.id, error: first.error });
  return purchaseTicket(ctx, params);
}

/** 可即时重试的瞬态失败：页面跳转/UAM 类错误（其余错误交给调用方退避重试）。
 *  注意"未完成订单/未支付订单被拦截"不算瞬态——重试前必须先由用户处理掉，立即重试纯属浪费。 */
function isTransientFailure(error?: string | null): boolean {
  if (!error) return false;
  if (error.includes('未完成订单') || error.includes('未支付订单')) return false;
  return error.includes('未进入确认页') || error.includes('UAM') || error.includes('超时');
}

/** 执行单个购票任务（含退避重试） */
async function runTask(task: Task): Promise<void> {
  if (!userCanRun(task.userId) || PlanDateSkipsRepo.has(task.planId, task.travelDate)) return;
  runningLocks.add(task.id);
  const plan = PlansRepo.get(task.planId);
  try {
    if (!plan || plan.status !== 'active' || PlanDateSkipsRepo.has(task.planId, task.travelDate)) return;
    // 乘车日期已过，或今天的整个出发时间窗口已经结束。
    if (isExpired(task, plan)) {
      const reason = expiredReason(task, plan);
      TasksRepo.update(task.id, {
        status: 'skipped',
        error: reason,
        finishedAt: new Date().toISOString(),
      });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      logger.info('任务已过期，跳过执行', { taskId: task.id, travelDate: task.travelDate, reason });
      return;
    }
    // 升级或修改规则后，数据库中可能仍有旧日期；执行前再按当前规则校验。
    const validDates = await computeDates(plan);
    if (!validDates.some(entry => entry.travelDate === task.travelDate)) {
      TasksRepo.update(task.id, { status: 'skipped', error: '计划日期已重新推算，该日期不再符合当前规则', finishedAt: new Date().toISOString() });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      return;
    }
    if (PlanDateSkipsRepo.has(task.planId, task.travelDate) || TasksRepo.get(task.id)?.status !== 'queried' || PlansRepo.get(plan.id)?.status !== 'active') return;
    TasksRepo.update(task.id, { status: 'queued', startedAt: null });
    wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });

    const acc = RailwayAccountRepo.get(task.userId);
    if (!acc || acc.status !== 'active') {
      throw new Error('12306 会话不可用，请重新登录');
    }
    if (!plan) throw new Error('计划不存在');

    // 执行前提：任务涉及的年份节假日数据必须已确认。工作周模式完全依赖它
    // 推算工作日，数据缺失意味着推算结果可能错误（把放假当天当工作日）。
    // 此时不应继续购票——等 scanPlans 下次重试把数据拉回来再说。
    if (!isDateReady(task.travelDate)) {
      const missingYear = Number(task.travelDate.slice(0, 4));
      TasksRepo.update(task.id, {
        status: 'queried',
        saleAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        error: `${missingYear} 年节假日数据未就绪，5 分钟后自动重试`,
        finishedAt: new Date().toISOString(),
      });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      logger.warn('节假日数据未就绪，延后执行', { taskId: task.id, travelDate: task.travelDate });
      return;
    }

    const passengers = PassengersRepo.list(task.userId).filter((p) => plan.passengerIds.includes(p.id));
    if (!passengers.length) throw new Error('未选择乘车人');

    // 用户要求：存在未支付订单时，不要继续下个时间点的购票，直到支付或订单失效。
    // 这不是失败——不计重试次数、不发飞书，只是把任务推到"订单失效后"再执行。
    // 12306 一个账户同时只允许一个未支付订单，现在下单必然被拦截，跑了也白跑。
    //
    // 预检和购票同在用户锁内：两者共用同一浏览器上下文，不锁起来会和并发的
    // 对账/其他任务互相踩踏（曾经导致"点击预订后未进入确认页"）。
    const result = await withUserLock(task.userId, async () => {
      if (PlanDateSkipsRepo.has(task.planId, task.travelDate) || TasksRepo.get(task.id)?.status !== 'queued') return null;
      if (!userCanRun(task.userId) || PlansRepo.get(task.planId)?.status !== 'active') {
        TasksRepo.update(task.id, { status: 'queried', startedAt: null });
        return null;
      }
      TasksRepo.update(task.id, { status: 'running', startedAt: new Date().toISOString(), attempts: task.attempts + 1 });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      const ctx = await getContext(task.userId);
      const block = await findBlockingUnpaid(ctx, task.travelDate, task.trainNumber);
      if (!block) return purchaseTicketWithRetry(task, plan, passengers);
      const waitMs = block.payLimitTs
        ? block.payLimitTs - Date.now() + UNPAID_EXPIRY_BUFFER_MS
        : UNPAID_RETRY_FALLBACK_MS;
      const retryAt = new Date(Date.now() + Math.max(waitMs, 60_000)).toISOString();
      TasksRepo.update(task.id, { status: 'queried', attempts: task.attempts, saleAt: retryAt, error: `等待未支付订单 ${block.orderNo}（${block.describe}）处理后再试`, finishedAt: new Date().toISOString() });
      wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
      logger.info('存在未支付订单，延后购票', { taskId: task.id, blockingOrder: block.orderNo, describe: block.describe, retryAt });
      return null;
    });
    if (!result) return;

    if (result.ok) {
      TasksRepo.update(task.id, {
        status: 'success',
        result: { ...result },
        trainNumber: result.trainCode,
        finishedAt: new Date().toISOString(),
      });
      // 无论真实下单还是查重命中，都标记当日计划完成：
      // 对账回滚只扫描 status='done' 的记录，漏标会导致"未支付订单超时取消后不自动重买"
      PlanDatesRepo.markDone(plan.id, task.travelDate);
      if (result.duplicated) {
        // 查重命中（已购同车次）：未实际下单。未支付的同样要提醒用户付款，
        // 否则用户根本不知道名下还有未支付订单（2026-09-20 的 EQ96319535 就是这么被静默标记成功的）
        logger.info('已购同车次，标记当日计划完成', { taskId: task.id, train: result.trainCode, orderNo: result.orderNo, paid: result.paid });
        const notify = await notifyDuplicatedOrder({
          userId: task.userId,
          planName: plan.name,
          trainNumber: result.trainCode,
          travelDate: task.travelDate,
          passengers: result.passengers,
          orderNo: result.orderNo,
          paid: Boolean(result.paid),
          payDeadline: result.payDeadline,
        });
        if (!notify.ok) logger.warn('查重命中但通知失败', { taskId: task.id, orderNo: result.orderNo, error: notify.error });
      } else {
        // 需求 5：成功不付款，消息提醒用户付款
        const notify = await notifyOrderSuccess({
          userId: task.userId,
          planName: plan.name,
          trainNumber: result.trainCode,
          travelDate: task.travelDate,
          passengers: result.passengers,
          seatInfo: result.seatInfo,
          payDeadline: result.payDeadline,
        });
        if (notify.ok) {
          logger.info('购票成功，已提醒用户付款', { taskId: task.id, orderNo: result.orderNo });
        } else {
          // 通知失败必须留痕：用户收不到提醒就不知道要付款，订单会超时取消
          logger.error('购票成功但通知失败', { taskId: task.id, orderNo: result.orderNo, error: notify.error });
        }
      }
      // 未支付订单（无论真实下单还是查重命中）：按支付截止时间定到点闹钟，
      // 到期后自动重查，票已失效就回滚重订（用户需求：支付到期定时器 + 自动重订）
      if (result.payDeadlineTs) {
        schedulePayDeadlineCheck(task, plan, result.payDeadlineTs);
      }
    } else {
      // 失败退避重试
      const nextAttempt = task.attempts + 1;
      if (nextAttempt < MAX_ATTEMPTS) {
        // "存在未支付订单"必须用户先处理，快速重试毫无意义：
        // 未支付订单约 30 分钟才自动取消，重试间隔至少拉到 15 分钟，且不重复发告警
        const errMsg = result.error ?? '未知错误';
        const blocked = errMsg.includes('未支付订单') || errMsg.includes('未完成订单');
        const baseMs = blocked ? 15 * 60 * 1000 : 20 * 1000 * 2 ** (nextAttempt - 1);
        const retryAt = new Date(Date.now() + baseMs).toISOString();
        TasksRepo.update(task.id, { status: 'queried', saleAt: retryAt, error: errMsg, finishedAt: new Date().toISOString() });
        logger.warn('购票失败，安排重试', { taskId: task.id, error: errMsg, retryAt, blocked });
      } else {
        TasksRepo.update(task.id, { status: 'failed', error: result.error, finishedAt: new Date().toISOString() });
        const notify = await notifyTaskFailed({ userId: task.userId, planName: plan.name, travelDate: task.travelDate, error: result.error ?? '未知错误' });
        if (!notify.ok) logger.error('失败告警也发送失败', { taskId: task.id, error: notify.error });
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
    wsHub.broadcastToUser(task.userId, { type: 'task', payload: TasksRepo.get(task.id) });
    runningLocks.delete(task.id);
    void getSessionState(task.userId);
  }
}

let scanTimer: NodeJS.Timeout | null = null;
let saleTimer: NodeJS.Timeout | null = null;
let triggerTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
/** calendarReady 回调的取消注册函数 */
let calendarReadyUnsub: (() => void) | null = null;

/**
 * 新年份节假日数据就绪后的刷新（用户明确要求：一旦拿到新年份日历，要刷新该年的购票执行时间）。
 *
 * 场景：计划推算到 2027 年，但当时 2027 放假安排尚未发布，只能按自然周降级推算，
 * 任务可能建在错误的日期上（如把国庆放假当天当工作日）。等数据就绪后：
 *  1) 立即重扫计划，用新日历重算 plan_dates（replaceForPlan 会覆盖旧推算）
 *  2) 把该年"待起售/已跳过"的任务重置为 pending，让起售查询按新日期重跑
 *  3) 已成功/已失败的保持不动（历史结果不回滚）
 */
async function refreshForNewCalendarYear(year: number): Promise<void> {
  logger.info('节假日数据就绪，刷新该年购票执行时间', { year });
  try {
    // 先把该年可能"日期已错"的任务重置，再重扫计划（scanPlans 会按新日历重建任务）
    const reset = TasksRepo.resetForYear(year);
    if (reset) logger.info('已重置该年待执行任务，等待按新日历重算', { year, reset });
    await scanPlans();
    void resolveSaleTimes();
  } catch (e) {
    logger.error('新年份日历刷新失败', { year, error: e });
  }
}

export function startScheduler(): void {
  if (scanTimer) return;
  const interrupted = TasksRepo.recoverInterrupted();
  if (interrupted) logger.warn('已标记上次运行中断的任务，请核对订单后手动重试', { count: interrupted });
  // 首次立即执行一次
  void scanPlans().then(() => void resolveSaleTimes());
  scanTimer = setInterval(() => void scanPlans(), 5 * 60 * 1000);
  saleTimer = setInterval(() => void resolveSaleTimes(), 60 * 1000);
  // 秒级触发：确保在起售时刻第一时间购票
  triggerTimer = setInterval(() => void triggerDueTasks(), 1000);
  // 独立对账：未支付订单过期后自动回滚并重新下单，不依赖是否有到点任务
  reconcileTimer = setInterval(() => void reconcileBeforeSale().catch((e) => logger.warn('对账循环异常', e)), RECONCILE_MIN_INTERVAL_MS);
  // 新年份节假日数据就绪时（如 2027 放假安排发布），立即重算该年的购票执行时间
  calendarReadyUnsub = onCalendarReady((year) => {
    void refreshForNewCalendarYear(year);
  });
  logger.info('调度器已启动（计划扫描 5 分钟 / 起售查询 1 分钟 / 触发器 1 秒 / 对账 10 分钟）');
}

export function stopScheduler(): void {
  for (const t of [scanTimer, saleTimer, triggerTimer, reconcileTimer]) {
    if (t) clearInterval(t);
  }
  scanTimer = saleTimer = triggerTimer = reconcileTimer = null;
  for (const t of payDeadlineTimers.values()) clearTimeout(t);
  payDeadlineTimers.clear();
  if (calendarReadyUnsub) {
    calendarReadyUnsub();
    calendarReadyUnsub = null;
  }
}
