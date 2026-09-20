/**
 * 订单对账（需求：预购车票包含已支付和未支付的；未支付最终没付要回滚为未完成）。
 *
 * 核心模型：
 *   "已购" = 12306 未完成订单（未支付/待出票，票还锁着） ∪ 已完成订单（已支付/已出票）
 *
 * 对账规则（针对 plan_dates.status='done' 且乘车日未过去的记录）：
 *   - 未完成订单里能找到该日该车次 → 票仍锁着（未支付）→ 保持 done
 *   - 已完成订单里能找到该日该车次 → 已支付 → 保持 done
 *   - 两边都找不到 → 说明之前的"未支付订单"已超时取消且没有补上 → 回滚 pending，
 *     并把关联的 success 任务重置为可重新执行（起售时刻未到则等，已到则立即触发）
 *
 * 对账时机：由调度器在**起售时刻之前**触发（见 scheduler.reconcileBeforeSale），
 * 保证宝贵的起售时间窗全部留给真正的购票动作。
 */
import type { BrowserContext } from 'playwright';
import { URLS } from './constants.js';
import { Logger } from '../logger.js';

const logger = new Logger('bot');

/** 一次查询得到的"已购车票"集合（日期 + 车次） */
export interface PurchasedTicket {
  orderNo: string;
  /** 票状态：未完成订单=未支付/待出票，已完成订单=已支付/已出票 */
  status: 'unpaid' | 'paid';
}

/** 归一化日期（去分隔符）和车次（去空格大写）后比较 */
function normDate(d: string): string {
  return d.replace(/\D/g, '');
}
function normCode(c: string): string {
  return c.replace(/\s/g, '').toUpperCase();
}

interface RawTicket {
  /** 乘车日期（上车日期），如 "2026-09-28 00:00:00" */
  train_date?: string;
  /** 页面展示用的上车日期+时间，如 "2026-09-28 06:52"（跨日车这里才是真正的乘车日） */
  start_train_date_page?: string;
  stationTrainDTO?: {
    /** 车次号，如 "D5"（注意：在 stationTrainDTO 里，不在 ticket 顶层） */
    station_train_code?: string;
    trainDTO?: { start_date_str?: string };
  };
  /** 票面状态：待支付 / 已支付 / 已出票 等 */
  ticket_status_name?: string;
}
interface RawOrder {
  sequence_no?: string;
  tickets?: RawTicket[];
}

/**
 * 从未完成/已完成订单里提取"已购"车票，写入 map。
 *
 * 字段坑（2026-09-20 实测订单 EQ61061412）：
 *  - 车次号在 ticket.stationTrainDTO.station_train_code，不是 ticket.station_train_code
 *    （后者不存在，导致解析出的车次恒为空，查重/拦截检测全部失效）
 *  - 乘车日期用 ticket.train_date / start_train_date_page；
 *    stationTrainDTO.trainDTO.start_date_str 是**始发站**日期，
 *    跨日车（如 D5 从北京始发、南京 06:52 上车）会差一天，不能用
 *  - 未完成订单里的票未必都是"待支付"：用 ticket_status_name 精确区分
 */
function collectFromOrders(
  orders: RawOrder[],
  map: Map<string, PurchasedTicket>,
  fromIncomplete: boolean,
): void {
  for (const o of orders) {
    const orderNo = String(o.sequence_no ?? '');
    for (const t of o.tickets ?? []) {
      // 乘车日期优先取页面展示值（带时间），退而取 train_date
      const d = normDate(String(t.start_train_date_page ?? t.train_date ?? ''));
      const c = normCode(String(t.stationTrainDTO?.station_train_code ?? ''));
      if (!d || !c) continue;
      const st = String(t.ticket_status_name ?? '');
      const isUnpaid = fromIncomplete && st.includes('待支付');
      map.set(`${d}|${c}`, { orderNo, status: isUnpaid ? 'unpaid' : 'paid' });
    }
  }
}

/**
 * 查询当前账户的全部"已购"车票（未完成 + 已完成）。
 * 返回值 key = `${date}|${trainCode}`（归一化），value = 状态。
 *
 * 两个接口任一失败都 fail-open（返回能拿到的部分），不阻断对账主流程；
 * 都失败时返回 null，调用方应跳过本轮对账。
 */
export async function queryPurchasedTickets(context: BrowserContext): Promise<Map<string, PurchasedTicket> | null> {
  const page = await context.newPage();
  try {
    // 与 purchaseTicket 一致：initDc networkidle 预热，UAM 链跑完后页面在 kyfw 域，可同源 fetch
    await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1500);

    const map = new Map<string, PurchasedTicket>();
    let anyOk = false;

    // 1) 未完成订单（未支付/待出票）
    try {
      const raw = await page.evaluate(async (u: string) => {
        const res = await fetch(u, { credentials: 'include' });
        return res.text();
      }, URLS.MY_ORDER_NO_COMPLETE);
      const data = JSON.parse(raw) as { data?: { orderDBList?: RawOrder[] } };
      collectFromOrders(data.data?.orderDBList ?? [], map, true);
      anyOk = true;
    } catch (e) {
      logger.warn('对账：未完成订单查询失败', e);
    }

    // 2) 已完成订单（已支付/已出票）
    try {
      const raw = await page.evaluate(async (u: string) => {
        const res = await fetch(u, { credentials: 'include' });
        return res.text();
      }, URLS.MY_ORDER_COMPLETE);
      const data = JSON.parse(raw) as { data?: { orderDBList?: RawOrder[] } };
      collectFromOrders(data.data?.orderDBList ?? [], map, false);
      anyOk = true;
    } catch (e) {
      // 已完成接口失败时降级：仅用未完成订单（回滚逻辑仍可工作——未支付订单消失即回滚信号）
      logger.warn('对账：已完成订单查询失败，降级为仅未完成订单', e);
    }

    return anyOk ? map : null;
  } finally {
    await page.close().catch(() => undefined);
  }
}
