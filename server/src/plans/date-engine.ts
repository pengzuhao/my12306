/**
 * 日期推算引擎（需求 2 的核心）。
 *
 * 支持三种模式：
 *  - single   ：指定具体乘车日期（原样使用，不顺延，但会标注是否为工作日）
 *  - recurring：按工作周期推算（如"每周一"）。调休补班日计入工作周：若本周内
 *               目标周几之前存在调休补班日（自然周末被安排为工作日，如 9.20 周日补班），
 *               则以该补班日为本周首个工作日，提前触发；若推算日为法定节假日/调休休息日，
 *               则自动顺延到下一个工作日，并在结果中标注 postponed。
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
import { addDays, ensureYears, holidayName, isHoliday, isWorkday, nextWorkday, weekdayOf } from '../calendar/holidays.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import type { Plan } from '../types.js';

export interface DateEngineInput {
  dateMode: 'single' | 'recurring' | 'workweek';
  travelDate?: string | null;
  weekday?: number | null;
  weekEdge?: 'start' | 'end' | null;
  weekInterval?: number;
  offsetDays?: number;
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

/** 周几名称（1=周一 .. 7=周日），用于备注文本 */
const WD_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 计算推算日期列表。
 * @param input 规则输入
 * @param todayStr 今天（YYYY-MM-DD），仅生成 >= 今天 的日期；默认取北京时间今天
 */
export async function computeDates(input: DateEngineInput, todayStr?: string): Promise<DateEntry[]> {
  const today = todayStr ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const end = input.validUntil || addDays(today, 180);
  const offset = Math.round(input.offsetDays ?? 0);
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

  if (input.dateMode === 'workweek') {
    // 工作周模式：按工作日历推算，每周期只取首个/最后一个工作日
    const edge = input.weekEdge;
    if (edge !== 'start' && edge !== 'end') return [];
    const interval = Math.max(1, Math.round(input.weekInterval ?? 1));

    let cursor = today < input.validFrom ? input.validFrom : today;
    // 对齐到本周周一（本周的工作周仍有剩余工作日时也要覆盖）
    let weekMonday = addDays(cursor, -(weekdayOf(cursor) - 1));

    const entries: DateEntry[] = [];
    let safety = 0;
    while (weekMonday <= end && safety < 600) {
      safety++;
      const weekSunday = addDays(weekMonday, 6);
      let picked: string | null = null;
      if (edge === 'start') {
        // 首个工作日：从周一往后找第一个工作日
        for (let d = weekMonday; d <= weekSunday; d = addDays(d, 1)) {
          if (isWorkday(d)) {
            picked = d;
            break;
          }
        }
      } else {
        // 最后一个工作日：从周日往前找第一个工作日
        for (let d = weekSunday; d >= weekMonday; d = addDays(d, -1)) {
          if (isWorkday(d)) {
            picked = d;
            break;
          }
        }
      }
      const nextMonday = addDays(weekMonday, 7 * interval);
      if (picked) {
        // 应用提前/延后偏移（负=提前，正=延后）
        const shifted = offset ? addDays(picked, offset) : picked;
        if (shifted >= today && shifted >= input.validFrom && shifted <= end) {
          const wd = weekdayOf(shifted);
          const parts: string[] = [];
          if (wd >= 6 && isWorkday(shifted)) parts.push(`调休补班：本周${edge === 'start' ? '首个' : '最后一个'}工作日为 ${shifted}（周${WD_NAMES[wd - 1]}）`);
          else if (holidayName(picked) && picked !== shifted) parts.push(`节假日顺延：推算日 ${picked}（${holidayName(picked)}）`);
          if (offset) parts.push(offset < 0 ? `提前 ${-offset} 天：${picked} → ${shifted}` : `延后 ${offset} 天：${picked} → ${shifted}`);
          entries.push({
            travelDate: shifted,
            originalDate: picked,
            weekday: wd,
            postponed: false,
            isWorkday: isWorkday(shifted),
            note: parts.join('；') || undefined,
          });
        }
      }
      weekMonday = nextMonday;
    }
    return entries;
  }

  // recurring 模式：固定"每隔 N 周的周 X"，纯日历对齐，不做任何节假日调整。
  // 节假日/补班的自动跳转由 workweek 模式负责——两者职责互斥，页面上已区分说明。
  const target = input.weekday;
  if (!target || target < 1 || target > 7) return [];
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
    const shifted = offset ? addDays(cursor, offset) : cursor;
    if (shifted >= today && shifted <= end) {
      const parts: string[] = [];
      if (offset) parts.push(offset < 0 ? `提前 ${-offset} 天：${cursor} → ${shifted}` : `延后 ${offset} 天：${cursor} → ${shifted}`);
      entries.push({
        travelDate: shifted,
        originalDate: cursor,
        weekday: weekdayOf(shifted),
        postponed: false,
        isWorkday: isWorkday(shifted),
        note: parts.join('；') || undefined,
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
      weekEdge: plan.weekEdge,
      weekInterval: plan.weekInterval,
      offsetDays: plan.offsetDays,
      validFrom: plan.validFrom,
      validUntil: plan.validUntil,
    },
    todayStr,
  );
  return entries.map((e) => ({ ...e, estimatedSaleDate: addDays(e.travelDate, -DEFAULT_PRESALE_DAYS) }));
}
