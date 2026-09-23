const assert = require('node:assert/strict');
const path = require('node:path');
const { utilityProcess } = require('electron');
module.exports = async function smoke({ origin, requestBackend, webSession, browsers, backendPid }) {
  const health = await webSession.fetch(origin + '/api/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const html = await webSession.fetch(origin);
  assert.equal(html.status, 200); assert.match(await html.text(), /<div id="app"><\/div>/);
  assert.equal((await webSession.fetch(origin + '/api/plans')).status, 200, 'SQLite and API work inside Electron');
  const invalid = await webSession.fetch(origin + '/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400, 'POST body and error status preserved');
  // This previously failed with 415 before reaching the session route.
  // The isolated profile has no account: a meaningful 400 proves dispatch works.
  for (const headers of [{}, { 'content-type':'application/x-www-form-urlencoded' }]) {
    const sync = await webSession.fetch(origin + '/api/session/sync-passengers', { method:'POST', headers });
    assert.equal(sync.status,400,'empty POST must reach passenger synchronization route');
    assert.match((await sync.json()).error,/12306 未登录/);
  }
  console.log('PASS bodyless passenger sync reaches API (no real account)');
  const csv = await webSession.fetch(origin + '/api/logs/export');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /csv/);
  assert.ok((await csv.arrayBuffer()).byteLength > 0, 'binary export preserved');
  if (process.platform === 'darwin') {
    const { spawnSync } = require('node:child_process');
    for (const pid of [process.pid, backendPid]) {
      const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
      assert.equal(result.status, 1, `PID ${pid} must not listen on TCP: ${result.stdout} ${result.stderr}`);
    }
  }
  const response = await requestBackend({ url: '/api/health' });
  assert.equal(JSON.parse(Buffer.from(response.body).toString()).ok, true);
  const child = utilityProcess.fork(path.join(__dirname, 'browser-smoke.cjs'), [], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, stdio: 'pipe' });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  await new Promise((resolve, reject) => {
    let passed = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chromium launch timeout')); }, 30000);
    child.on('message', message => { if (message.ok) { passed = true; console.log('PASS bundled Chromium:', message.version); child.postMessage({ type: 'shutdown' }); } });
    child.on('exit', code => { clearTimeout(timer); passed && code === 0 ? resolve() : reject(new Error('Chromium failed: ' + code)); });
  });
  console.log('PASS desktop: no TCP listeners, private IPC, custom protocol, POST, export, SQLite, bundled Chromium');
};
