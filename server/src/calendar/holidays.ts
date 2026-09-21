/**
 * 节假日与工作日判定服务。
 *
 * 数据源（按优先级）：
 *  1. 本地缓存 data/holidays.json（首次拉取后持久化，离线可用）
 *  2. holiday-cn（GitHub：NateScarlet/holiday-cn，收录国务院每年放假安排，含调休补班）
 *  3. timor.tech 逐日接口（兜底）
 *
 * 工作日定义：
 *  - 命中节假日数据且 isOffDay=true  → 放假（非工作日）
 *  - 命中节假日数据且 isOffDay=false → 调休补班（工作日）
 *  - 未命中数据 → 按自然周：周一至周五为工作日，周六日为休息日
 */
import fs from 'node:fs';
import { HOLIDAY_CACHE_PATH } from '../config.js';
import { Logger } from '../logger.js';

const logger = new Logger('calendar');

interface HolidayEntry {
  name: string;
  isOffDay: boolean;
}

/** date(YYYY-MM-DD) -> 节假日条目 */
type HolidayMap = Record<string, HolidayEntry>;

const cache = new Map<number, HolidayMap>();
let loaded = false;

function loadCache(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(HOLIDAY_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HOLIDAY_CACHE_PATH, 'utf8')) as Record<string, HolidayMap>;
      for (const [year, map] of Object.entries(raw)) {
        cache.set(Number(year), map);
      }
      logger.info(`已载入节假日缓存：${Object.keys(raw).join(', ')}`);
    }
  } catch (e) {
    logger.warn('节假日缓存读取失败，将重新拉取', e);
  }
}

function persistCache(): void {
  const obj: Record<string, HolidayMap> = {};
  for (const [year, map] of cache.entries()) obj[String(year)] = map;
  try {
    fs.writeFileSync(HOLIDAY_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    logger.warn('节假日缓存写入失败', e);
  }
}

/** 从 holiday-cn 拉取某一年的放假安排 */
async function fetchYearFromHolidayCn(year: number): Promise<HolidayMap | null> {
  const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { days?: Array<{ name: string; date: string; isOffDay: boolean }> };
    if (!data?.days?.length) return null;
    const map: HolidayMap = {};
    for (const d of data.days) map[d.date] = { name: d.name, isOffDay: d.isOffDay };
    logger.info(`holiday-cn 拉取成功：${year} 年 ${Object.keys(map).length} 条`);
    return map;
  } catch (e) {
    logger.warn(`holiday-cn 拉取失败 ${year}`, e);
    return null;
  }
}

/** 兜底：timor.tech 逐日查询（仅在整年数据缺失时按需调用） */
async function fetchDayFromTimor(date: string): Promise<HolidayEntry | null> {
  const url = `http://timor.tech/api/holiday/info/${date}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code: number;
      type: { type: number; week: string };
      holiday?: { name: string; date: string; rest: number; wage: number };
    };
    if (data.code !== 0) return null;
    // type: 0=工作日 1=节假日 2=调休(补班) 3=周末
    if (data.type.type === 1 && data.holiday) return { name: data.holiday.name, isOffDay: true };
    if (data.type.type === 2 && data.holiday) return { name: `调休(${data.holiday.name})`, isOffDay: false };
    return null;
  } catch (e) {
    logger.warn(`timor 查询失败 ${date}`, e);
    return null;
  }
}

/**
 * 确保指定年份的节假日数据已就绪。
 * @returns 实际"已确认"（缓存命中或拉取成功）的年份集合——
 *          拉取失败的年份不在其中，调用方应据此决定是否继续推算。
 */
export async function ensureYears(years: number[]): Promise<Set<number>> {
  loadCache();
  const missing = years.filter((y) => !cache.has(y));
  for (const year of missing) {
    const map = await fetchYearFromHolidayCn(year);
    if (map) {
      cache.set(year, map);
      persistCache();
    }
  }
  return new Set(years.filter((y) => cache.has(y)));
}

/** 某一年的节假日数据是否已确认（缓存命中）。供推算/执行做前提校验用 */
export function isYearReady(year: number): boolean {
  loadCache();
  return cache.has(year);
}

/** 某日期所在年的节假日数据是否已确认 */
export function isDateReady(date: string): boolean {
  return isYearReady(Number(date.slice(0, 4)));
}

/** 同步获取某日的节假日条目（需先 ensureYears） */
function getEntry(date: string): HolidayEntry | null {
  loadCache();
  const year = Number(date.slice(0, 4));
  const map = cache.get(year);
  if (!map) return null;
  return map[date] ?? null;
}

/** 是否为工作日（周一至周五 且 非法定节假日，或调休补班日） */
export function isWorkday(date: string): boolean {
  const entry = getEntry(date);
  if (entry) return !entry.isOffDay;
  const wd = weekdayOf(date);
  return wd >= 1 && wd <= 5;
}

/** 是否为法定节假日（放假） */
export function isHoliday(date: string): boolean {
  const entry = getEntry(date);
  return Boolean(entry && entry.isOffDay);
}

/** 节假日名称（无则 null） */
export function holidayName(date: string): string | null {
  const entry = getEntry(date);
  return entry ? entry.name : null;
}

/** YYYY-MM-DD 是周几（1=周一 ... 7=周日） */
export function weekdayOf(date: string): number {
  // 用 UTC 正午构造，确保 UTC 日历日期 = 北京日历日期，避免时区偏移导致的错位
  const d = new Date(date + 'T12:00:00.000Z');
  const u = d.getUTCDay(); // 0=周日
  return u === 0 ? 7 : u;
}

/** 从指定日期（含）起，找下一个工作日；若当天即工作日则返回当天 */
export function nextWorkday(date: string): string {
  let cur = date;
  let guard = 0;
  while (!isWorkday(cur) && guard < 400) {
    cur = addDays(cur, 1);
    guard++;
  }
  return cur;
}

/** 日期加减天数，返回 YYYY-MM-DD */
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 今天（北京时间） */
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}
