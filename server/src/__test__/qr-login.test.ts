import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QrAttempt, runQrLogin, type QrSnapshot } from '../bot/qr-login.js';

function fixture(autoRefresh = true) {
  let time = 0;
  const snapshots: QrSnapshot[] = [];
  const attempt = new QrAttempt('test-attempt', autoRefresh, s => snapshots.push(s));
  const state = { image: 'code-1', expired: false, scanned: false, loggedIn: false };
  const refreshes: boolean[] = [];
  let completed = 0;
  const driver = {
    open: async () => {}, read: async () => ({ ...state }),
    refresh: async (manual: boolean) => { refreshes.push(manual); state.image = `code-${refreshes.length + 1}`; state.expired = false; },
    complete: async () => { completed++; },
  };
  const run = (tick: (time: number) => void, extra = {}) => runQrLogin(attempt, driver, {
    now: () => time, sleep: async (ms: number) => { time += ms; tick(time); },
    ...extra,
  });
  return { attempt, state, snapshots, refreshes, driver, run, completed: () => completed };
}

test('official expiry automatically replaces the QR and completes login', async () => {
  const f = fixture();
  await f.run(t => { if (t === 1000) f.state.expired = true; if (t === 3000) f.state.loggedIn = true; });
  assert.deepEqual(f.refreshes, [false]);
  assert.ok(f.snapshots.some(s => s.image === 'code-2' && s.phase === 'ready'));
  assert.equal(f.attempt.snapshot.phase, 'success'); assert.equal(f.completed(), 1);
});

test('manual refresh replaces a still-valid code and rejects duplicate clicks', async () => {
  const f = fixture();
  await f.run(t => {
    if (t === 1000) { assert.equal(f.attempt.refresh(), true); assert.equal(f.attempt.refresh(), false); }
    if (t === 3000) f.attempt.cancel();
  });
  assert.deepEqual(f.refreshes, [true]);
  assert.ok(f.snapshots.some(s => s.image === 'code-2'));
});

test('scanning wins over a queued manual refresh and the stale-code timer', async () => {
  const f = fixture();
  await f.run(t => {
    if (t === 1000) { f.attempt.refresh(); f.state.scanned = true; }
    if (t === 5000) f.state.loggedIn = true;
  }, { staleMs: 2000 });
  assert.deepEqual(f.refreshes, []); assert.equal(f.completed(), 1);
  assert.ok(f.snapshots.some(s => s.phase === 'scanned' && s.image === null));
});

test('auto refresh can be disabled while manual refresh remains available', async () => {
  const f = fixture(false);
  await f.run(t => {
    if (t === 1000) f.state.expired = true;
    if (t === 2000) { assert.equal(f.attempt.snapshot.phase, 'expired'); assert.equal(f.refreshes.length, 0); f.attempt.refresh(); }
    if (t === 4000) f.attempt.cancel();
  });
  assert.deepEqual(f.refreshes, [true]);
});

test('fallback expiry refreshes an unscanned stale image', async () => {
  const f = fixture();
  await f.run(t => { if (t === 4000) f.attempt.cancel(); }, { staleMs: 2000 });
  assert.deepEqual(f.refreshes, [false]);
});

test('a refresh that keeps returning the old image fails without a retry storm', async () => {
  const f = fixture();
  f.driver.refresh = async manual => { f.refreshes.push(manual); };
  await assert.rejects(f.run(t => { if (t === 1000) f.state.expired = true; }), /未能获取新的二维码/);
  assert.deepEqual(f.refreshes, [false]); assert.equal(f.attempt.snapshot.phase, 'error');
  assert.equal(f.attempt.snapshot.image, null);
});

test('cancellation while opening suppresses late errors and prevents reading or refreshing', async () => {
  const f = fixture(); let reads = 0;
  f.driver.open = async () => { f.attempt.cancel(); throw new Error('page closed'); };
  f.driver.read = async () => { reads++; return { ...f.state }; };
  await f.run(() => {});
  assert.equal(reads, 0); assert.equal(f.attempt.snapshot.phase, 'cancelled');
});

test('cancellation while refreshing never republishes the next image', async () => {
  const f = fixture();
  f.driver.refresh = async () => { f.state.image = 'late-code'; f.attempt.cancel(); };
  await f.run(t => { if (t === 1000) f.state.expired = true; });
  assert.equal(f.attempt.snapshot.phase, 'cancelled');
  assert.ok(!f.snapshots.some(s => s.image === 'late-code'));
});

test('login attempt has a bounded lifetime and revisions are strictly increasing', async () => {
  const f = fixture();
  await assert.rejects(f.run(() => {}, { durationMs: 3000 }), /登录已超时/);
  assert.ok(f.snapshots.every((s, i) => !i || s.revision > f.snapshots[i - 1].revision));
  assert.equal(f.attempt.refresh(), false);
});

test('frontend ignores cancelled attempts and out-of-order responses, and can retry errors', async () => {
  const { sessionApi } = await import('../../../web/src/api/index.js');
  const store = await import('../../../web/src/store/session.js');
  let pendingResolve!: (value: QrSnapshot) => void;
  let currentId = '';
  const cancelled: string[] = [];
  sessionApi.login = id => { currentId = id; return new Promise(resolve => { pendingResolve = resolve; }); };
  sessionApi.cancelLogin = async id => { cancelled.push(id); return { ok: true }; };
  const snapshot = (revision: number, phase: QrSnapshot['phase'] = 'ready'): QrSnapshot => ({
    attemptId: currentId, phase, image: 'test-image', status: 'test', autoRefresh: true, revision,
  });
  try {
    const firstStart = store.startLogin();
    const old = snapshot(1);
    const cancellation = store.cancelLogin();
    assert.equal(store.qrVisible.value, false); assert.deepEqual(cancelled, []);
    pendingResolve(old); await firstStart; await cancellation;
    store.handleQrCode({ ...old, revision: 99 });
    assert.equal(store.qrVisible.value, false); assert.equal(store.qrImage.value, '');
    assert.deepEqual(cancelled, [old.attemptId]);
    const secondStart = store.startLogin(); pendingResolve(snapshot(1)); await secondStart;
    store.handleQrCode(snapshot(3, 'scanned')); store.handleQrCode(snapshot(2)); store.handleQrCode(old);
    assert.equal(store.qrPhase.value, 'scanned');
    store.handleQrCode(snapshot(4, 'error'));
    assert.equal(store.qrVisible.value, true); assert.equal(store.qrRefreshBusy.value, false);
    const failedId = currentId;
    const retry = store.refreshQr(); pendingResolve(snapshot(1)); await retry;
    assert.notEqual(currentId, failedId); assert.equal(store.qrPhase.value, 'ready');
  } finally { await store.cancelLogin(); }
});
