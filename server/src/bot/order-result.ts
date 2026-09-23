import type { Task, Plan } from '../types.js';
import type { OrderRow } from './orders.js';

/** Match one exact ticket group; never infer purchased seats from the plan's preference. */
export function verifiedOrderResult(task: Task, plan: Plan, passengerNames: string[], orders: OrderRow[]): Record<string, unknown> | null {
  if (task.status !== 'success' || !task.result) return null;
  const trainCode = String(task.result.trainCode ?? task.trainNumber ?? '').trim().toUpperCase();
  const sameNames = (names: string[]) => names.length === passengerNames.length && [...names].sort().join('\0') === [...passengerNames].sort().join('\0');
  const hits = orders.filter(order => order.status !== 'refunded' && order.travelDateTime.slice(0, 10) === task.travelDate
    && order.trainCode.toUpperCase() === trainCode && sameNames(order.passengers)
    && (task.result!.orderNo ? order.orderNo === task.result!.orderNo
      : order.fromStation === plan.fromStation && order.toStation === plan.toStation)
    && order.seats.length === order.passengers.length && order.seats.every(seat => seat.trim()));
  if (hits.length !== 1 || !passengerNames.length) return null;
  const order = hits[0];
  return { ...task.result, seatInfo: order.seats.join('；'), seatInfoSource: 'order', orderNo: order.orderNo, paid: order.status === 'paid' };
}
