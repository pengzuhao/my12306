import type { Page } from 'playwright';
import { cancelUnpaidOrder } from './cancel-order.js';

export class RefundRejected extends Error {}

export interface RefundTicket {
  orderNo: string;
  passenger: string;
  batchNo: string;
  coachNo: string;
  seatNo: string;
  /** 待支付整单取消；已支付按票退。 */
  unpaid: boolean;
}

interface TicketResponse { status?: boolean; data?: { flag?: boolean; existError?: string; errMes?: string }; messages?: string[] }

/** 已支付退票：先确认退票费，再提交。参数与 12306 订单页 returnTicket 一致。 */
export async function returnPaidTicket(page: Page, ticket: RefundTicket): Promise<void> {
  if (!ticket.batchNo || !ticket.coachNo || !ticket.seatNo) throw new RefundRejected('这张票缺少退票定位，请到 12306 订单页办理');
  const body = new URLSearchParams({
    sequence_no: ticket.orderNo,
    batch_no: ticket.batchNo,
    coach_no: ticket.coachNo,
    seat_no: ticket.seatNo,
  });
  const affirm = await page.evaluate(async (encoded: string) => {
    const res = await fetch('/otn/queryOrder/returnTicketAffirm', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: encoded, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('退票确认未响应');
    return await res.json() as TicketResponse;
  }, body.toString());
  if (affirm?.status !== true || affirm?.data?.flag === false) {
    throw new RefundRejected(affirm?.data?.errMes || affirm?.messages?.[0] || '12306 拒绝退票，请刷新后重试');
  }
  const done = await page.evaluate(async (encoded: string) => {
    const res = await fetch('/otn/queryOrder/returnTicket', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: encoded, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('退票提交未响应');
    return await res.json() as TicketResponse;
  }, body.toString());
  if (done?.status !== true || done?.data?.flag === false || done?.data?.existError === 'Y') {
    throw new RefundRejected(done?.data?.errMes || done?.messages?.[0] || '退票结果未确认');
  }
}

export async function refundTickets(page: Page, tickets: RefundTicket[]): Promise<void> {
  const cancelled = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.unpaid) {
      if (cancelled.has(ticket.orderNo)) continue;
      await cancelUnpaidOrder(page, ticket.orderNo);
      cancelled.add(ticket.orderNo);
      continue;
    }
    await returnPaidTicket(page, ticket);
  }
}
