import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('startup marks interrupted tasks without retrying uncertain orders or changing completed tasks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-recovery-'));
  process.env.MY12306_DATA_DIR = dir;
  const { applySchema, seedAdmin, closeDb } = await import('../db/index.js');
  const { PlansRepo, TasksRepo } = await import('../db/repo.js');
  try {
    applySchema(); seedAdmin();
    PlansRepo.save({ id: 'recovery-plan', userId: 'system', name: '恢复测试', status: 'active', fromStation: '南京南', toStation: '上海虹桥', dateMode: 'single', travelDate: '2026-09-24', weekday: null, weekEdge: null, weekInterval: 1, offsetDays: 0, validFrom: '2026-09-22', validUntil: null, timeFrom: null, timeTo: null, trainNumbers: ['G76'], seatPositions: [], seatTypes: ['ZE'], allowNoSeat: false, passengerIds: [] });
    const states = ['running', 'queued', 'success', 'failed', 'pending', 'queried', 'cancelled', 'skipped'] as const;
    const snapshots = states.map(status => {
      const task = TasksRepo.create({ planId: 'recovery-plan', userId: 'system', planDateId: null, travelDate: '2026-09-24', trainNumber: 'G76', saleAt: '2026-09-10T00:00:00Z', status });
      TasksRepo.update(task.id, { attempts: 1, startedAt: '2026-09-21T15:19:57Z', result: status === 'running' || status === 'success' ? { orderNo: 'TEST_UNCERTAIN_ORDER' } : null });
      return TasksRepo.get(task.id)!;
    });
    assert.equal(TasksRepo.recoverInterrupted(), 2);
    for (const before of snapshots) {
      const after = TasksRepo.get(before.id)!;
      if (before.status === 'running' || before.status === 'queued') {
        assert.equal(after.status, 'failed');
        assert.match(after.error!, /^执行中断：.*核对.*重试$/);
        assert.ok(after.finishedAt);
        assert.equal(after.attempts, before.attempts);
        assert.equal(after.startedAt, before.startedAt);
        assert.deepEqual(after.result, before.result);
      } else assert.deepEqual(after, before);
    }
    assert.deepEqual(TasksRepo.listDue('2026-09-22T00:00:00Z').map(t => t.id), [snapshots[5].id]);
    assert.equal(TasksRepo.recoverInterrupted(), 0, 'repeated recovery does not change state');
  } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
});
