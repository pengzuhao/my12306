import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('manual date exclusions persist across scans, restart and calendar reset, and API protects ownership and active purchases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-skip-'));
  process.env.MY12306_DATA_DIR = dir;
  process.env.MY12306_MULTI_USER = '0';
  const { default: Fastify } = await import('fastify');
  const { applySchema, seedAdmin, closeDb } = await import('../db/index.js');
  const { PlansRepo, PlanDatesRepo, PlanDateSkipsRepo, TasksRepo, UsersRepo } = await import('../db/repo.js');
  const { registerAuth } = await import('../routes/auth.routes.js');
  const { planRoutes } = await import('../routes/plan.routes.js');
  const { planDateStatus } = await import('../../../web/src/utils/plan-status.js');
  const app = Fastify();
  try {
    applySchema(); seedAdmin(); registerAuth(app); await app.register(planRoutes);
    const plan = { id:'skip-plan', userId:'system', name:'跳过测试', status:'active' as const, fromStation:'南京', toStation:'上海', dateMode:'single' as const, travelDate:'2099-01-01', weekday:null, weekEdge:null, weekInterval:1, offsetDays:0, validFrom:'2026-01-01', validUntil:null, timeFrom:null, timeTo:null, trainNumbers:null, seatPositions:[], seatTypes:['ZE'], allowNoSeat:false, passengerIds:[] };
    PlansRepo.save(plan);
    const dates = ['2099-01-01','2099-01-02','2099-01-03','2099-01-04'].map(travelDate => ({travelDate,originalDate:travelDate,postponed:false,weekday:1}));
    PlanDatesRepo.replaceForPlan(plan.id,dates);
    const tasks = ['queued','queried','running','success'].map((status,i) => TasksRepo.create({planId:plan.id,userId:'system',planDateId:null,travelDate:dates[i].travelDate,trainNumber:null,saleAt:'2020-01-01T00:00:00Z',status:status as 'queued'}));
    const skip = (date:string, skipped=true, id=plan.id) => app.inject({method:'PUT',url:`/api/plans/${id}/dates/${date}/skip`,payload:{skipped}});
    assert.equal((await skip(dates[0].travelDate)).statusCode,200);
    assert.equal(TasksRepo.get(tasks[0].id)?.status,'skipped');
    assert.equal((await skip(dates[1].travelDate)).statusCode,200);
    assert.equal(TasksRepo.listDue(new Date().toISOString()).length,0);
    PlanDatesRepo.replaceForPlan(plan.id,dates);
    TasksRepo.resetForYear(2099); applySchema();
    assert.equal(PlanDateSkipsRepo.has(plan.id,dates[0].travelDate),true);
    assert.equal(TasksRepo.listPending().length,0);
    assert.equal((await app.inject({method:'POST',url:`/api/plans/${plan.id}/tasks/${tasks[0].id}/retry`})).statusCode,409);
    const rows = (await app.inject(`/api/plans/${plan.id}/dates`)).json();
    assert.equal(rows[0].manuallySkipped,true);
    assert.equal(planDateStatus(rows[0],'active',true),'手动跳过');
    for (const i of [2,3]) assert.equal((await skip(dates[i].travelDate)).statusCode,409);
    assert.equal((await skip(dates[0].travelDate,false)).statusCode,200);
    assert.equal(TasksRepo.get(tasks[0].id)?.status,'pending');
    assert.equal(TasksRepo.listPending().length,1);
    // Far-future dates can be skipped before their task is created.
    PlanDatesRepo.replaceForPlan(plan.id,[...dates,{travelDate:'2099-02-01',originalDate:'2099-02-01',postponed:false,weekday:1}]);
    assert.equal((await skip('2099-02-01')).statusCode,200);
    closeDb(); applySchema();
    assert.equal(PlanDateSkipsRepo.has(plan.id,'2099-02-01'),true);
    assert.equal((await skip('2020-01-01')).statusCode,409);
    assert.equal((await skip('2099-02-30')).statusCode,400);
    const other = UsersRepo.create('other-skip','unused','user','Other');
    PlansRepo.save({...plan,id:'other-plan',userId:other.id});
    assert.equal((await skip('2099-01-01',true,'other-plan')).statusCode,404);
  } finally { await app.close(); closeDb(); fs.rmSync(dir,{recursive:true,force:true}); }
});
