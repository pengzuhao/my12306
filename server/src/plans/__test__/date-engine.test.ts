/**
 * 日期推算引擎离线测试（无需网络亦可验证逻辑，节假日数据优先用缓存）。
 * 运行：npm run test:date-engine --workspace server
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolvePlanSearchTarget } from '../../../../web/src/utils/plan-search-date.js';
import type { PlanForm } from '../../../../web/src/api/index.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-dates-'));
process.env.MY12306_DATA_DIR = dir;
// Fixed calendar fixtures keep CI offline and away from the user's database.
const holidays = Object.fromEntries(Array.from({length: 7}, (_, i) => [`2026-10-0${i + 1}`, {name: '测试国庆假期', isOffDay: true}]));
holidays['2026-09-20'] = {name: '测试补班', isOffDay: false};
fs.writeFileSync(path.join(dir, 'holidays.json'), JSON.stringify({2025: {}, 2026: holidays, 2027: {}}));
globalThis.fetch = async () => { throw new Error('日期单测不应请求范围外的年份或外部网络'); };
const { computeDates, previewForPlan } = await import('../date-engine.js');
const { ensureYears, isWorkday, weekdayOf } = await import('../../calendar/holidays.js');
const { closeDb } = await import('../../db/index.js');
process.on('exit', () => { closeDb(); fs.rmSync(dir, {recursive: true, force: true}); });
import type { Plan } from '../../types.js';

// 以一个固定的"今天"作为生成起点，保证测试可复现
const FIXED_TODAY = '2026-09-17';

function show(title: string, entries: Awaited<ReturnType<typeof computeDates>>): void {
  console.log(`\n=== ${title} ===`);
  for (const e of entries) {
    const flag = e.postponed ? '  ⏩[顺延]' : '';
    const wdNames = ['一', '二', '三', '四', '五', '六', '日'];
    console.log(
      `  ${e.travelDate} (周${wdNames[e.weekday - 1]}) 原始:${e.originalDate} 工作日:${e.isWorkday}${flag}`,
    );
  }
  if (!entries.length) console.log('  （无）');
}

async function main(): Promise<void> {
  await ensureYears([2026, 2027]);

  // 1) 单次模式：指定具体日期
  const single = await computeDates(
    { dateMode: 'single', travelDate: '2026-10-01', validFrom: '2026-01-01' },
    FIXED_TODAY,
  );
  show('单次模式 2026-10-01（国庆假期，仅标注不顺延）', single);

  // 2) recurring 每周一：纯日历对齐，不顺延节假日（国庆周 10-05 照常落在周一）
  const weekly = await computeDates(
    { dateMode: 'recurring', weekday: 1, weekInterval: 1, validFrom: '2026-09-01', validUntil: '2026-10-31' },
    FIXED_TODAY,
  );
  show('recurring 每周一 2026-09~10（不顺延，国庆周照常）', weekly);
  const hasNationalDay = weekly.some((e) => e.travelDate === '2026-10-05' && !e.isWorkday);
  console.log(`  → 10-05 国庆周一照常出现：${hasNationalDay}`);

  // 2b) workweek 工作周开始：应跳过国庆假期，10-05 周一不应出现
  const ww = await computeDates(
    { dateMode: 'workweek', weekEdge: 'start', weekInterval: 1, validFrom: '2026-09-01', validUntil: '2026-10-31' },
    FIXED_TODAY,
  );
  show('workweek 工作周开始 2026-09~10（跳节假日）', ww);
  const wwSkipsNational = !ww.some((e) => e.travelDate === '2026-10-05');
  const wwAllWorkday = ww.every((e) => isWorkday(e.travelDate));
  console.log(`  → 跳过 10-05 国庆：${wwSkipsNational}；全部为工作日：${wwAllWorkday}`);

  // 3) 每 2 周的周五
  const biweekly = await computeDates(
    { dateMode: 'recurring', weekday: 5, weekInterval: 2, validFrom: '2026-09-01', validUntil: '2026-12-31' },
    FIXED_TODAY,
  );
  show('每 2 周的周五 2026-09~12', biweekly);

  // 4) 计划对象预览（含预估起售日期）
  const plan: Plan = {
    id: 'p1',
    userId: 'u1',
    name: '南京→上海 每周一',
    status: 'active',
    fromStation: '南京',
    toStation: '上海',
    dateMode: 'recurring',
    travelDate: null,
    weekday: 1,
    weekInterval: 1,
    validFrom: '2026-09-01',
    validUntil: null,
    timeFrom: '08:00',
    timeTo: '09:00',
    trainNumbers: null,
    seatPositions: ['A', 'F'],
    passengerIds: [],
    createdAt: '',
    updatedAt: '',
  };
  const preview = await previewForPlan(plan, FIXED_TODAY);
  console.log('\n=== 计划预览（含预估起售日期）===');
  for (const e of preview.slice(0, 6)) {
    console.log(`  乘车 ${e.travelDate} ← 预售 ${e.estimatedSaleDate}${e.note ? '  备注:' + e.note : ''}`);
  }

  // 5) 边界：无效 weekday
  const bad = await computeDates({ dateMode: 'recurring', weekday: 9, validFrom: '2026-09-01' }, FIXED_TODAY);
  console.log(`\n无效 weekday 返回条目数：${bad.length}（应为 0）`);

  // 6) 工作周锚点 + 已错过的出发窗口（复现 9.20 周日补班的真实场景）
  //    validFrom=9.20（调休补班日，本周首个工作日就是 9.20），今天 9.20 晚上 20:00，
  //    06:50 的车早已开走 → 本周应整体跳过，首个目标变成下个工作周 9.28。
  const missed = await computeDates(
    {
      dateMode: 'workweek',
      weekEdge: 'start',
      weekInterval: 1,
      validFrom: '2026-09-20',
      validUntil: '2026-10-31',
      timeFrom: '06:50',
      timeTo: '07:00',
    },
    '2026-09-20',
    '20:00',
  );
  show('workweek 锚点 9.20 且 06:50 已错过（应跳到 9.28）', missed);
  const missedOk = missed.length > 0 && missed[0].travelDate === '2026-09-28' && !missed.some((e) => e.travelDate <= '2026-09-20');
  console.log(`  → 首个目标为 9.28 且不含本周已错过日期：${missedOk}`);

  // 6b) 同样的计划，但在发车前查询（05:00）→ 今天 9.20 的票应保留
  const upcoming = await computeDates(
    {
      dateMode: 'workweek',
      weekEdge: 'start',
      weekInterval: 1,
      validFrom: '2026-09-20',
      validUntil: '2026-10-31',
      timeFrom: '06:50',
      timeTo: '07:00',
    },
    '2026-09-20',
    '05:00',
  );
  show('workweek 锚点 9.20，05:00 未发车（应保留 9.20）', upcoming);
  const upcomingOk = upcoming.length > 0 && upcoming[0].travelDate === '2026-09-20';
  console.log(`  → 首个目标保留为今天 9.20：${upcomingOk}`);

  const workweekRule = { dateMode: 'workweek', weekEdge: 'start', weekInterval: 1, validFrom: '2026-09-23', validUntil: '2026-10-31' } as const;
  const midweek = await previewForPlan(workweekRule, '2026-09-22', '22:00');
  assert.equal(midweek[0].travelDate, '2026-09-28', '周三生效不能把周三变成工作周第一天');
  assert.equal(midweek[1].travelDate, '2026-10-08', '国庆后本周首个工作日取周四');
  const todayStart = await computeDates({ ...workweekRule, validFrom: '2026-09-22' }, '2026-09-22', '08:00');
  assert.equal(todayStart[0].travelDate, '2026-09-28', '今天在周中也应跳过本周起点');
  const weekEnd = await computeDates({ ...workweekRule, weekEdge: 'end' }, '2026-09-22');
  assert.equal(weekEnd[0].travelDate, '2026-09-25', '工作周末取本周末，不是开始日期后第七天');
  const limited = await computeDates({ ...workweekRule, validUntil: '2026-09-27' }, '2026-09-22');
  assert.deepEqual(limited, [], '范围内没有完整目标日时不退回开始日期');
  const everyTwo = { ...workweekRule, weekInterval: 2 };
  assert.deepEqual((await computeDates(everyTwo, '2026-09-22')).map(e => e.travelDate), ['2026-09-28', '2026-10-12', '2026-10-26']);
  assert.equal((await computeDates(everyTwo, '2026-10-01'))[0].travelDate, '2026-10-12', '今天推进不改变隔周周期');
  assert.equal((await computeDates({ ...workweekRule, offsetDays: -1 }, '2026-09-22'))[0].travelDate, '2026-09-27');
  assert.equal((await computeDates({ ...workweekRule, offsetDays: -1, validUntil: '2026-09-27' }, '2026-09-22'))[0].travelDate, '2026-09-27', '负偏移日期可落在最后一个周末');
  assert.equal((await computeDates({ ...workweekRule, validFrom: '2026-09-21', offsetDays: 2 }, '2026-09-22'))[0].travelDate, '2026-09-22', '正偏移不会漏掉前一周目标');
  assert.equal((await computeDates({ ...workweekRule, validFrom: '2026-09-28', timeFrom: '08:00', timeTo: null }, '2026-09-28', '09:00'))[0].travelDate, '2026-09-28', '仅设置时间下限不表示当日全部班次已错过');
  assert.equal((await computeDates({ ...workweekRule, validFrom: '2026-09-28', timeTo: '09:00' }, '2026-09-28', '10:00'))[0].travelDate, '2026-10-08');
  const searchForm = workweekRule as PlanForm;
  let previewCalls = 0;
  assert.equal((await resolvePlanSearchTarget(searchForm, async form => {
    previewCalls++; return previewForPlan(form, '2026-09-22', '22:00');
  }))?.travelDate, '2026-09-28', '余票查询与预览使用同一推算日期');
  assert.equal(previewCalls, 1);
  assert.equal(await resolvePlanSearchTarget(searchForm, async () => []), null, '空预览不查询开始日期');
  const singleTarget = await resolvePlanSearchTarget({ ...searchForm, dateMode: 'single', travelDate: '2026-09-23' }, form => previewForPlan(form, '2026-09-22', '22:00'));
  assert.equal(singleTarget?.travelDate, '2026-09-23');
  assert.equal(singleTarget?.estimatedSaleDate, '2026-09-09', '单次查询也使用服务端的预售期推算');
  const recurringRule = { dateMode: 'recurring', weekday: 1, weekInterval: 2, validFrom: '2026-09-23', validUntil: '2026-10-31' } as const;
  assert.equal((await computeDates(recurringRule, '2026-10-01'))[0].travelDate, '2026-10-12', '固定星期隔周计划同样保持周期');
  assert.equal((await computeDates({ ...recurringRule, offsetDays: -1 }, '2026-09-22'))[0].travelDate, '2026-09-27');
  console.log('✅ 工作周完整边界、隔周稳定性、偏移、当日窗口、余票日期一致性回归通过');

  // 简单断言
  const ok =
    single.length === 1 &&
    bad.length === 0 &&
    // 周几正确性：2026-09-17 是周四（4）
    weekdayOf('2026-09-17') === 4 &&
    weekdayOf('2026-10-01') === 4 &&
    // recurring 每周一：原始日期必须落在周一（不再顺延，国庆周 10-05 照常）
    weekly.every((e) => weekdayOf(e.originalDate) === 1) &&
    weekly.some((e) => e.travelDate === '2026-10-05' && !e.isWorkday) &&
    // workweek：跳过国庆、全部为工作日
    wwSkipsNational &&
    wwAllWorkday &&
    // 每 2 周的周五：原始日期落在周五
    biweekly.every((e) => weekdayOf(e.originalDate) === 5) &&
    // 工作周锚点 + 已错过出发窗口：跳到 9.28；未错过时保留 9.20
    missedOk &&
    upcomingOk;
  console.log(`\n${ok ? '✅ 日期推算引擎测试通过' : '❌ 测试未通过，请检查'}`);
  process.exit(ok ? 0 : 1);
}

void main();
