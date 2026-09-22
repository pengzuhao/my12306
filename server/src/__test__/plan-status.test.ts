import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleLabel, planDateStatus } from '../../../web/src/utils/plan-status.js';
import type { PlanDateEntry, TaskSnapshot } from '../../../web/src/api/index.js';

const now = new Date('2026-09-22T14:00:00Z');
const row: PlanDateEntry = { travelDate: '2026-09-28', originalDate: '2026-09-28', weekday: 1, postponed: false, isWorkday: true, estimatedSaleDate: '2026-09-14', task: null };
const withTask = (status: string, saleAt: string | null = null): PlanDateEntry => ({ ...row, task: { status, saleAt } as TaskSnapshot });
test('past sale date is summarized, never rendered as an invented 08:00', () => {
  assert.equal(saleLabel(row, now), '已开售');
  assert.equal(saleLabel(withTask('queried', '2026-09-14T08:00:00+08:00'), now), '已开售');
  assert.equal(saleLabel({ ...row, estimatedSaleDate: '2026-09-24' }, now), '预计 2026-09-24');
  assert.equal(saleLabel({ ...row, estimatedSaleDate: '2026-09-22' }, now), '今日开售');
  assert.equal(saleLabel(withTask('queried', '2026-09-24T00:00:00Z'), now), '2026-09-24 08:00');
});
test('unscheduled, paused and logged-out plans have distinct states', () => {
  assert.equal(planDateStatus(row, 'active', true, now), '待购票');
  assert.equal(planDateStatus(row, 'active', false, now), '待登录');
  assert.equal(planDateStatus(row, 'paused', true, now), '已暂停');
  assert.equal(planDateStatus({ ...row, estimatedSaleDate: '2026-09-24' }, 'active', true, now), '待开售');
  assert.equal(planDateStatus(withTask('pending'), 'active', true, now), '准备购票');
  assert.equal(planDateStatus(withTask('queried', '2026-09-14T08:00:00+08:00'), 'active', true, now), '等待购票');
});
test('actual task outcomes are preserved even when paused or logged out', () => {
  assert.equal(planDateStatus(withTask('success'), 'paused', false, now), '已购票');
  assert.equal(planDateStatus(withTask('failed'), 'paused', false, now), '购票失败');
  assert.equal(planDateStatus(withTask('running'), 'active', true, now), '正在购票');
  assert.equal(planDateStatus(withTask('queued'), 'active', true, now), '排队中');
  const interrupted = withTask('failed');
  interrupted.task!.error = '执行中断：服务已重启，请先核对 12306 订单；确认未购票后再重试';
  assert.equal(planDateStatus(interrupted, 'active', true, now), '执行中断');
  assert.equal(saleLabel(interrupted, now), '已开售');
  assert.equal(planDateStatus({ ...row, travelDate: '2026-09-21' }, 'active', true, now), '已结束');
});
