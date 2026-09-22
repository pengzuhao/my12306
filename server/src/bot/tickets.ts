/**
 * 车票查询与起售时间（需求 5）。
 *
 * 余票查询走浏览器上下文内的 fetch（复用登录态 cookie，规避反爬与 CORS）。
 * 起售时间优先调 12306 起售查询接口，失败时按预售期兜底推算。
 */
import type { BrowserContext, Page } from 'playwright';
import { URLS, SEAT_INDEX, FIELD_INDEX, SEAT_NAMES } from './constants.js';
import { DEFAULT_PRESALE_DAYS } from '../config.js';
import { Logger } from '../logger.js';
import type { TrainInfo } from '../types.js';
import { TrainQueryError } from './train-query-error.js';
import { today, addDays } from '../calendar/holidays.js';

const logger = new Logger('bot');

interface QueryParams {
  trainDate: string; // YYYY-MM-DD
  fromStation: string; // 车站名（自动转码）
  toStation: string;
  purposeCodes?: 'ADULT' | '0X00';
}

/** 解析 leftTicket 的 result 字符串为车次信息 */
export function parseTrainRow(row: string): TrainInfo | null {
  const f = row.split('|');
  if (f.length < 33) return null;
  const seats: Record<string, string> = {};
  for (const [code, idx] of Object.entries(SEAT_INDEX)) {
    const v = f[idx];
    if (v !== undefined && v !== '') seats[SEAT_NAMES[code] ?? code] = v;
  }
  return {
    trainCode: f[FIELD_INDEX.trainCode],
    fromStation: f[FIELD_INDEX.fromStation],
    toStation: f[FIELD_INDEX.toStation],
    departTime: f[FIELD_INDEX.departTime],
    arriveTime: f[FIELD_INDEX.arriveTime],
    duration: f[FIELD_INDEX.duration],
    seats,
    raw: f,
  };
}

/** 余票余量文本 → 数字（"有"→99, "无"→0, 数字→数字） */
export function seatCount(text: string | undefined): number {
  if (!text) return 0;
  if (text === '有') return 99;
  if (text === '无' || text === '') return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** 在已登录的浏览器上下文中查询余票 */
export async function queryTrains(context: BrowserContext, params: QueryParams): Promise<TrainInfo[]> {
  const lastDate = addDays(today(), DEFAULT_PRESALE_DAYS);
  if (params.trainDate > lastDate) throw new TrainQueryError(`${params.trainDate} 尚未开售，当前可查询至 ${lastDate}`);
  const { stationCode } = await import('./stations.js');
  const fromCode = await stationCode(params.fromStation);
  const toCode = await stationCode(params.toStation);
  if (!fromCode || !toCode) throw new TrainQueryError('无法识别车站，请从站点搜索结果中选择');

  const url =
    `${URLS.LEFT_TICKET_QUERY}?leftTicketDTO.train_date=${params.trainDate}` +
    `&leftTicketDTO.from_station=${fromCode}` +
    `&leftTicketDTO.to_station=${toCode}` +
    `&purpose_codes=${params.purposeCodes ?? 'ADULT'}`;

  const page = await context.newPage();
  try {
    // 先打开 kyfw 域查票页（而非 INDEX，后者会 303 到 www.12306.cn 导致跨域 fetch 失败），
    // 确保 cookie 域名就绪且 fetch 余票接口为同源
    await page.goto(URLS.LEFT_TICKET_INIT, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (new URL(page.url()).origin !== new URL(URLS.LEFT_TICKET_QUERY).origin) {
      throw new TrainQueryError('12306 查询页面暂时不可用，请稍后刷新重试');
    }
    const json = await page.evaluate(async (u: string) => {
      const res = await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`余票接口 HTTP ${res.status}`);
      return res.text();
    }, url);
    const data = JSON.parse(json) as {
      httpstatus: number;
      data?: { result?: string[]; map?: Record<string, string> };
      messages?: string[];
    };
    if (!data?.data?.result) {
      throw new TrainQueryError('12306 暂未返回有效余票数据，请稍后刷新重试');
    }
    const map = data.data.map ?? {};
    const trains = data.data.result
      .map((r) => parseTrainRow(r))
      .filter((t): t is TrainInfo => t !== null)
      .map((t) => ({
        ...t,
        fromStation: map[t.fromStation] ?? t.fromStation,
        toStation: map[t.toStation] ?? t.toStation,
      }));
    logger.info('余票查询完成', { date: params.trainDate, from: params.fromStation, to: params.toStation, count: trains.length });
    return trains;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 查询车票起售时间（精确到分秒）。
 * 优先 12306 起售查询接口；失败时按预售期推算（乘车日 - N 天，起售时刻取车站常见起售点）。
 *
 * @returns ISO 时间字符串，如 2026-09-28T08:00:00+08:00
 */
export async function querySaleTime(
  page: Page,
  args: { trainDate: string; trainCode: string; fromStation: string; toStation: string },
): Promise<{ saleAt: string; source: 'api' | 'estimated' }> {
  const { stationCode } = await import('./stations.js');
  const fromCode = (await stationCode(args.fromStation)) ?? '';
  const toCode = (await stationCode(args.toStation)) ?? '';
  const url =
    `${URLS.QUERY_SALE_TIME}?train_date=${args.trainDate}` +
    `&station_train_code=${encodeURIComponent(args.trainCode)}` +
    `&from_station_telecode=${fromCode}` +
    `&to_station_telecode=${toCode}`;

  try {
    const raw = await page.evaluate(async (u: string) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.text();
    }, url);
    const data = JSON.parse(raw) as { httpstatus?: number; data?: { sale_time?: string; train_date?: string }; messages?: string[] };
    if (data?.data?.sale_time) {
      const iso = `${args.trainDate}T${data.data.sale_time}:00+08:00`;
      logger.info('起售时间（接口）', { train: args.trainCode, date: args.trainDate, saleTime: data.data.sale_time });
      return { saleAt: iso, source: 'api' };
    }
    logger.warn('起售时间接口未返回，使用预售期推算', { raw: raw.slice(0, 200) });
  } catch (e) {
    logger.warn('起售时间查询失败，使用预售期推算', e);
  }

  // 兜底：乘车日 - 预售期，起售时刻默认 08:00（最常见的起售时间点）
  const d = new Date(args.trainDate + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - DEFAULT_PRESALE_DAYS);
  const est = `${d.toISOString().slice(0, 10)}T08:00:00+08:00`;
  return { saleAt: est, source: 'estimated' };
}

/** 默认预售期（天） */
export const presaleDays = DEFAULT_PRESALE_DAYS;
