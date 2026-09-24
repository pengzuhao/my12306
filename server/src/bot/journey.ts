import type { OrderRow } from './orders.js';

function peopleKey(row: OrderRow): string {
  return [...row.passengers].sort().join('\0');
}

function hoursBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier.replace(' ', 'T') + ':00+08:00');
  const b = Date.parse(later.replace(' ', 'T') + ':00+08:00');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 3600000;
}

/**
 * 把衔接的几张票收成一条行程。12306 仍是一程一单，这里只打标记。
 * 条件：同一批乘车人、下一程上车车站等于上一程到达站、间隔不超过 24 小时、最多 3 程。
 * 已退票不参与衔接。
 */
export function groupJourneys(rows: OrderRow[]): OrderRow[] {
  const stamped = rows.map((row) => ({ ...row, journeyId: null as string | null, legIndex: 1 }));
  const pool = stamped
    .filter((row) => row.status !== 'refunded')
    .sort((a, b) => a.travelDateTime.localeCompare(b.travelDateTime) || a.trainCode.localeCompare(b.trainCode));
  const used = new Set<OrderRow>();
  let seq = 0;
  for (const row of pool) {
    if (used.has(row)) continue;
    const chain = [row];
    used.add(row);
    for (;;) {
      const tail = chain[chain.length - 1];
      const after = tail.arrivalDateTime || tail.travelDateTime;
      const next = pool.find((item) => !used.has(item)
        && item.fromStation === tail.toStation
        && item.fromStation !== item.toStation
        && peopleKey(item) === peopleKey(row)
        && item.travelDateTime >= tail.travelDateTime
        && hoursBetween(after, item.travelDateTime) >= 0
        && hoursBetween(after, item.travelDateTime) <= 24);
      if (!next || chain.length >= 3) break;
      chain.push(next);
      used.add(next);
    }
    if (chain.length < 2) continue;
    const journeyId = `J${++seq}`;
    chain.forEach((leg, index) => {
      leg.journeyId = journeyId;
      leg.legIndex = index + 1;
    });
  }
  return stamped;
}
