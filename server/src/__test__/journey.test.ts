import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupJourneys } from '../bot/journey.js';
import { rankChangeOptions } from '../bot/change-options.js';
import type { OrderRow } from '../bot/orders.js';
import type { TrainInfo } from '../types.js';

function row(partial: Partial<OrderRow> & Pick<OrderRow, 'orderNo' | 'trainCode' | 'fromStation' | 'toStation' | 'travelDateTime'>): OrderRow {
  return {
    status: 'paid', statusText: '已支付', passengers: ['张三'], seats: ['二等座'], totalPrice: 100,
    payLimitTime: null, payLimitTs: null, journeyId: null, legIndex: 1, refundTickets: [], arrivalDateTime: null,
    ...partial,
  };
}

test('connecting legs of the same passengers become one journey', () => {
  const grouped = groupJourneys([
    row({ orderNo: 'A', trainCode: 'G1', fromStation: '上海虹桥', toStation: '南京南', travelDateTime: '2026-09-25 08:00', arrivalDateTime: '2026-09-25 10:00' }),
    row({ orderNo: 'B', trainCode: 'G2', fromStation: '南京南', toStation: '信阳东', travelDateTime: '2026-09-25 10:40', arrivalDateTime: '2026-09-25 14:00' }),
    row({ orderNo: 'C', trainCode: 'G9', fromStation: '北京南', toStation: '天津', travelDateTime: '2026-09-25 09:00' }),
  ]);
  const linked = grouped.filter((item) => item.journeyId);
  assert.equal(linked.length, 2);
  assert.equal(linked[0].journeyId, linked[1].journeyId);
  assert.deepEqual(linked.map((item) => item.legIndex), [1, 2]);
  assert.equal(grouped.find((item) => item.orderNo === 'C')?.journeyId, null);
});

test('change options prefer a nearby direct and skip the train already held', () => {
  const train = (code: string, depart: string, duration: string): TrainInfo => ({
    trainCode: code, fromStation: '上海虹桥', toStation: '信阳东', departTime: depart, arriveTime: '18:00', duration, seats: { 二等座: '有' }, raw: [],
  });
  const options = rankChangeOptions({
    mode: 'to-direct', date: '2026-09-25', departTime: '08:00', currentTrains: ['G1'],
    trains: [train('G1', '08:00', '06:00'), train('G3', '08:30', '05:40'), train('G4', '18:00', '06:10')],
    schemes: [],
  });
  assert.equal(options[0].trains[0], 'G3');
  assert.equal(options.some((item) => item.trains.includes('G1')), false);
  assert.equal(options[0].kind, 'direct');
});
