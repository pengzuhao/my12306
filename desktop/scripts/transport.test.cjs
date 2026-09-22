const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ORIGIN, isAppUrl, createBackendClient, createProtocolHandler } = require('../src/transport.cjs');

test('custom protocol accepts only application host and blocks foreign origins', async () => {
  for (const url of ['https://app/', 'my12306://evil/', 'my12306://app:123/', 'my12306://user@app/', 'file:///tmp/test']) assert.equal(isAppUrl(url), false);
  assert.equal(isAppUrl(ORIGIN + '/#/plans'), true);
  let calls = 0;
  const handler = createProtocolHandler(async () => { calls++; return { status: 200, headers: {}, body: Buffer.from('ok') }; });
  assert.equal((await handler(new Request('my12306://evil/api/health'))).status, 403);
  assert.equal((await handler(new Request(ORIGIN + '/api/health', { headers: { origin: 'https://evil.test' } }))).status, 403);
  assert.equal(calls, 0);
});
test('protocol preserves POST, binary payload and errors; null-body responses work', async () => {
  let received;
  const handler = createProtocolHandler(async r => { received = r; return { status: 409, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 255]) }; });
  const response = await handler(new Request(ORIGIN + '/api/test?q=1', { method: 'POST', body: '{"ok":true}' }));
  assert.equal(received.url, '/api/test?q=1'); assert.equal(received.method, 'POST');
  assert.equal(Buffer.from(received.body).toString(), '{"ok":true}');
  assert.equal(response.status, 409); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255]));
  const noBody = createProtocolHandler(async () => ({ status: 204, headers: {}, body: [] }));
  assert.equal((await noBody(new Request(ORIGIN))).status, 204);
  const offline = createProtocolHandler(async () => { throw new Error('offline'); });
  assert.equal((await offline(new Request(ORIGIN))).status, 503);
});
test('IPC matches out-of-order responses, forwards events and rejects on process exit', async () => {
  const child = new EventEmitter(); const sent = []; const events = [];
  child.postMessage = message => sent.push(message);
  const call = createBackendClient(child, e => events.push(e));
  const first = call({ url: '/first' }), second = call({ url: '/second' });
  child.emit('message', { type: 'response', id: sent[1].id, status: 201 });
  child.emit('message', { type: 'response', id: sent[0].id, status: 200 });
  assert.equal((await first).status, 200); assert.equal((await second).status, 201);
  child.emit('message', { type: 'event', message: { type: 'qr_code' } });
  assert.deepEqual(events, [{ type: 'qr_code' }]);
  const pending = assert.rejects(call({ url: '/pending' }), /后台已停止/);
  child.emit('exit', 1); await pending;
  await assert.rejects(call({ url: '/later' }), /后台已停止/);
});
test('IPC times out and ignores late replies', async () => {
  const child = new EventEmitter(); child.postMessage = () => {};
  const call = createBackendClient(child, () => {}, 10);
  await assert.rejects(call({ url: '/slow' }), /超时/);
  child.emit('message', { type: 'response', id: 1, status: 200 });
});
