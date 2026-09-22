/**
 * 日期推算引擎（需求 2 的核心）。
 *
 * 支持三种模式：
 *  - single   ：指定具体乘车日期（原样使用，不顺延，但会标注是否为工作日）
 *  - recurring：固定自然周的星期，不调整节假日。
 *  - workweek ：工作周模式（按工作日历推算，不指定具体周几）。每周期（weekInterval
 *               周）内只生成一天：weekEdge='start' 取该周**首个工作日**（常态周一；
 *               若周一是法定节假日则顺延到下一个工作日；若自然周末被安排为调休补班，
 *               如周日补班，则该补班日就是本周首个工作日），weekEdge='end' 取该周
 *               **最后一个工作日**（常态周五；同理按日历顺延/提前到补班日）。
 *               一周内没有任何工作日（如国庆长假）则该周跳过不生成。
 *
 *  offsetDays：相对推算日的偏移（负=提前，正=延后）。例如工作周开始常态是周一，
 *               offsetDays=-1 则提前到周日出发。recurring 模式同样支持。
 *
 * 输出"具体购票日期列表"，发生顺延的条目额外标注。
 */
import { addDays, ensureYears, holidayName, isWorkday, weekdayOf, isDateDegraded } from '../calendar/holidays.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';

export interface DateEngineInput {
  dateMode: 'single' | 'recurring' | 'workweek';
  travelDate?: string | null;
  weekday?: number | null;
  weekEdge?: 'start' | 'end' | null;
  weekInterval?: number;
  offsetDays?: number;
  validFrom: string;
  validUntil?: string | null;
  /** 出发时间窗（HH:MM），仅工作周模式用于判断"今天的班次是否已错过" */
  timeFrom?: string | null;
  timeTo?: string | null;
}

export interface DateEntry {
  /** 实际出行日期（顺延后）YYYY-MM-DD */
  travelDate: string;
  /** 规则原始推算日期 YYYY-MM-DD */
  originalDate: string;
  /** 1=周一 .. 7=周日（顺延后的日期对应的周几） */
  weekday: number;
  /** 是否发生顺延 */
  postponed: boolean;
  /** 是否为工作日 */
  isWorkday: boolean;
  /** 节假日名称（顺延原因等说明） */
  note?: string;
  /** 该年节假日数据未就绪（按自然周降级推算，实际放假安排公布后会重算） */
  calendarPending?: boolean;
}

export interface PreviewEntry extends DateEntry {
  /** 预估起售日期（= 乘车日期 - 预售期；精确起售时刻由起售查询接口确定） */
  estimatedSaleDate: string;
}

function yearsBetween(from: string, to: string): number[] {
  const a = Number(from.slice(0, 4));
  const b = Number(to.slice(0, 4));
  const out: number[] = [];
  for (let y = Math.min(a, b); y <= Math.max(a, b); y++) out.push(y);
  return out;
}

/** 周几名称（1=周一 .. 7=周日），用于备注文本 */
const WD_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 计算推算日期列表。
 * @param input 规则输入
 * @param todayStr 今天（YYYY-MM-DD），仅生成 >= 今天 的日期；默认取北京时间今天
 * @param nowStr 当前时刻（HH:MM，北京时间）；仅工作周模式用于判断今天的班次是否已错过
 */
