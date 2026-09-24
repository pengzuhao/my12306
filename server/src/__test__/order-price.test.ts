import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrders } from '../bot/orders.js';
import { fmtDay, ticketYuan, type RawTicket } from '../bot/orderApi.js';
import { saleAtFromApi } from '../bot/tickets.js';
// Synthetic prices; these are not a claim about G1716's actual fare.
const ticket = (extra: Partial<RawTicket> = {}): RawTicket => ({ start_train_date_page:'2026-09-24 10:00', ticket_status_name:'已支付', passenger_name:'测试甲', seat_type_name:'二等座', ticket_price:31000, stationTrainDTO:{station_train_code:'G1716',from_station_name:'常州北',to_station_name:'信阳东'}, ...extra });
test('prices stay with their own journey and ticket status', () => {
 const rows=normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({stationTrainDTO:{station_train_code:'GTEST',from_station_name:'甲站',to_station_name:'乙站'}}),ticket({ticket_status_name:'已退票'})]}],[]);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(r=>r.totalPrice),[310,310,310]);
 assert.equal(rows.filter(r=>r.status==='refunded').length,1);
});
test('same journey totals people, while missing fares never yield a misleading partial total', () => {
 const rows=normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({passenger_name:'测试乙'})]}],[]);
 assert.equal(rows.length,1);assert.equal(rows[0].totalPrice,620);assert.equal(rows[0].passengers.length,2);
 assert.equal(normalizeOrders([{sequence_no:'TEST',tickets:[ticket(),ticket({ticket_price:undefined})]}],[])[0].totalPrice,null);
});
test('API overlap and repeated completed orders do not double count', () => {
 const order={sequence_no:'TEST',tickets:[ticket()]};
 assert.equal(normalizeOrders([order,order],[{...order,tickets:[ticket({ticket_status_name:'待支付'})]}])[0].totalPrice,310);
 assert.equal(normalizeOrders([order,order],[]).length,1);
});
test('price fields use their declared units and reject invalid numbers', () => {
 assert.equal(ticketYuan({str_ticket_price_page:'310.0',ticket_price:31000}),310);
 assert.equal(ticketYuan({ticket_price:31000}),310);assert.equal(ticketYuan({price:'310.5'}),310.5);
 assert.equal(ticketYuan({price:'Infinity'}),null);assert.equal(ticketYuan({price:-1}),null);
});

test('changed-destination history is separate from the current G1716 ticket', () => {
 // Current 346 yuan fare comes from the reported screenshot; 274 is a synthetic
 // historical fare chosen to reproduce the old 620-yuan aggregation failure.
 const current=ticket({ticket_status_name:'变更到站票',coach_name:'07',seat_name:'17A号',ticket_price:34600,str_ticket_price_page:'346.0'});
 const history=ticket({ticket_status_name:'已变更到站',coach_name:'08',seat_name:'04F号',ticket_price:27400,str_ticket_price_page:'274.0'});
 const rows=normalizeOrders([{sequence_no:'TEST_CHANGED_DESTINATION',tickets:[current,history]}],[]);
 assert.equal(rows.length,2);
 assert.equal(rows.find(r=>r.statusText==='变更到站票')?.totalPrice,346);
 assert.equal(rows.find(r=>r.statusText==='已变更到站')?.totalPrice,274);
 assert.ok(rows.every(r=>r.totalPrice!==620));
 assert.ok(rows.every(r=>r.passengers.length===1 && r.seats.length===1));
 assert.deepEqual(rows.find(r=>r.statusText==='变更到站票')?.seats,['二等座 07车17A号']);
});

test('arrival uses the official destination date, including overnight and multi-day trips', () => {
 for (const arrival of ['2026-09-24 18:32:00','2026-09-25 06:15:00','2026-09-26 08:00:00']) {
  const rows=normalizeOrders([{sequence_no:'ARRIVAL',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:arrival}})]}],[]);
  assert.equal(rows[0].arrivalDateTime,arrival.slice(0,16));
 }
 for (const arrival of [undefined,'','invalid','2026-02-30 06:15','2026-09-25 25:00']) {
  assert.equal(normalizeOrders([{sequence_no:'UNKNOWN',tickets:[ticket({stationTrainDTO:{arrive_time:arrival}})]}],[])[0].arrivalDateTime,null);
 }
 const sameDay=normalizeOrders([{sequence_no:'CLOCK',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:'18:32'}})]}],[]);
 assert.equal(sameDay[0].arrivalDateTime,'2026-09-24 18:32');
 const overnight=normalizeOrders([{sequence_no:'CLOCK',tickets:[ticket({stationTrainDTO:{station_train_code:'G1716',arrive_time:'06:15'}})]}],[]);
 assert.equal(overnight[0].arrivalDateTime,'2026-09-25 06:15');
});

test('sale clock is not attached to the travel date, and order dates use Beijing time', () => {
 assert.equal(saleAtFromApi('2026-09-28','08:00','2026-09-14'),'2026-09-14T08:00:00+08:00');
 assert.equal(saleAtFromApi('2026-09-28','08:30','2026-09-28'),'2026-09-14T08:30:00+08:00');
 assert.equal(saleAtFromApi('2026-09-28','2026-09-14 08:00'),'2026-09-14T08:00:00+08:00');
 assert.equal(fmtDay(new Date('2026-09-21T16:01:00Z')),'2026-09-22');
});
