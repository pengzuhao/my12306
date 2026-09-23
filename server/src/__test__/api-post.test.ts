import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { http, sessionApi, planApi } from '../../../web/src/api/index.js';

test('bodyless actions send valid JSON, while explicit JSON payloads remain intact', async () => {
  const app=Fastify();
  const seen: string[]=[];
  app.post('/*',async req => { seen.push(req.url); return { body:req.body, contentType:req.headers['content-type'] }; });
  const previous=http.defaults.adapter;
  http.defaults.adapter=async config => {
    const response=await app.inject({method:'POST',url:config.url!,headers:config.headers.toJSON() as Record<string,string>,payload:config.data});
    assert.equal(response.statusCode,200,response.body);
    return {data:response.json(),status:response.statusCode,statusText:'OK',headers:response.headers,config};
  };
  try {
    for (const action of [sessionApi.syncPassengers,sessionApi.check,sessionApi.logout,()=>planApi.retryTask('plan','task'),()=>http.post('/auth/logout').then(r=>r.data),()=>http.post('/notifications/test/test').then(r=>r.data)]) {
      const response=await action() as any;
      assert.deepEqual(response.body,{});
      assert.match(response.contentType,/application\/json/);
    }
    const payload={name:'下班',trainNumbers:['G7028']};
    assert.deepEqual((await http.post('/plans',payload)).data.body,payload);
    assert.equal(seen.length,7);
  } finally {http.defaults.adapter=previous;await app.close();}
});
