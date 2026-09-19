/**
 * 日期推算引擎（需求 2 的核心）。
 *
 * 支持两种模式：
 *  - single   ：指定具体乘车日期（原样使用，不顺延，但会标注是否为工作日）
 *  - recurring：按工作周期推算（如"每周一"）。调休补班日计入工作周：若本周内
 *               目标周几之前存在调休补班日（自然周末被安排为工作日，如 9.20 周日补班），
 *               则以该补班日为本周首个工作日，提前触发；若推算日为法定节假日/调休休息日，
 *               则自动顺延到下一个工作日，并在结果中标注 postponed。
 *
 * 输出"具体购票日期列表"，发生顺延的条目额外标注。
 */
import { addDays, ensureYears, holidayName, isHoliday, isWorkday, nextWorkday, weekdayOf } from '../calendar/holidays.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import type { Plan } from '../types.js';

export interface DateEngineInput {
  dateMode: 'single' | 'recurring';
  travelDate?: string | null;
  weekday?: number | null;
  weekInterval?: number;
  validFrom: string;
  validUntil?: string | null;
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
}

export interface PreviewEntry extends DateEntry {
  /** 预估起售日期（= 乘车日期 - 预售期；精确起售时刻由起售查询接口确定） */
  estimatedSaleDate: string;
}

function yearsBetween(from: string, to: string): number[] {
  const a = Number(from.slice(0, 4));
  const b = Number(to.slice(0, 4));
  const out: number[] = [];
  for (let y = Math.min(a, b); y <= Math.max(a, b) + 1; y++) out.push(y);
  return out;
}

/**
 * 计算推算日期列表。
 * @param input 规则输入
 * @param todayStr 今天（YYYY-MM-DD），仅生成 >= 今天 的日期；默认取北京时间今天
 */
export async function computeDates(input: DateEngineInput, todayStr?: string): Promise<DateEntry[]> {
  const today = todayStr ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const end = input.validUntil || addDays(today, 180);
  await ensureYears(yearsBetween(today, end));

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
      },
    ];
  }

  // recurring 模式
  const target = input.weekday;
  if (!target || target < 1 || target < 1 || target > 7) return [];
  const interval = Math.max(1, Math.round(input.weekInterval ?? 1));

  let cursor = today < input.validFrom ? input.validFrom : today;
  // 对齐到第一个目标星期
  let guard = 0;
  while (weekdayOf(cursor) !== target && guard < 8) {
    cursor = addDays(cursor, 1);
    guard++;
  }

  const entries: DateEntry[] = [];
  let safety = 0;
  while (cursor <= end && safety < 400) {
    safety++;
    // 调休补班日计入工作周：对齐到目标周几后，若本周内该日之前存在调休补班日
    // （自然周末被安排为工作日，如 9.20 周日补班），则以最早的补班日为本周首个工作日。
    // 这样"每周一"在补班周会提前到周日触发，而不是死等周一。
    const weekStart = addDays(cursor, -(target % 7));
    let trigger = cursor;
    for (let d = weekStart; d < cursor; d = addDays(d, 1)) {
      if (d >= input.validFrom && d >= today && isWorkday(d) && weekdayOf(d) >= 6) {
        trigger = d;
        break;
      }
    }
    if (isWorkday(trigger)) {
      entries.push({
        travelDate: trigger,
        originalDate: cursor,
        weekday: weekdayOf(trigger),
        postponed: false,
        isWorkday: true,
        note:
          trigger < cursor
            ? `调休补班：本周首个工作日为 ${trigger}（周${weekdayOf(trigger)}），提前触发`
            : undefined,
      });
    } else {
      // 非工作日（法定节假日或周末）→ 顺延到下一个工作日
      const shifted = nextWorkday(addDays(trigger, 1));
      const why = holidayName(trigger) ?? '周末';
      entries.push({
        travelDate: shifted,
        originalDate: cursor,
        weekday: weekdayOf(shifted),
        postponed: true,
        isWorkday: true,
        note: `${why}，顺延至 ${shifted}（周${weekdayOf(shifted)}）`,
      });
    }
    cursor = addDays(cursor, 7 * interval);
  }

  return entries;
}

/** 针对计划对象做预览（额外给出预估起售日期） */
export async function previewForPlan(plan: Plan, todayStr?: string): Promise<PreviewEntry[]> {
  const entries = await computeDates(
    {
      dateMode: plan.dateMode,
      travelDate: plan.travelDate,
      weekday: plan.weekday,
      weekInterval: plan.weekInterval,
      validFrom: plan.validFrom,
      validUntil: plan.validUntil,
    },
    todayStr,
  );
  return entries.map((e) => ({ ...e, estimatedSaleDate: addDays(e.travelDate, -DEFAULT_PRESALE_DAYS) }));
}
