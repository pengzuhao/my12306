import type { Page } from 'playwright';
import type { RawOrder } from './orderApi.js';

interface OrderResponse { status?: boolean; messages?: string[]; data?: { existError?: string; orderDBList?: RawOrder[] } }

export class CancellationRejected extends Error {}
export interface CancelTarget { orderNo: string; travelDate: string; trainCode: string; passengers: string[] }
/** Cancel applies to the entire order. Reject extra passengers, legs and non-unpaid tickets. */
export function assertCancelableOrder(orders: RawOrder[], target: CancelTarget): void {
  const hits = orders.filter(o => o.sequence_no === target.orderNo);
  if (hits.length !== 1 || !hits[0].tickets?.length) throw new CancellationRejected('未找到这笔待支付订单，请刷新订单状态后重试');
  const tickets = hits[0].tickets!;
  const names = tickets.map(t => t.passenger_name ?? t.passengerDTO?.passenger_name ?? '').sort();
  if (!target.passengers.length || names.join('\0') !== [...target.passengers].sort().join('\0') || tickets.some(t =>
    t.ticket_status_name !== '待支付'
    || String(t.start_train_date_page ?? t.train_date ?? '').replace(/\D/g,'').slice(0,8) !== target.travelDate.replace(/-/g,'')
    || t.stationTrainDTO?.station_train_code !== target.trainCode)) {
    throw new CancellationRejected('订单已支付或包含其他乘车人、行程，不能在此取消，请前往 12306 核对');
  }
}
/** No retries for mutations. Parameters follow 12306 personalJS/dist/train_order/main_v30108.js. */
export async function cancelUnpaidOrder(page: Page, orderNo: string): Promise<void> {
  const response = await page.evaluate(async ({ orderNo }) => {
    const res = await fetch('/otn/queryOrder/cancelNoCompleteMyOrder', { method:'POST', credentials:'include', headers:{ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With':'XMLHttpRequest' }, body:new URLSearchParams({ sequence_no:orderNo, cancel_flag:'cancel_order' }), signal:AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('取消请求未确认');
    return await res.json() as OrderResponse;
  }, { orderNo });
  if (response?.status === false || response?.data?.existError === 'Y') throw new CancellationRejected('12306 拒绝取消订单，请刷新订单状态后重试');
  if (response?.status !== true || response?.data?.existError !== 'N') throw new Error('取消结果未确认');
}
/** A malformed/empty/auth response must never mean "there are no orders". */
export async function strictIncompleteOrders(page: Page): Promise<RawOrder[]> {
  const response = await page.evaluate(async () => {
    const res = await fetch('/otn/queryOrder/queryMyOrderNoComplete', { method:'POST', credentials:'include', headers:{ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With':'XMLHttpRequest' }, body:'_json_att=', signal:AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('订单查询失败');
    return await res.json() as OrderResponse;
  });
  if (response?.status !== true || response?.data?.existError === 'Y' || (response?.messages?.length ?? 0) > 0 || (response?.data?.orderDBList != null && !Array.isArray(response.data.orderDBList))) throw new CancellationRejected('无法确认待支付订单，请在 12306 核对后重试');
  return response.data?.orderDBList ?? [];
}
