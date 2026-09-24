import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFromOrders, queryPurchasedTickets, type PurchasedTicket } from '../bot/reconcile.js';
import type { BrowserContext } from 'playwright';

test('repeated reconciliation finds the paid ticket by date despite its departure time', () => {
 for (let cycle=0;cycle<3;cycle++) {
  const map=new Map<string,PurchasedTicket>();
  collectFromOrders([{sequence_no:'TEST_PAID',tickets:[{start_train_date_page:'2026-09-28 06:53',train_date:'2026-09-27 00:00:00',stationTrainDTO:{station_train_code:'G1509',from_station_name:'上海虹桥',to_station_name:'武汉'},ticket_status_name:'已支付'}]}],map,false);
  assert.equal(map.get('20260928|G1509|上海虹桥|武汉')?.status,'paid');
  assert.ok([...map.keys()].some(key=>key.startsWith('20260928|')));
  assert.ok(![...map.keys()].some(key=>key.startsWith('20260927|')));
 }
});

test('refunded and changed-away tickets are not treated as still purchased', () => {
 const map=new Map<string,PurchasedTicket>();
 collectFromOrders([{sequence_no:'TEST',tickets:[
  {start_train_date_page:'2026-09-28 06:53',stationTrainDTO:{station_train_code:'G1509'},ticket_status_name:'已退票'},
  {start_train_date_page:'2026-09-28 08:00',stationTrainDTO:{station_train_code:'G1510'},ticket_status_name:'已变更到站'},
  {start_train_date_page:'2026-09-28 09:00',stationTrainDTO:{station_train_code:'G1511'},ticket_status_name:'变更到站票'},
 ]}],map,false);
 assert.equal([...map.keys()].some(key=>key.startsWith('20260928|G1509|')),false);
 assert.equal([...map.keys()].some(key=>key.startsWith('20260928|G1510|')),false);
 assert.equal([...map.values()][0]?.status,'paid');
});

test('two segments of the same train on the same day stay distinct', () => {
 const map=new Map<string,PurchasedTicket>();
 collectFromOrders([{sequence_no:'A',tickets:[{start_train_date_page:'2026-09-28 13:06',stationTrainDTO:{station_train_code:'K1107',from_station_name:'上海',to_station_name:'南京'},ticket_status_name:'已支付'}]}],map,false);
 collectFromOrders([{sequence_no:'B',tickets:[{start_train_date_page:'2026-09-28 16:20',stationTrainDTO:{station_train_code:'K1107',from_station_name:'南京',to_station_name:'信阳'},ticket_status_name:'已支付'}]}],map,false);
 assert.equal(map.size,2);
 assert.equal(map.get('20260928|K1107|上海|南京')?.orderNo,'A');
 assert.equal(map.get('20260928|K1107|南京|信阳')?.orderNo,'B');
});

test('incomplete order snapshots never authorize a reconciliation rollback', async () => {
 for (const failed of ['complete','incomplete','empty','invalid','none']) {
  let closed=false;
  const page={goto:async()=>{},waitForTimeout:async()=>{},url:()=> 'https://kyfw.12306.cn/otn/queryOrder/init',close:async()=>{closed=true;},evaluate:async (_:unknown,args:{u:string})=>{
   const incomplete=args.u.includes('queryMyOrderNoComplete');
   if ((failed==='incomplete' && incomplete)||(failed==='complete' && !incomplete)) throw new Error('offline');
   if (failed==='empty') return '';
   if (failed==='invalid') return JSON.stringify({status:false});
   return JSON.stringify({status:true,data:incomplete?{orderDBList:[]}:{OrderDTODataList:[]}});
  }};
  const result=await queryPurchasedTickets({newPage:async()=>page} as unknown as BrowserContext);
  assert.equal(result===null,failed!=='none');
  assert.ok(closed);
 }
});
