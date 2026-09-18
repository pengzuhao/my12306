/**
 * 日期推算引擎离线测试（无需网络亦可验证逻辑，节假日数据优先用缓存）。
 * 运行：npm run test:date-engine --workspace server
 */
import { computeDates, previewForPlan } from '../date-engine.js';
import { ensureYears, isWorkday, weekdayOf, addDays } from '../../calendar/holidays.js';
import type { Plan } from '../../types.js';

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 以一个固定的"今天"作为生成起点，保证测试可复现
const FIXED_TODAY = '2026-09-17';

function show(title: string, entries: Awaited<ReturnType<typeof computeDates>>): void {
  console.log(`\n=== ${title} ===`);
  for (const e of entries) {
    const flag = e.postponed ? '  ⏩[顺延]' : '';
    console.log(
      `  ${e.travelDate} (周${e.weekday}) 原始:${e.originalDate} 工作日:${e.isWorkday}${flag}`,
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

  // 2) 每周一，跨国庆假期：应出现顺延
  const weekly = await computeDates(
    { dateMode: 'recurring', weekday: 1, weekInterval: 1, validFrom: '2026-09-01', validUntil: '2026-10-31' },
    FIXED_TODAY,
  );
  show('每周一 2026-09~10（国庆周应顺延）', weekly);
  const postponedCount = weekly.filter((e) => e.postponed).length;
  console.log(`  → 顺延条目数：${postponedCount}`);

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

  // 简单断言
  const ok =
    postponedCount >= 1 &&
    single.length === 1 &&
    bad.length === 0 &&
    // 周几正确性：2026-09-17 是周四（4）
    weekdayOf('2026-09-17') === 4 &&
    weekdayOf('2026-10-01') === 4 &&
    // 每周一：所有候选的原始日期必须落在周一（顺延只影响 travelDate）
    weekly.every((e) => weekdayOf(e.originalDate) === 1) &&
    // 顺延后的实际日期必须是工作日
    weekly.every((e) => isWorkday(e.travelDate)) &&
    biweekly.every((e) => isWorkday(e.travelDate));
  console.log(`\n${ok ? '✅ 日期推算引擎测试通过' : '❌ 测试未通过，请检查'}`);
  process.exit(ok ? 0 : 1);
}

void main();
