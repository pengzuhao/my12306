import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';
import { inspectSession, confirmedInvalid } from '../bot/session-check.js';

test('only an explicit false flag means logged out; transport errors remain unknown', async () => {
 for (const [response, expected] of [
  [{ok:true,status:200,body:'{"data":{"flag":true}}'},'active'],
  [{ok:true,status:200,body:'{"data":{"flag":false}}'},'invalid'],
  [{ok:false,status:503,body:''},'unknown'],
  [{ok:true,status:200,body:'<html>login</html>'},'unknown'],
  [{ok:true,status:200,body:'{}'},'unknown'],
  [null,'unknown'],
 ] as const) {
  let closed=false;
  const context={newPage:async()=>({goto:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>{if(!response)throw new Error('network');return response;},close:async()=>{closed=true;}})} as unknown as BrowserContext;
  assert.equal((await inspectSession(context)).status,expected);
  assert.ok(closed);
 }
});
test('invalidating requires consecutive explicit failures, with recovery and network failures resetting the count', () => {
 const invalid={status:'invalid',reason:'not logged in'} as const;
 assert.equal(confirmedInvalid(0,invalid),1);
 assert.equal(confirmedInvalid(1,invalid),2);
 assert.equal(confirmedInvalid(1,{status:'unknown',reason:'offline'}),0);
 assert.equal(confirmedInvalid(2,{status:'active',reason:'ok'}),0);
});
