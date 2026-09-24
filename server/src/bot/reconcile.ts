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
import { fetchCompletedOrders, fetchIncompleteOrders, warmOrderPage, type RawOrder, type RawTicket } from './orderApi.js';
import { parseCnTimestamp } from './orders.js';
import { Logger } from '../logger.js';

const logger = new Logger('bot');

/** 一次查询得到的"已购车票"集合（日期 + 车次） */
export interface PurchasedTicket {
  orderNo: string;
  /** 票状态：未完成订单=未支付/待出票，已完成订单=已支付/已出票 */
  status: 'unpaid' | 'paid';
  /** 支付截止时间戳（毫秒，北京时间解析）；未完成订单的"待支付"票才有，其余为 null */
  payLimitTs: number | null;
}

/** 归一化日期（去分隔符）和车次（去空格大写）后比较 */
function normDate(d: string): string {
  return d.replace(/\D/g, '').slice(0, 8);
}
function normCode(c: string): string {
  return c.replace(/\s/g, '').toUpperCase();
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
export function collectFromOrders(
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
      if (d.length !== 8 || !c) continue;
      const st = String(t.ticket_status_name ?? '');
      // 已退票 / 已改签 / 已变更到站是历史票，不能再当成「已买到」。变更到站票、改签票是当前票，要保留。
      if (/已退票|已改签|已变更到站|已取消/.test(st)) continue;
      const isUnpaid = fromIncomplete && st.includes('待支付');
      // 支付截止时间：只有"待支付"票才有意义（已完成订单的 pay_limit_time 是 2099 哨兵值）。
      // 优先取订单层，退到票层；交给调度器的"支付到期定时器"使用。
      const payLimitTs = isUnpaid ? parseCnTimestamp(o.pay_limit_time ?? t.pay_limit_time) : null;
      const from = String(t.stationTrainDTO?.from_station_name ?? '').trim();
      const to = String(t.stationTrainDTO?.to_station_name ?? '').trim();
      map.set(`${d}|${c}|${from}|${to}`, { orderNo, status: isUnpaid ? 'unpaid' : 'paid', payLimitTs });
    }
  }
}

/**
 * 查询当前账户的全部"已购"车票（未完成 + 已完成）。
 * 返回值 key = `${date}|${trainCode}`（归一化），value = 状态。
 *
 * 任一接口失败都返回 null：缺失的查询结果不能作为车票已失效的证据。
 */
export async function queryPurchasedTickets(context: BrowserContext): Promise<Map<string, PurchasedTicket> | null> {
  const page = await context.newPage();
  try {
    // 先 initDc 预热 UAM 链，再停在订单查询页（已完成订单接口必须 POST 带完整表单字段，
    // 否则 12306 CDN 返回空响应——这是之前"已完成订单永远查不到"的根因）
    await warmOrderPage(page);

    const map = new Map<string, PurchasedTicket>();
    let allOk = true;

    // 1) 未完成订单（未支付/待出票）——POST，列表在 data.orderDBList
    try {
      const list = await fetchIncompleteOrders(page, true);
      collectFromOrders(list, map, true);

    } catch (e) {
      allOk = false;
      logger.warn('对账：未完成订单查询失败，跳过本轮', e);
    }

    // 2) 已完成订单（已支付/已出票）——POST 分页，列表在 data.OrderDTODataList
    try {
      const list = await fetchCompletedOrders(page, 90, true);
      collectFromOrders(list, map, false);

    } catch (e) {
      allOk = false;
      logger.warn('对账：已完成订单查询失败，跳过本轮', e);
    }

    return allOk ? map : null;
  } finally {
    await page.close().catch(() => undefined);
  }
}
