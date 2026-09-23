import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCancelableOrder, CancellationRejected, cancelUnpaidOrder } from '../bot/cancel-order.js';
import type { Page } from 'playwright';
const target = {orderNo:'TEST_ORDER',travelDate:'2099-01-01',trainCode:'G76',passengers:['测试乘车人']};
const ticket = {train_date:'2099-01-01',ticket_status_name:'待支付',passenger_name:'测试乘车人',stationTrainDTO:{station_train_code:'G76'}};
test('only an exact wholly unpaid order may be cancelled', () => {
  assert.doesNotThrow(() => assertCancelableOrder([{sequence_no:target.orderNo,tickets:[ticket]}],target));
  for (const changed of [{...ticket,ticket_status_name:'已支付'}, {...ticket,passenger_name:'其他人'}, {...ticket,train_date:'2099-01-02'}, {...ticket,stationTrainDTO:{station_train_code:'G77'}}]) {
    assert.throws(() => assertCancelableOrder([{sequence_no:target.orderNo,tickets:[changed]}],target),CancellationRejected);
  }
  assert.throws(() => assertCancelableOrder([{sequence_no:target.orderNo,tickets:[ticket,ticket]}],target));
  assert.throws(() => assertCancelableOrder([],target));
});
test('cancellation requires explicit official success and never retries a mutation', async () => {
  let calls=0;
  const page = (response: unknown) => ({evaluate:async () => {calls++;return response;}}) as unknown as Page;
  await cancelUnpaidOrder(page({status:true,data:{existError:'N'}}),target.orderNo);
  await assert.rejects(cancelUnpaidOrder(page({status:true,data:{existError:'Y'}}),target.orderNo),CancellationRejected);
  await assert.rejects(cancelUnpaidOrder(page({status:false}),target.orderNo),CancellationRejected);
  await assert.rejects(cancelUnpaidOrder(page({status:true}),target.orderNo));
  assert.equal(calls,4);
});
test('cancel-and-skip commits only on confirmation, blocks uncertain retries across restart, and rejects paid orders', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'my12306-cancel-'));
  process.env.MY12306_DATA_DIR=dir; process.env.MY12306_MULTI_USER='0';
  const {applySchema,seedAdmin,closeDb}=await import('../db/index.js');
  const {PlansRepo,TasksRepo,PlanDateSkipsRepo}=await import('../db/repo.js');
  const {cancelPlanOrderAndSkip}=await import('../plans/cancel-order.js');
  try {
    applySchema();seedAdmin();
    PlansRepo.save({id:'cancel-plan',userId:'system',name:'取消测试',status:'active',fromStation:'南京',toStation:'上海',dateMode:'single',travelDate:target.travelDate,weekday:null,weekEdge:null,weekInterval:1,offsetDays:0,validFrom:'2026-01-01',validUntil:null,timeFrom:null,timeTo:null,trainNumbers:null,seatPositions:[],seatTypes:['ZE'],allowNoSeat:false,passengerIds:[]});
    const task=TasksRepo.create({planId:'cancel-plan',userId:'system',planDateId:null,travelDate:target.travelDate,trainNumber:'G76',saleAt:'2020-01-01T00:00:00Z',status:'success'});
    TasksRepo.update(task.id,{result:{orderNo:target.orderNo,trainCode:'G76',paid:false,passengers:target.passengers}});
    await assert.rejects(cancelPlanOrderAndSkip('system','cancel-plan',task.id,async (_u,_t,begin) => {begin();throw new CancellationRejected('拒绝');}));
    assert.equal(PlanDateSkipsRepo.has('cancel-plan',target.travelDate),false);
    assert.equal(TasksRepo.get(task.id)?.status,'success');
    await assert.rejects(cancelPlanOrderAndSkip('system','cancel-plan',task.id,async (_u,_t,begin) => {begin();throw new Error('network timeout');}),/待核实/);
    closeDb();applySchema();
    assert.equal(PlanDateSkipsRepo.cancelling('cancel-plan',target.travelDate),true);
    TasksRepo.update(task.id,{status:'queried'});
    assert.equal(TasksRepo.listDue(new Date().toISOString()).length,0);
    TasksRepo.update(task.id,{status:'success'});
    assert.throws(()=>PlanDateSkipsRepo.set('cancel-plan',target.travelDate,false),/待核实/);
    await cancelPlanOrderAndSkip('system','cancel-plan',task.id,async (_u,t,begin,verify) => {assert.equal(verify,true);assert.deepEqual(t,target);begin();});
    assert.equal(PlanDateSkipsRepo.cancelling('cancel-plan',target.travelDate),false);
    assert.equal(PlanDateSkipsRepo.has('cancel-plan',target.travelDate),true);
    assert.equal(TasksRepo.get(task.id)?.status,'skipped');
    await cancelPlanOrderAndSkip('system','cancel-plan',task.id,async()=>{throw new Error('duplicate mutation');});
    PlanDateSkipsRepo.set('cancel-plan',target.travelDate,false);
    assert.equal(TasksRepo.get(task.id)?.status,'pending');
    TasksRepo.update(task.id,{status:'success',result:{orderNo:target.orderNo,paid:true}});
    await assert.rejects(cancelPlanOrderAndSkip('system','cancel-plan',task.id,async()=>{throw new Error('must not run');}),/仅支持/);
  } finally {closeDb();fs.rmSync(dir,{recursive:true,force:true});}
});