export async function computeDates(input: DateEngineInput, todayStr?: string, nowStr?: string): Promise<DateEntry[]> {
  const today = todayStr ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const now = nowStr ?? new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
  const end = input.validUntil || addDays(today, 180);
  const offset = Math.round(input.offsetDays ?? 0);
  // 节假日数据尽量就绪：拉取失败的年份会按自然周降级推算（isWorkday 兜底），
  // 并在条目上打 calendarPending 标记，提示"实际放假安排公布后会重算"。
  // 不再整体抛错——否则一个未来年份没数据，整个计划的推算/预览/任务生成都瘫痪。
  // 只加载实际扫描范围及锚点附近的日历，不额外请求完全用不到的下一年。
  const anchor = addDays(input.validFrom, -offset);
  const needed = [...new Set([
    ...yearsBetween(addDays(today, -7 - Math.abs(offset)), addDays(end, 7 + Math.abs(offset))),
    ...yearsBetween(addDays(anchor, -7), addDays(anchor, 7)),
    ...(input.travelDate ? [Number(input.travelDate.slice(0, 4))] : []),
  ])];
  await ensureYears(needed);

  if (input.dateMode === 'single') {
    const d = input.travelDate;
    if (!d) return [];
    return [
      {
        travelDate: d,
        originalDate: d,
        weekday: weekdayOf(d),
        postponed: false,
        isWorkday: isWorkday(d),
        note: holidayName(d) ? `法定节假日：${holidayName(d)}` : undefined,
        calendarPending: isDateDegraded(d) || undefined,
      },
    ];
  }

  if (input.dateMode === 'workweek') {
    // validFrom 是生效下限，不能把周三切成一个新工作周。
    // 周一至周六属于同一工作周；紧邻周一的周日补班归入后一个工作周。
    const edge = input.weekEdge;
    if (edge !== 'start' && edge !== 'end') return [];
    const step = 7 * Math.max(1, Math.round(input.weekInterval ?? 1));
    const departDeadline = input.timeTo || null;
    const baseFrom = addDays(input.validFrom, -offset);
    let weekStart = addDays(baseFrom, 1 - weekdayOf(baseFrom));
    if (weekdayOf(baseFrom) === 7 && isWorkday(baseFrom)) weekStart = addDays(weekStart, 7);
    function pickWeek(monday: string): { picked: string | null; naive: string } {
      const sunday = addDays(monday, -1);
      const from = isWorkday(sunday) ? sunday : monday;
      const saturday = addDays(monday, 5);
      let picked: string | null = null;
      for (let d = from; d <= saturday; d = addDays(d, 1)) {
        if (!isWorkday(d)) continue;
        picked = d;
        if (edge === 'start') break;
      }
      return { picked, naive: edge === 'start' ? monday : addDays(monday, 4) };
    }
    // 先确定生效范围内的首个完整工作周目标，再固定每 N 周的节奏。
    const lastWeek = addDays(end, Math.max(0, -offset) + 7);
    while (weekStart <= lastWeek) {
      const { picked } = pickWeek(weekStart);
      if (picked && addDays(picked, offset) >= input.validFrom) break;
      weekStart = addDays(weekStart, 7);
    }
    // 扫描日期推进时保持原始周期，保留相邻周期以容纳日期微调。
    const skips = Math.max(0, Math.floor((Date.parse(today) - Date.parse(weekStart)) / 86_400_000 / step) - 1);
    weekStart = addDays(weekStart, skips * step);

    const entries: DateEntry[] = [];
    let safety = 0;
    while (weekStart <= lastWeek && safety < 600) {
      safety++;
      const { picked, naive } = pickWeek(weekStart);
      const nextStart = addDays(weekStart, step);
      if (picked) {
        const shifted = offset ? addDays(picked, offset) : picked;
        // 只有实际取到的工作日晚于常态目标日，才是真正的节假日顺延；
        // 早于常态目标日（如周日补班成为本周首个工作日）属"提前"，不算顺延。
        const postponed = naive !== null && picked > naive;
        // 今天这班车是否已经开走：推算日=今天 且 当前时刻已晚于出发时间窗
        const missedToday = shifted === today && departDeadline !== null && now >= departDeadline;
        if (!missedToday && shifted >= today && shifted >= input.validFrom && shifted <= end) {
          const wd = weekdayOf(shifted);
          const parts: string[] = [];
          if (naive) {
            if (postponed) {
              const hol = holidayName(naive);
              parts.push(`节假日顺延：${naive}（${hol ?? '非工作日'}）→ ${shifted}`);
            } else if (picked < naive && !isWorkday(naive)) {
              // 常态工作日因放假/调休前移（如本周最后工作日因假期提前），补一条说明
              parts.push(`节假日提前：${naive} → ${shifted}`);
            }
          }
          if (wd >= 6 && isWorkday(shifted)) parts.push(`调休补班：本周${edge === 'start' ? '首个' : '最后一个'}工作日为 ${shifted}（周${WD_NAMES[wd - 1]}）`);
          if (offset) parts.push(offset < 0 ? `提前 ${-offset} 天：${picked} → ${shifted}` : `延后 ${offset} 天：${picked} → ${shifted}`);
          const pending = isDateDegraded(shifted);
          if (pending) parts.push(`${shifted.slice(0, 4)} 年放假安排尚未公布，暂按自然周推算`);
          entries.push({
            travelDate: shifted,
            originalDate: naive ?? picked,
            weekday: wd,
            postponed,
            isWorkday: isWorkday(shifted),
            note: parts.join('；') || undefined,
            calendarPending: pending || undefined,
          });
        }
      }
      weekStart = nextStart;
    }
    return entries;
  }

  // recurring 模式：固定"每隔 N 周的周 X"，纯日历对齐，不做任何节假日调整。
  // 节假日/补班的自动跳转由 workweek 模式负责——两者职责互斥，页面上已区分说明。
  const target = input.weekday;
  if (!target || target < 1 || target > 7) return [];
  const interval = Math.max(1, Math.round(input.weekInterval ?? 1));

  // 周期由生效范围内首个目标日锚定，不能随着今天推进而重新对齐隔周节奏。
  let cursor = addDays(input.validFrom, -offset);
  // 对齐到第一个目标星期
  let guard = 0;
  while (weekdayOf(cursor) !== target && guard < 8) {
    cursor = addDays(cursor, 1);
    guard++;
  }
  const skippedCycles = Math.max(0, Math.floor((Date.parse(today) - Date.parse(addDays(cursor, offset))) / 86_400_000 / (7 * interval)));
  cursor = addDays(cursor, skippedCycles * 7 * interval);

  const entries: DateEntry[] = [];
  let safety = 0;
  while (addDays(cursor, offset) <= end && safety < 400) {
    safety++;
    const shifted = offset ? addDays(cursor, offset) : cursor;
    if (shifted >= today && shifted >= input.validFrom && shifted <= end) {
      const parts: string[] = [];
      if (offset) parts.push(offset < 0 ? `提前 ${-offset} 天：${cursor} → ${shifted}` : `延后 ${offset} 天：${cursor} → ${shifted}`);
      const pending = isDateDegraded(shifted);
      if (pending) parts.push(`${shifted.slice(0, 4)} 年放假安排尚未公布，暂按自然周推算`);
      entries.push({
        travelDate: shifted,
        originalDate: cursor,
        weekday: weekdayOf(shifted),
        postponed: false,
        isWorkday: isWorkday(shifted),
        note: parts.join('；') || undefined,
        calendarPending: pending || undefined,
      });
    }
    cursor = addDays(cursor, 7 * interval);
  }

  return entries;
}

/** 针对推算入参做预览（额外给出预估起售日期）；可直接传计划对象 */
export async function previewForPlan(input: DateEngineInput, todayStr?: string, nowStr?: string): Promise<PreviewEntry[]> {
  const entries = await computeDates(
    {
      dateMode: input.dateMode,
      travelDate: input.travelDate,
      weekday: input.weekday,
      weekEdge: input.weekEdge,
      weekInterval: input.weekInterval,
      offsetDays: input.offsetDays,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      timeFrom: input.timeFrom,
      timeTo: input.timeTo,
    },
    todayStr,
    nowStr,
  );
  return entries.map((e) => ({ ...e, estimatedSaleDate: addDays(e.travelDate, -DEFAULT_PRESALE_DAYS) }));
}
