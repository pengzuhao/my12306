/** Offline API integration tests. No scheduler, browser, real orders or notifications. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-regression-'));
process.env.MY12306_DATA_DIR = dir;
// Only public holiday fixtures; never copy accounts, contacts or browser profiles.
const y = new Date().getFullYear();
fs.writeFileSync(path.join(dir, 'holidays.json'), JSON.stringify(Object.fromEntries([y - 1, y, y + 1, y + 2].map(year => [year, {}]))));
const { default: Fastify } = await import('fastify');
const { applySchema, seedAdmin, closeDb } = await import('../db/index.js');
const { planRoutes } = await import('../routes/plan.routes.js');
const { PassengersRepo, PlansRepo, TasksRepo, PlanDatesRepo } = await import('../db/repo.js');
const { parseTrainRow, seatCount, queryTrains } = await import('../bot/tickets.js');
const { pickTrain } = await import('../bot/order.js');
const { trainQueryErrorMessage } = await import('../bot/train-query-error.js');
const { trainSearchErrorMessage } = await import('../../../web/src/utils/train-query-error.js');
const { resolvePlanSearchTarget } = await import('../../../web/src/utils/plan-search-date.js');
const { isExpired } = await import('../scheduler/scheduler.js');
const { filterDepartureRange } = await import('../../../web/src/utils/train-filter.js');
const { todayCn, isPastDate } = await import('../../../web/src/utils/time.js');
const { today, addDays } = await import('../calendar/holidays.js');
const app = Fastify();
let checks = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); }
try {
  applySchema(); seedAdmin(); await app.register(planRoutes);
  const p = PassengersRepo.upsert('system', { name: '测试乘车人', idTypeCode: '1', idNo: 'TEST_ONLY', phone: null, passengerType: '成人', source: 'manual' });
  const form = { name: '接口回归', fromStation: '南京南', toStation: '上海虹桥', dateMode: 'single', travelDate: addDays(today(), 1), validFrom: today(), seatTypes: ['ZE'], passengerIds: [p.id] };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const created = await post('/api/plans', form);
  check(created.statusCode === 200, 'create valid plan');
  const id = created.json().id;
  await post(`/api/plans/${id}/status`, { status: 'paused' });
  const edited = await post('/api/plans', { ...form, id, name: '编辑后仍暂停' });
  check(edited.json().status === 'paused', 'editing a paused plan preserves its status');
  check((await post('/api/plans', { ...form, id: 'missing' })).statusCode === 404, 'unknown edit id cannot create or overwrite a plan');
  for (const [patch, label] of [
    [{ travelDate: '2026-02-30' }, 'impossible date'],
    [{ travelDate: 'not-a-date' }, 'malformed date'],
    [{ travelDate: addDays(today(), -1) }, 'past date'],
    [{ toStation: '南京南' }, 'same station'],
    [{ timeFrom: '09:00', timeTo: '08:00' }, 'reversed time range'],
    [{ timeFrom: '24:10' }, 'invalid time'],
    [{ dateMode: 'recurring', weekday: 1, validUntil: addDays(today(), -1) }, 'reversed date range'],
    [{ passengerIds: ['missing'] }, 'missing passenger'],
  ] as const) {
    const res = await post('/api/plans', { ...form, ...patch });
    check(res.statusCode === 400 && res.json().error !== '参数错误', `reject ${label} with a readable error`);
  }
  const preview = await post('/api/plans/preview-dates', { dateMode: 'single', travelDate: form.travelDate, validFrom: today() });
  check(preview.statusCode === 200 && preview.json()[0].travelDate === form.travelDate, 'date preview needs no name, station or passenger');
  check((await post(`/api/plans/${id}/status`, { status: 'bad' })).statusCode === 400, 'invalid status returns 400, not 500');
  const task = TasksRepo.create({ userId: 'system', planId: id, planDateId: null, travelDate: form.travelDate, trainNumber: null, saleAt: '2026-09-22T08:00:00+08:00', status: 'queried' });
  check(!isExpired({ ...task, travelDate: today() }, { ...PlansRepo.get(id)!, timeFrom: '00:00', timeTo: '23:59' }), 'today remains bookable until the end of the time window');
  check(!isExpired({ ...task, travelDate: today(), saleAt: '2020-01-01T00:00:00Z' }, { ...PlansRepo.get(id)!, timeFrom: null, timeTo: null }), 'old sale time does not mean the train has departed');
  check(todayCn(new Date('2026-09-21T16:01:00Z')) === '2026-09-22', 'Beijing date advances before UTC midnight');
  const [year, month, day] = todayCn().split('-').map(Number);
  check(!isPastDate(new Date(year, month - 1, day)) && isPastDate(new Date(year, month - 1, day - 1)), 'date picker enables today and disables yesterday');
  check(TasksRepo.listDue('2026-09-22T00:00:01Z').length === 0, 'paused plans do not trigger queued purchases');
  PlansRepo.setStatus(id, 'active');
  check(TasksRepo.listDue('2026-09-22T00:00:01Z').some(t => t.id === task.id), 'sale times compare instants across UTC and +08:00');
  TasksRepo.update(task.id, { status: 'success' });
  check((await post(`/api/plans/${id}/tasks/${task.id}/retry`, {})).statusCode === 409, 'successful purchase cannot be retried');
  TasksRepo.update(task.id, { status: 'failed' });
  check((await post(`/api/plans/${id}/tasks/${task.id}/retry`, {})).statusCode === 200, 'failed future task can be retried');
  PlanDatesRepo.replaceForPlan(id, []);
  check(TasksRepo.get(task.id)?.status === 'skipped', 'recomputed dates remove outdated queued tasks');
  PlanDatesRepo.replaceForPlan(id, [{ travelDate: task.travelDate, originalDate: task.travelDate, weekday: 1, postponed: false }]);
  check(TasksRepo.get(task.id)?.status === 'pending' && TasksRepo.get(task.id)?.saleAt === null, 'reintroduced dates requeue only tasks skipped by date recomputation');
  TasksRepo.update(task.id, { status: 'success' });
  PlanDatesRepo.replaceForPlan(id, []);
  check(TasksRepo.get(task.id)?.status === 'success', 'date recomputation preserves completed purchases');
  PlansRepo.setStatus(id, 'deleted');
  check(TasksRepo.listDue(new Date(Date.now() + 60_000).toISOString()).length === 0, 'deleted plans do not trigger purchases');
  check((await post('/api/plans', { ...form, id })).statusCode === 404, 'deleted plans cannot be resurrected by an old form');
  for (const url of ['/api/trains/search?from=A&to=B&date=2026-02-30', '/api/trains/search?from=A&to=A&date=' + today(), '/api/calendar/holidays?year=999999']) {
    check((await app.inject(url)).statusCode === 400, `reject invalid query ${url}`);
  }
  const departureRows = ['07:59', '08:00', '08:30', '09:00', '09:01'].map(departTime => ({ departTime }));
  check(filterDepartureRange(departureRows, '08:00', '09:00').map(t => t.departTime).join(',') === '08:00,08:30,09:00', 'departure window includes both boundaries and excludes outside trains');
  check(filterDepartureRange(departureRows, null, '08:00').length === 2 && filterDepartureRange(departureRows, '09:00', null).length === 2, 'one-sided departure windows work');
  check(filterDepartureRange(departureRows, null, null).length === 5 && filterDepartureRange(departureRows, '10:00', '11:00').length === 0, 'cleared and empty departure windows work');
  // Fixture indices independently copied from official queryLeftTicket_end_js.js (2026-09-22).
  const fields = Array(40).fill('');
  Object.assign(fields, { 3: 'G25', 6: 'NKH', 7: 'AOH', 8: '20:16', 9: '21:18', 10: '01:02', 17: '03', 26: '无', 30: '有', 31: '5', 32: '无' });
  const train = parseTrainRow(fields.join('|'))!;
  const mainStation = { ...train, trainCode: 'G7041', fromStation: '南京', toStation: '上海', departTime: '08:09' };
  const otherStation = { ...mainStation, fromStation: '仙林', departTime: '08:21' };
  const segment = { trainCode: 'G7041', fromStation: '仙林', toStation: '上海' };
  const params = { trainDate: form.travelDate, fromStation: '南京', toStation: '上海', trainNumbers: ['G7041'], trainSegments: [segment], seatTypes: ['ZE'], passengers: [] };
  check(pickTrain([mainStation, otherStation], params)?.fromStation === '仙林', 'same train code only matches the selected boarding station');
  check(pickTrain([mainStation], params) === null, 'missing selected segment cannot silently fall back to another station');
  const scoped = await post('/api/plans', { ...form, trainNumbers: ['G7041'], trainSegments: [segment] });
  check(scoped.statusCode === 200 && PlansRepo.get(scoped.json().id)?.trainSegments?.[0].fromStation === '仙林', 'selected route persists through API and database');
  const unscoped = await post('/api/plans', { ...form, id: scoped.json().id, trainNumbers: [], trainSegments: [segment] });
  check(unscoped.json().trainSegments.length === 0, 'removing a train also removes its route restriction');
  const future = addDays(today(), 30);
  const notOnSale = await app.inject(`/api/trains/search?from=A&to=B&date=${future}`);
  check(notOnSale.statusCode === 400 && notOnSale.json().code === 'NOT_ON_SALE', 'future inventory query is rejected before browser or login access');
  await assert.rejects(queryTrains({ newPage() { throw new Error('must not open browser'); } } as never, { trainDate: future, fromStation: '南京', toStation: '上海' }), /尚未开售/);
  check(true, 'bot also guards dates beyond the presale window');
  const rawError = 'page.evaluate: TypeError: Failed to fetch at <anonymous>';
  check(!trainQueryErrorMessage(new Error(rawError)).includes('page.evaluate') && !trainSearchErrorMessage({ response: { data: { error: rawError } } }).includes('page.evaluate'), 'network failures do not expose browser stacks');
  const target = { travelDate: future, estimatedSaleDate: addDays(future, -14) };
  assert.deepEqual(await resolvePlanSearchTarget({ ...form } as never, async () => [target]), target);
  check(true, 'single-date picker uses server preview and its presale estimate');
  assert.deepEqual(train.seats, { 无座: '无', 二等座: '有', 一等座: '5', 商务座: '无' });
  check(!('硬卧' in train.seats) && !('其他' in train.seats), 'high speed seat fields do not expose metadata as sleeper inventory');
  const sleeper = Array(40).fill('');
  Object.assign(sleeper, { 21: '1', 22: '2', 23: '3', 24: '4', 25: '5', 26: '6', 28: '7', 29: '8', 30: '9', 31: '10', 32: '11' });
  assert.deepEqual(parseTrainRow(sleeper.join('|'))!.seats, { 高级软卧: '1', 其他: '2', 软卧: '3', 软座: '4', 特等座: '5', 无座: '6', 硬卧: '7', 硬座: '8', 二等座: '9', 一等座: '10', 商务座: '11' });
  check(parseTrainRow('short|row') === null, 'truncated inventory is rejected');
  check(seatCount('*') === 0 && seatCount('有') > 0 && seatCount('无') === 0, 'unknown inventory is not purchasable');
  console.log(`\n${checks} regression checks passed.`);
} finally {
  await app.close(); closeDb(); fs.rmSync(dir, { recursive: true, force: true });
}
