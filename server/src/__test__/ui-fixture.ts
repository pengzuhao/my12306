/** Disposable UI test server: no scheduler, no 12306 session, no outgoing messages. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-ui-'));
process.env.MY12306_DATA_DIR = dir;
process.env.MY12306_ADMIN_USER = 'uitestadmin';
process.env.MY12306_ADMIN_PASSWORD = 'UITestOnly-12345';
const year = new Date().getFullYear();
fs.writeFileSync(path.join(dir, 'holidays.json'), JSON.stringify(Object.fromEntries([year - 1, year, year + 1].map(y => [y, process.env.UI_TEST_PLAN_CALENDAR ? { [`${y}-10-01`]: {name:'国庆节',isOffDay:true}, [`${y}-09-20`]: {name:'调休',isOffDay:false} } : {}]))));
const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { default: staticFiles } = await import('@fastify/static');
const { applySchema, seedAdmin, closeDb } = await import('../db/index.js');
const { planRoutes } = await import('../routes/plan.routes.js');
const { PassengersRepo, TasksRepo, PlansRepo } = await import('../db/repo.js');
const { registerAuth } = await import('../routes/auth.routes.js');
const { logRoutes } = await import('../routes/log.routes.js');
const { notificationRoutes } = await import('../routes/notification.routes.js');
const { migrateNotifications } = await import('../notify/channels.js');
const { getDb } = await import('../db/index.js');
const { Logger } = await import('../logger.js');
applySchema(); seedAdmin(); migrateNotifications();
new Logger('notify', 'system').info('测试通道发送成功', { token: 'TEST_REDACTED', taskId: 'demo-task' });
new Logger('bot', 'system').warn('测试计划等待登录');
getDb().prepare("INSERT INTO notification_channels (id,user_id,name,type,config,enabled,events) VALUES ('ui-feishu','system','测试飞书通道','feishu',?,1,?)").run(JSON.stringify({webhookUrl:'https://open.feishu.cn/hook/DEMO',secret:'DEMO_ONLY'}),JSON.stringify(['order_success','task_failed']));
PassengersRepo.upsert('system', { name: '测试乘车人', idTypeCode: '1', idNo: 'UI_TEST_ONLY', phone: null, passengerType: '成人', source: 'manual' });
if (process.env.UI_TEST_TRAIN_VARIANTS) {
  const { today, addDays } = await import('../calendar/holidays.js');
  PlansRepo.save({ id: 'variants', userId: 'system', name: '同车次区间测试', status: 'paused', fromStation: '南京', toStation: '上海', dateMode: 'single', travelDate: addDays(today(), 1), weekday: null, weekEdge: null, weekInterval: 1, offsetDays: 0, validFrom: today(), validUntil: null, timeFrom: '08:00', timeTo: '09:00', trainNumbers: null, trainSegments: [], seatPositions: [], seatTypes: ['ZE'], allowNoSeat: false, passengerIds: PassengersRepo.list('system').map(p => p.id) });
}
if (process.env.UI_TEST_PLAN_CALENDAR) {
  const { today, addDays } = await import('../calendar/holidays.js');
  const { PlanDatesRepo } = await import('../db/repo.js');
  const base = today();
  PlansRepo.save({ id: 'calendar-demo', userId: 'system', name: '下班（日历测试）', status: 'paused', fromStation: '上海', toStation: '南京', dateMode: 'recurring', travelDate: null, weekday: 5, weekEdge: null, weekInterval: 1, offsetDays: 0, validFrom: base, validUntil: null, timeFrom: '18:00', timeTo: '20:00', trainNumbers: null, seatPositions: [], seatTypes: ['ZE'], allowNoSeat: false, passengerIds: [] });
  const entries = [1, 3, 8, 15, 22, 29].map(n => ({ travelDate: addDays(base,n), originalDate: addDays(base,n), postponed: false, weekday: 5 }));
  PlanDatesRepo.replaceForPlan('calendar-demo', entries);
  for (const [i,e] of entries.entries()) {
    if (i > 2) continue;
    const task = TasksRepo.create({ planId:'calendar-demo', userId:'system', planDateId:null, travelDate:e.travelDate, trainNumber:'G76', saleAt:base+'T00:00:00Z', status:i===0?'failed':i===1?'success':'pending' });
    if (i===1) TasksRepo.update(task.id,{result:{trainCode:'G76',seatInfo:'二等座',seatInfoSource:'order',paid:false,orderNo:'UI_UNPAID_ONLY'}});
  }
}
const app = Fastify();
let seatResultVerified = false;
let taskProgressReads = 0;
registerAuth(app);
await app.register(websocket);
app.get('/ws', { websocket: true }, socket => socket.send(JSON.stringify({ type: 'status', payload: { connected: true } })));
app.addHook('onRequest', async (request, reply) => {
  if (process.env.UI_TEST_PLAN_CALENDAR && request.method === 'POST' && request.url.endsWith('/cancel-and-skip')) {
    const taskId = request.url.split('/')[5];
    const { cancelPlanOrderAndSkip } = await import('../plans/cancel-order.js');
    await cancelPlanOrderAndSkip('system','calendar-demo',taskId,async (_user,_target,begin) => { begin(); });
    return reply.send({ok:true});
  }
  if (process.env.UI_TEST_TASK_PROGRESS && request.url === '/api/plans/detail-demo/dates') {
    const interrupted = ++taskProgressReads > 1;
    return reply.send([{ travelDate: '2026-09-24', originalDate: '2026-09-24', weekday: 4, postponed: false, isWorkday: true, estimatedSaleDate: '2026-09-10', task: {
      id: 'progress-demo', travelDate: '2026-09-24', trainNumber: 'G76', saleAt: '2026-09-10T00:00:00Z', status: interrupted ? 'failed' : 'running',
      error: interrupted ? '执行中断：服务已重启，请先核对 12306 订单；确认未购票后再重试' : null, result: null,
    } }]);
  }
  if (process.env.UI_TEST_PLAN_DETAIL) {
    if (request.url === '/api/plans') return reply.send([{ id: 'detail-demo', name: '上班（离线测试）', status: 'active', fromStation: '南京南', toStation: '上海虹桥', dateMode: 'workweek', weekEdge: 'start', weekInterval: 1, offsetDays: 0, validFrom: '2026-09-22', passengerIds: [], seatTypes: ['ZE'] }]);
    if (request.url === '/api/plans/detail-demo/dates') return reply.send([
      { travelDate: '2026-09-28', originalDate: '2026-09-28', weekday: 1, postponed: false, isWorkday: true, estimatedSaleDate: '2026-09-14', task: process.env.UI_TEST_SEAT_RESULT ? { id: 'seat-demo', status: 'success', result: seatResultVerified ? { trainCode: 'G1509', seatInfo: '二等座 03车08A', seatInfoSource: 'order', orderNo: 'TEST_ORDER' } : { trainCode: 'G1509', seatInfo: '商务座(4)' } } : null },
      { travelDate: '2026-10-08', originalDate: '2026-10-05', weekday: 4, postponed: true, isWorkday: true, estimatedSaleDate: '2026-09-24', task: null },
    ]);
    if (process.env.UI_TEST_SEAT_RESULT && request.url === '/api/orders') {
      seatResultVerified = true;
      return reply.send({ orders: [], fetchedAt: Date.now() });
    }
  }
  if (request.url.startsWith('/api/notifications/') && request.url.endsWith('/test')) return reply.send({ ok: true });
  if (request.url.startsWith('/api/stations')) return reply.send([{ name: '南京南' }, { name: '上海虹桥' }]);
  if (request.url.startsWith('/api/trains/search')) {
    if (process.env.UI_TRAIN_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.UI_TRAIN_DELAY_MS)));
    const date = new URL(request.url, 'http://localhost').searchParams.get('date');
    if (process.env.UI_EXPECT_TRAIN_DATE && date !== process.env.UI_EXPECT_TRAIN_DATE) return reply.code(400).send({ error: `测试发现查询日期错误：${date}` });
    if (process.env.UI_TEST_TRAIN_VARIANTS) return reply.send({ trains: [
      { trainCode: 'G7041', fromStation: '南京', toStation: '上海', departTime: '08:09', arriveTime: '10:03', duration: '01:54', seats: { 无座: '无', 二等座: '有', 一等座: '有' }, seatTypes: ['ZE', 'ZY'] },
      { trainCode: 'G7041', fromStation: '仙林', toStation: '上海', departTime: '08:21', arriveTime: '10:03', duration: '01:42', seats: { 无座: '无', 二等座: '有', 一等座: '有' }, seatTypes: ['ZE', 'ZY'] },
    ] });
    const times = ['07:59', '08:00', '08:30', '09:00', '09:01', '18:00'];
    return reply.send({ trains: Array.from({ length: Number(process.env.UI_TEST_TRAIN_COUNT) || times.length }, (_, i) => ({trainCode: 'GTEST' + i, fromStation: '南京南', toStation: '上海虹桥', departTime: times[i % times.length], arriveTime: '20:00', duration: '01:00', seats: {二等座: '有', 一等座: '6', 商务座: '无', 无座: '无'}, seatTypes: ['ZE']})) });
  }
});
await app.register(planRoutes);
app.get('/api/session', async () => ({ loggedIn: true, userName: '离线测试环境' }));
app.get('/api/tasks', async () => TasksRepo.list('system'));
const date = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Shanghai'});
app.get('/api/orders', async () => ({ orders: [
  {orderNo:'DEMO_ONLY_NOT_A_TICKET',status:'paid',statusText:'已支付',travelDateTime:date+' 09:30',trainCode:'G1234',fromStation:'南京南',toStation:'上海虹桥',passengers:['测试乘车人'],seats:['二等座 03车 08A'],totalPrice:134.5,payLimitTime:null,payLimitTs:null},
  {orderNo:'DEMO_ONLY_NOT_A_TICKET_2',status:'paid',statusText:'已支付',travelDateTime:date+' 18:30',trainCode:'G4321',fromStation:'上海虹桥',toStation:'南京南',passengers:['测试乘车人'],seats:['二等座 02车 01F'],totalPrice:134.5,payLimitTime:null,payLimitTs:null},
], fetchedAt: Date.now() }));
await app.register(logRoutes); await app.register(notificationRoutes);
app.get('/api/feishu', async () => ({ enabled: false }));
await app.register(staticFiles, { root: path.resolve('web/dist') });
await app.listen({ host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 7790) });
console.log(`Disposable UI test server: http://127.0.0.1:${process.env.UI_TEST_PORT || 7790} (no scheduler)`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close(); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
