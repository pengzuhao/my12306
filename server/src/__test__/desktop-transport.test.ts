import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { attachDesktopTransport } from '../desktop-transport.js';
import { wsHub } from '../ws/hub.js';

test('desktop API and user-scoped events work without listening', async () => {
  const app = Fastify();
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/echo', async request => ({ body: request.body, query: request.query }));
  const bytes = Buffer.from([0, 128, 255, 1]);
  app.get('/api/export', async (_request, reply) => reply.header('content-type', 'application/octet-stream').send(bytes));
  app.get('/api/failure', async (_request, reply) => reply.code(409).send({ error: 'conflict' }));
  const port = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void };
  const messages = new EventEmitter();
  port.postMessage = message => messages.emit(message.type, message);
  const detach = await attachDesktopTransport(app, port, 'system');
  let id = 0;
  const request = (fields: object): Promise<any> => new Promise(resolve => {
    messages.once('response', resolve);
    port.emit('message', { data: { type: 'request', id: ++id, method: 'GET', ...fields } });
  });
  try {
    assert.equal(app.server.listening, false);
    assert.equal(app.server.address(), null);
    assert.equal((await request({ url: '/api/health' })).status, 200);
    const posted = await request({ method: 'POST', url: '/api/echo?keyword=%E8%BD%A6%E7%A5%A8', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"name":"上班"}') });
    assert.deepEqual(JSON.parse(posted.body), { body: { name: '上班' }, query: { keyword: '车票' } });
    for (const body of [undefined, new Uint8Array(0)]) {
      for (const type of ['application/x-www-form-urlencoded', 'application/json', undefined]) {
        const headers = type ? { 'Content-Type': type, 'Content-Length': '0' } : {};
        const empty = await request({ method:'POST', url:'/api/echo', headers, body });
        assert.equal(empty.status,200,`bodyless action must reach the route: ${empty.body}`);
        assert.deepEqual(JSON.parse(empty.body),{query:{}});
      }
    }
    assert.equal((await request({method:'POST',url:'/api/echo',headers:{'content-type':'application/x-www-form-urlencoded'},body:Buffer.from('name=test')})).status,415,'nonempty unsupported content must still be rejected');
    assert.deepEqual((await request({ url: '/api/export' })).body, bytes);
    assert.equal((await request({ url: '/api/failure' })).status, 409);
    assert.equal((await request({ url: '//evil.test/api/health' })).status, 500);
    assert.equal((await request({ method: 'POST', url: '/api/echo', body: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413);
    const events: any[] = [];
    messages.on('event', event => events.push(event.message));
    wsHub.broadcastToUser('other', { type: 'session', payload: 'private' });
    assert.equal(events.length, 0);
    for (const type of ['qr_code', 'session', 'task', 'log'] as const) wsHub.broadcastToUser('system', { type, payload: { ok: true } });
    assert.deepEqual(events.map(e => e.type), ['qr_code', 'session', 'task', 'log']);
    detach();
    wsHub.broadcastToUser('system', { type: 'task', payload: {} });
    assert.equal(events.length, 4);
    assert.equal(app.server.listening, false);
  } finally { detach(); await app.close(); }
});
