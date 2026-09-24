import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';
import { personalOrders, mergePersonalOrders, fetchPersonalOrders } from '../bot/personal-orders.js';
import { normalizeOrders } from '../bot/orders.js';
const ticket={sequence_no:'TEST',start_date:'20260928',start_time:'06:53',train_code:'G1509',from_station_name:'南京南',to_station_name:'上海虹桥',passenger_name:'测试乘客',ticket_price:790,status_name:'a',seat_type_name:'二等座',coach_no:'08',seat_name:'04F号'};
test('personal tickets include tickets purchased by others and use tenths of yuan',()=>{
 const rows=normalizeOrders(personalOrders([ticket]),[]);
 assert.equal(rows.length,1);assert.equal(rows[0].totalPrice,79);
 assert.equal(rows[0].travelDateTime,'2026-09-28 06:53');assert.equal(rows[0].personalOnly,true);
 assert.equal(rows[0].refundTickets[0].batchNo,'');
});
test('owned tickets are not counted twice and other passengers and journeys remain',()=>{
 const own=personalOrders([ticket]);own[0].tickets![0].personalOnly=false;
 const rows=normalizeOrders(mergePersonalOrders(own,personalOrders([ticket,ticket,{...ticket,passenger_name:'另一乘客'},{...ticket,sequence_no:'OTHER'}])),[]);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.orderNo==='TEST')?.totalPrice,158);
 assert.equal(rows.find(r=>r.orderNo==='TEST')?.passengers.length,2);
});
test('personal query follows official pagination and distinguishes verification failures from empty results',async()=>{
 const pages:number[]=[];
 const context={request:{post:async(_url:string,options:{form:{pageIndex:number}})=>{pages.push(options.form.pageIndex);return {ok:()=>true,json:async()=>({status:true,messages:[],data:{psr:{total:2,results:[{...ticket,sequence_no:String(options.form.pageIndex)}]}}})};}}} as unknown as BrowserContext;
 assert.equal((await fetchPersonalOrders(context)).length,2);assert.deepEqual(pages,[1,2]);
 for(const response of [{status:false,messages:['verify']},{status:true,data:{psr:{total:1,results:[]}}}]){
  const bad={request:{post:async()=>({ok:()=>true,json:async()=>response})}} as unknown as BrowserContext;
  await assert.rejects(fetchPersonalOrders(bad));
 }
});

test('superseded personal tickets do not appear as current paid journeys',()=>{
 assert.equal(personalOrders([{...ticket,status_name:'d'},{...ticket,status_name:'e'},{...ticket,status_name:'l'}]).length,0);
 assert.equal(personalOrders([{...ticket,status_name:'g'}]).length,1);
});
