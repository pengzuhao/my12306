import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submittedSeatNames } from '../bot/seat-result.js';
import { verifiedOrderResult } from '../bot/order-result.js';
import type { Task, Plan } from '../types.js';
import type { OrderRow } from '../bot/orders.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pax = (seat: string) => `${seat},0,1,测试乘车人,1,TEST_ONLY,,N,encrypted`;
test('native submitted seat code is decoded instead of page-wide seat labels or inventory', () => {
  assert.deepEqual(submittedSeatNames(pax('O')), ['二等座']);
  assert.deepEqual(submittedSeatNames(pax('O'), ['二等座（4）']), ['二等座']);
  assert.deepEqual(submittedSeatNames(`${pax('O')}_${pax('M')}`), ['二等座', '一等座']);
  assert.deepEqual(submittedSeatNames(pax('9')), ['商务座']);
  assert.deepEqual(submittedSeatNames(pax('1'), ['无座']), ['无座']);
  assert.equal(submittedSeatNames(pax('O'), ['商务座']), null);
  assert.equal(submittedSeatNames(pax('unknown')), null);
  assert.equal(submittedSeatNames('O,garbled'), null);
});

const task = { status: 'success', travelDate: '2026-09-28', trainNumber: 'G1509', result: { trainCode: 'G1509', seatInfo: '商务座(4)' } } as Task;
const plan = { fromStation: '南京南', toStation: '上海虹桥' } as Plan;
const order = { orderNo: 'TEST_ORDER', status: 'paid', travelDateTime: '2026-09-28 06:53', trainCode: 'G1509', fromStation: '南京南', toStation: '上海虹桥', passengers: ['测试乘车人'], seats: ['二等座 03车08A'] } as OrderRow;
test('legacy business-class summary is repaired from matching official ticket details', () => {
  const result = verifiedOrderResult(task, plan, ['测试乘车人'], [order]);
  assert.equal(result?.seatInfo, '二等座 03车08A');
  assert.equal(result?.seatInfoSource, 'order');
  assert.equal(result?.orderNo, 'TEST_ORDER');
  assert.equal(task.result?.seatInfo, '商务座(4)', 'does not mutate input');
});
test('wrong passengers, dates, train, route, missing seats and ambiguous orders cannot repair a task', () => {
  for (const changed of [{ passengers: ['其他人'] }, { travelDateTime: '2026-09-29' }, { trainCode: 'G1' }, { toStation: '安亭北' }, { seats: [] }, { status: 'refunded' }]) {
    assert.equal(verifiedOrderResult(task, plan, ['测试乘车人'], [{ ...order, ...changed } as OrderRow]), null);
  }
  assert.equal(verifiedOrderResult(task, plan, ['测试乘车人'], [order, { ...order, orderNo: 'ANOTHER' }]), null);
  assert.equal(verifiedOrderResult({ ...task, status: 'running' }, plan, ['测试乘车人'], [order]), null);
  assert.equal(verifiedOrderResult({ ...task, result: { ...task.result, orderNo: 'ANOTHER' } }, plan, ['测试乘车人'], [order]), null);
});

test('official-order synchronization corrects persisted history without changing task execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-seat-result-'));
  process.env.MY12306_DATA_DIR = dir;
  const { applySchema, seedAdmin, closeDb } = await import('../db/index.js');
  const { PlansRepo, TasksRepo, PassengersRepo } = await import('../db/repo.js');
  const { repairTaskResults } = await import('../routes/order.routes.js');
  try {
    applySchema(); seedAdmin();
    const passenger = PassengersRepo.upsert('system', { name: '测试乘车人', idTypeCode: '1', idNo: 'TEST_ONLY', passengerType: '成人', phone: null, source: 'manual' });
    PlansRepo.save({ id: 'seat-plan', userId: 'system', name: '席别回归', status: 'paused', fromStation: '南京南', toStation: '上海虹桥', dateMode: 'single', travelDate: '2026-09-28', weekday: null, weekEdge: null, weekInterval: 1, offsetDays: 0, validFrom: '2026-09-22', validUntil: null, timeFrom: null, timeTo: null, trainNumbers: ['G1509'], seatPositions: [], seatTypes: ['ZE'], allowNoSeat: false, passengerIds: [passenger.id] });
    const saved = TasksRepo.create({ userId: 'system', planId: 'seat-plan', planDateId: null, travelDate: '2026-09-28', trainNumber: 'G1509', saleAt: null, status: 'success' });
    TasksRepo.update(saved.id, { result: task.result, attempts: 2 });
    repairTaskResults('other-user', [order]);
    assert.equal(TasksRepo.get(saved.id)?.result?.seatInfo, '商务座(4)');
    repairTaskResults('system', [order]);
    const fresh = TasksRepo.get(saved.id)!;
    assert.equal(fresh.result?.seatInfo, '二等座 03车08A');
    assert.equal(fresh.result?.seatInfoSource, 'order');
    assert.equal(fresh.result?.orderNo, 'TEST_ORDER');
    assert.equal(fresh.status, 'success'); assert.equal(fresh.attempts, 2);
  } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
});
