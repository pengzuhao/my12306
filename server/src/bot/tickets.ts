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

export interface SchemeLeg {
  trainCode: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  /** 这一程的乘车日期。接口给出就用，没有则由界面按时刻跨日推算。 */
  date: string;
  seats: Record<string, string>;
  /** 这一程实际有票的席别代码，不含商务座和无座。 */
  seatTypes: string[];
}

/** 直达之外的出行方案：换乘、同车接续，或接口标明的补票。 */
export interface TravelScheme {
  kind: 'transfer' | 'same-train' | 'supplement';
  label: string;
  fromStation: string;
  middleStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  waitTime: string;
  legs: SchemeLeg[];
}

const SCHEME_SEAT_FIELD: Record<string, string> = {
  swz_num: '商务座',
  tz_num: '特等座',
  zy_num: '一等座',
  ze_num: '二等座',
  gr_num: '高级软卧',
  rw_num: '软卧',
  yw_num: '硬卧',
  rz_num: '软座',
  yz_num: '硬座',
  wz_num: '无座',
};

const SEAT_CODE: Record<string, string> = {
  特等座: 'TZ', 一等座: 'ZY', 二等座: 'ZE', 高级软卧: 'GR', 软卧: 'RW', 硬卧: 'YW', 软座: 'RZ', 硬座: 'YZ',
};

function legDate(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})\D(\d{1,2})\D(\d{1,2})/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function seatCodes(seats: Record<string, string>): string[] {
  return Object.entries(seats)
    .filter(([name, count]) => name !== '商务座' && name !== '无座' && count !== '' && count !== '无' && count !== '--')
    .map(([name]) => SEAT_CODE[name])
    .filter((code): code is string => Boolean(code));
}

function schemeSeats(leg: Record<string, unknown>): Record<string, string> {
  const seats: Record<string, string> = {};
  for (const [key, name] of Object.entries(SCHEME_SEAT_FIELD)) {
    const value = leg[key];
    if (value != null && String(value) !== '') seats[name] = String(value);
  }
  return seats;
}

/** 把 lcquery 的 middleList 收成可展示的方案。字段缺失的条目跳过，不让一页坏数据拖垮直达结果。 */
export function parseTransferList(list: unknown): TravelScheme[] {
  if (!Array.isArray(list)) return [];
  const schemes: TravelScheme[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const rawLegs = Array.isArray(row.fullList) ? row.fullList : [];
    const legs: SchemeLeg[] = [];
    for (const leg of rawLegs) {
      if (!leg || typeof leg !== 'object') continue;
      const part = leg as Record<string, unknown>;
      const trainCode = String(part.station_train_code ?? '').trim();
      if (!trainCode) continue;
      const seats = schemeSeats(part);
      const fallbackDate = legs.length === 0
        ? legDate(row.start_date ?? row.train_date)
        : legDate(row.middle_date ?? row.middle_station_date);
      legs.push({
        trainCode,
        fromStation: String(part.from_station_name ?? '').trim(),
        toStation: String(part.to_station_name ?? '').trim(),
        departTime: String(part.start_time ?? '').trim(),
        arriveTime: String(part.arrive_time ?? '').trim(),
        duration: String(part.lishi ?? '').trim(),
        date: legDate(part.start_date ?? part.train_date ?? part.start_train_date) || fallbackDate,
        seats,
        seatTypes: seatCodes(seats),
      });
    }
    if (!legs.length) continue;
    const sameTrain = row.same_train === 1 || row.same_train === '1' || row.same_train === 'Y';
    const supplement = row.is_bu_piao === 1 || row.is_bu_piao === '1' || String(row.scheme_type ?? '').includes('补');
    const kind = supplement ? 'supplement' : sameTrain ? 'same-train' : 'transfer';
    schemes.push({
      kind,
      label: kind === 'supplement' ? '补票' : kind === 'same-train' ? '同车接续' : '换乘',
      fromStation: String(row.from_station_name ?? legs[0].fromStation),
      middleStation: String(row.middle_station_name ?? ''),
      toStation: String(row.end_station_name ?? legs[legs.length - 1].toStation),
      departTime: String(row.start_time ?? legs[0].departTime),
      arriveTime: String(row.arrive_time ?? legs[legs.length - 1].arriveTime),
      duration: String(row.all_lishi ?? ''),
      waitTime: String(row.wait_time ?? ''),
      legs,
    });
  }
  return schemes;
}

/** 查询中转换乘。失败返回空列表，直达查询仍然可用。 */
export async function queryTransfers(
  context: BrowserContext,
  params: QueryParams,
): Promise<TravelScheme[]> {
  const { stationCode } = await import('./stations.js');
  const fromCode = await stationCode(params.fromStation);
  const toCode = await stationCode(params.toStation);
  if (!fromCode || !toCode) return [];
  const url =
    `${URLS.LC_QUERY}?train_date=${params.trainDate}` +
    `&from_station_telecode=${fromCode}` +
    `&to_station_telecode=${toCode}` +
    `&middle_station=&result_index=0&can_query=Y&isShowWZ=Y&purpose_codes=00&channel=E`;
  const page = await context.newPage();
  try {
    await page.goto(URLS.LEFT_TICKET_INIT, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const raw = await page.evaluate(async (u: string) => {
      const res = await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`换乘接口 HTTP ${res.status}`);
      return res.text();
    }, url);
    const data = JSON.parse(raw) as { data?: { middleList?: unknown } | string };
    if (!data?.data || typeof data.data === 'string') return [];
    const schemes = parseTransferList(data.data.middleList);
    logger.info('换乘查询完成', { date: params.trainDate, from: params.fromStation, to: params.toStation, count: schemes.length });
    return schemes;
  } catch (e) {
    logger.warn('换乘查询失败', e);
    return [];
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 从起售接口拼出北京时间。时刻若自带日期就用该日期；否则用响应里的开售日。响应日与乘车日相同或缺失时，按预售期回推，避免把开售时刻标到出发当天。 */
export function saleAtFromApi(travelDate: string, saleTime: string, responseTrainDate?: string): string | null {
  const text = saleTime.trim();
  const full = /^(\d{4})\D(\d{1,2})\D(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(text);
  if (full) {
    const day = `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
    return `${day}T${full[4].padStart(2, '0')}:${full[5]}:00+08:00`;
  }
  const hm = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!hm) return null;
  const clock = `${hm[1].padStart(2, '0')}:${hm[2]}`;
  const travel = travelDate.slice(0, 10);
  const responseDay = /^\d{8}$/.test(responseTrainDate ?? '')
    ? `${responseTrainDate!.slice(0, 4)}-${responseTrainDate!.slice(4, 6)}-${responseTrainDate!.slice(6, 8)}`
    : (responseTrainDate ?? '').slice(0, 10);
  const saleDay = /^\d{4}-\d{2}-\d{2}$/.test(responseDay) && responseDay !== travel
    ? responseDay
    : addDays(travel, -DEFAULT_PRESALE_DAYS);
  return `${saleDay}T${clock}:00+08:00`;
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
      const iso = saleAtFromApi(args.trainDate, data.data.sale_time, data.data.train_date);
      if (iso) {
        logger.info('起售时间（接口）', { train: args.trainCode, date: args.trainDate, saleTime: data.data.sale_time, saleAt: iso });
        return { saleAt: iso, source: 'api' };
      }
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
