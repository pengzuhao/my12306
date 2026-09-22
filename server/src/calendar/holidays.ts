/**
 * 节假日与工作日判定服务。
 *
 * 数据源（按优先级）：
 *  1. 本地缓存 data/holidays.json（首次拉取后持久化，离线可用）
 *  2. holiday-cn（GitHub：NateScarlet/holiday-cn，收录国务院每年放假安排，含调休补班）
 *  3. timor.tech 逐日接口（兜底：holiday-cn 拉不到时，按日查询补齐该年）
 *
 * 工作日定义：
 *  - 命中节假日数据且 isOffDay=true  → 放假（非工作日）
 *  - 命中节假日数据且 isOffDay=false → 调休补班（工作日）
 *  - 未命中数据 → 按自然周：周一至周五为工作日，周六日为休息日
 *
 * 新年份就绪回调：国务院通常在当年末发布下一年放假安排，发布前该年数据
 * 拉不到。一旦某年从"缺失"变为"就绪"（用户补录或数据源更新），通过
 * onCalendarReady 注册的回调会被触发，调度器据此重算该年的购票执行时间。
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

/** 某年数据是否为"降级"状态：数据源拉取失败，工作日判定退回自然周兜底 */
const degradedYears = new Set<number>();

/** 节假日数据就绪回调（某年从缺失变为可用时触发） */
type CalendarReadyListener = (year: number) => void;
const readyListeners: CalendarReadyListener[] = [];

/**
 * 注册"新年份节假日数据就绪"回调。
 * 调度器用它实现：一旦拿到新年份的日历，立刻刷新该年份的购票执行时间。
 * @returns 取消注册的函数
 */
export function onCalendarReady(listener: CalendarReadyListener): () => void {
  readyListeners.push(listener);
  return () => {
    const i = readyListeners.indexOf(listener);
    if (i >= 0) readyListeners.splice(i, 1);
  };
}

/** 通知某年数据已就绪（只在"此前缺失/降级 → 本次成功"时才通知，避免重复） */
function notifyReadyIfNewlyAvailable(year: number, newlyFetched: boolean): void {
  if (!newlyFetched) return;
  degradedYears.delete(year);
  for (const fn of readyListeners) {
    try {
      fn(year);
    } catch (e) {
      logger.warn('calendarReady 回调执行失败', e);
    }
  }
}

/** 某年当前是否处于降级状态（数据源拉取失败，按自然周兜底） */
export function isYearDegraded(year: number): boolean {
  return degradedYears.has(year);
}

/** 日期所在年是否处于降级状态 */
export function isDateDegraded(date: string): boolean {
  return isYearDegraded(Number(date.slice(0, 4)));
}

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
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
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
 *
 * 拉取策略（逐年）：
 *  1. 缓存命中 → 直接可用
 *  2. holiday-cn 拉取成功 → 写缓存并持久化
 *  3. holiday-cn 失败 → timor.tech 逐日查询补齐该年（调休/放假都能覆盖）
 *  4. 两个数据源都失败 → 标记该年为降级（按自然周兜底），不抛错
 *
 * @returns 实际"已确认"（缓存命中或拉取成功）的年份集合——
 *          拉取失败的年份不在其中，调用方应据此决定是否继续推算。
 */
export async function ensureYears(years: number[]): Promise<Set<number>> {
  loadCache();
  const now = Date.now();
  // 近期已尝试且失败的年份短期不重试——未发布的年份（如 2027/2028）每次请求
  // 都会走两轮网络（holiday-cn + timor 探针），每次数秒，把日历接口拖死。
  // 进程内记忆即可：重启后最多再试一轮，代价可接受。
  const missing = years.filter((y) => !cache.has(y) && (!failedAt.has(y) || now - (failedAt.get(y) ?? 0) > RETRY_INTERVAL_MS));
  if (missing.length) {
    // 各年数据互相独立，并行拉取——之前串行 await 时，一个年份卡住会拖慢整批
    // （典型场景：查当前年要顺带确保相邻年，某个相邻年未发布会走 timor 兜底，
    //  60 次串行 HTTP 请求把日历接口阻塞数十秒）
    await Promise.all(missing.map((year) => ensureOneYear(year)));
  }
  return new Set(years.filter((y) => cache.has(y)));
}

/** 某年最近一次拉取失败的时间戳（用于短期跳过重试） */
const failedAt = new Map<number, number>();
/** 失败后的重试间隔：一小时。节假日数据以年为单位变化，不必高频重试 */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** 拉取单年节假日并写缓存（holiday-cn 优先，timor 兜底，两者皆失败则降级） */
async function ensureOneYear(year: number): Promise<void> {
  const map = await fetchYearFromHolidayCn(year);
  if (map) {
    cache.set(year, map);
    persistCache();
    notifyReadyIfNewlyAvailable(year, true);
    return;
  }
  // holiday-cn 拉不到（数据源未更新或网络问题）：用 timor 逐日查询补齐
  const fallback = await fetchYearFromTimor(year);
  if (fallback) {
    cache.set(year, fallback);
    persistCache();
    logger.info(`timor 逐日补齐成功：${year} 年 ${Object.keys(fallback).length} 条`);
    notifyReadyIfNewlyAvailable(year, true);
    return;
  }
  // 两个数据源都失败：标记降级，工作日判定退回自然周兜底
  degradedYears.add(year);
  failedAt.set(year, Date.now());
  logger.warn(`${year} 年节假日数据两个数据源均拉取失败，该年按自然周降级推算（1 小时内不重试）`, undefined);
}

/**
 * 用 timor.tech 逐日查询补齐一年的节假日数据（调休补班/放假都能覆盖）。
 *
 * 不查全年 365 天（每次网络往返 + 超时，接口不通时会卡一小时）：
 *  1) 先用国庆节当天探测一次——接口不通立即放弃该年（快速失败）
 *  2) 探测成功才查候选节假日窗口（元旦/春节/清明/五一/端午/中秋/国庆，
 *     每个窗口前后多查几天覆盖调休），总计约 60 次，可控
 */
async function fetchYearFromTimor(year: number): Promise<HolidayMap | null> {
  const p = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // 1) 探测：国庆节当天必然是节假日，接口可用与否一次就能判定
  const probe = await fetchDayFromTimor(p(10, 1));
  if (!probe) return null;

  const map: HolidayMap = { [p(10, 1)]: probe };
  // 2) 候选节假日窗口（含调休补班常见的相邻日期）
  const candidates = [
    ...range(1, 1, 3), // 元旦
    ...range(2, 1, 20), // 春节（公历不固定，拉宽窗口）
    ...range(4, 2, 8), // 清明
    ...range(5, 1, 6), // 五一
    ...range(6, 1, 10), // 端午
    ...range(9, 1, 10), // 中秋
    ...range(10, 1, 10), // 国庆
  ];
  const dates = [...new Set(candidates.map(([m, d]) => p(m, d)))].filter((d) => !map[d]);
  // 并发查询（限制 8 路，兼顾速度与对方服务器压力），任一失败只是少一条记录
  for (let i = 0; i < dates.length; i += 8) {
    const batch = dates.slice(i, i + 8);
    const results = await Promise.all(batch.map((date) => fetchDayFromTimor(date).then((e) => [date, e] as const)));
    for (const [date, entry] of results) {
      if (entry) map[date] = entry;
    }
  }
  return map;

  function range(m: number, dFrom: number, dTo: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let d = dFrom; d <= dTo; d++) out.push([m, d]);
    return out;
  }
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
