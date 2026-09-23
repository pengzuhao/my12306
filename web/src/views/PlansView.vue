<script setup lang="ts">
import CalendarDayHeader from '../components/CalendarDayHeader.vue';
import { CALENDAR_WEEK_LABELS } from '../utils/calendar-day';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import PlanScheduleCalendar from '../components/PlanScheduleCalendar.vue';
import {
  planApi,
  passengerApi,
  calendarApi,
  metaApi,
  ordersApi,
  type PlanForm,
  type HolidayDay,
  type PlanDateEntry,
  type TaskSnapshot,
  type SeatTypeOption,
  type TrainOption,
} from '../api';

import { sessionState, sessionSyncing, syncPassengers } from '../store/session';
import { filterDepartureRange } from '../utils/train-filter';
import { resolvePlanSearchTarget } from '../utils/plan-search-date';
import { trainSearchErrorMessage } from '../utils/train-query-error';
import { todayCn, isPastDate } from '../utils/time';
import { saleLabel, planDateStatus } from '../utils/plan-status';

const router = useRouter();

interface Passenger {
  id: string;
  name: string;
  idNo: string;
  passengerType: string;
}

interface Plan extends PlanForm {
  id: string;
  status: string;
}

// ---- 席别：从 12306 透传，不写死在前端 ----
/** 席别选项（后端来自 12306 余票字段映射） */
const seatTypeOptions = ref<SeatTypeOption[]>([]);
/** 席别代码 → 中文名映射（由透传的选项派生，不在前端写死） */
const seatTypeNameMap = computed<Record<string, string>>(() =>
  Object.fromEntries(seatTypeOptions.value.map((s) => [s.code, s.name])),
);

const plans = ref<Plan[]>([]);
const passengers = ref<Passenger[]>([]);
const dialogVisible = ref(false);
const previewVisible = ref(false);
const previewRows = ref<PreviewEntry[]>([]);
const editing = reactive<PlanForm>(emptyForm());

interface PreviewEntry {
  /** 实际乘车日期（顺延后）YYYY-MM-DD */
  travelDate: string;
  /** 规则原始推算日期 YYYY-MM-DD */
  originalDate: string;
  /** 1=周一 .. 7=周日 */
  weekday: number;
  /** 是否发生顺延（节假日） */
  postponed: boolean;
  isWorkday: boolean;
  /** 顺延原因等说明 */
  note?: string;
  /** 预估起售日期 = 乘车日期 − 预售期 */
  estimatedSaleDate: string;
}

// ---- 预览日历：按月展示推算出的购票日期 ----
/** 预览日历当前展示的月份 */
const pvMonth = ref(new Date());
const WEEK_LABELS = CALENDAR_WEEK_LABELS;

const pvTitle = computed(() => `${pvMonth.value.getFullYear()} 年 ${pvMonth.value.getMonth() + 1} 月`);

/** 本月在推算结果中的条目 */
const pvMonthEntries = computed(() => {
  const y = pvMonth.value.getFullYear();
  const m = pvMonth.value.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  return previewRows.value.filter((e) => e.travelDate.startsWith(prefix));
});

interface PvCell {
  day: number;
  date: string;
  entry?: PreviewEntry;
}
const pvCells = computed<(PvCell | null)[]>(() => {
  const y = pvMonth.value.getFullYear();
  const m = pvMonth.value.getMonth();
  const startWeekday = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (PvCell | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, date: dateStr, entry: pvMonthEntries.value.find((e) => e.travelDate === dateStr) });
  }
  return cells;
});

/**
 * 翻月（带范围控制 + 节假日加载前提）。
 *
 * - 范围：只能翻到推算结果覆盖的月份（第一个到最后一个推算日期之间），
 *   超出范围的月份没有任何推算数据，翻了也没意义。
 * - 前提：目标月份所在年的节假日数据必须加载成功。接口失败时阻止翻页
 *   并提示用户（而不是静默渲染一个无节假日标记的日历，误导推算）。
 */
async function pvShift(delta: number): Promise<void> {
  if (!previewRows.value.length) return;
  const first = previewRows.value[0].travelDate;
  const last = previewRows.value[previewRows.value.length - 1].travelDate;
  const target = new Date(pvMonth.value.getFullYear(), pvMonth.value.getMonth() + delta, 1);
  const targetEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0); // 目标月最后一天
  // 越界：目标月整体早于首个推算日期 或 晚于末个推算日期
  if (targetEnd < new Date(first) || target > new Date(last)) {
    ElMessage.info('已到推算日期范围边界');
    return;
  }
  // 节假日加载前提：目标年份必须先加载成功才允许翻过去
  const y = target.getFullYear();
  if (!pvHolidaysByYear.has(y)) {
    try {
      const res = await calendarApi.holidaysOfYear(y);
      pvHolidaysByYear.set(y, res.days);
      pvPendingYears.set(y, res.calendarPending);
    } catch {
      ElMessage.error(`${y} 年节假日数据加载失败，暂无法查看该月日历`);
      return;
    }
  }
  pvMonth.value = target;
}

// ---- 预览日历的节假日标记（按自然年缓存，切月份零延迟）----
/** 当前展示月份的节假日数据（从年度缓存里切片得到） */
const pvHolidays = ref<HolidayDay[]>([]);
/** 按自然年缓存：year -> 全年节假日数据。只有首次访问某年时才调接口 */
const pvHolidaysByYear = new Map<number, HolidayDay[]>();
/** 按自然年缓存"该年放假安排是否尚未公布" */
const pvPendingYears = new Map<number, boolean>();
/** 预览日历当前年放假安排尚未公布 */
const pvCalendarPending = ref(false);

async function reloadPvHolidays(): Promise<void> {
  const y = pvMonth.value.getFullYear();
  const m = pvMonth.value.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, '0')}-`;
  // 年度缓存命中：同步切片返回，无网络延迟
  const cached = pvHolidaysByYear.get(y);
  if (cached) {
    pvHolidays.value = cached.filter((h) => h.date.startsWith(prefix));
    pvCalendarPending.value = pvPendingYears.get(y) ?? false;
    return;
  }
  // 首次访问该年：一次接口拿全年数据，之后该年内切月份不再请求
  // 失败时清空该年标记并提示——节假日数据是工作周推算的前提，不能静默吞掉
  try {
    const res = await calendarApi.holidaysOfYear(y);
    pvHolidaysByYear.set(y, res.days);
    pvPendingYears.set(y, res.calendarPending);
    pvHolidays.value = res.days.filter((h) => h.date.startsWith(prefix));
    pvCalendarPending.value = res.calendarPending;
  } catch {
    pvHolidaysByYear.delete(y);
    pvHolidays.value = [];
    pvCalendarPending.value = false;
    ElMessage.error(`${y} 年节假日数据加载失败，日历标记暂不可用`);
  }
}

function pvHolidayOf(dateStr: string): HolidayDay | undefined {
  return pvHolidays.value.find((h) => h.date === dateStr);
}

watch(pvMonth, () => void reloadPvHolidays());

/** 跳到第一个推算日期所在的月份（先确保该年节假日已加载） */
async function pvToFirst(): Promise<void> {
  const first = previewRows.value[0];
  if (!first) return;
  const y = Number(first.travelDate.slice(0, 4));
  if (!pvHolidaysByYear.has(y)) {
    try {
      const res = await calendarApi.holidaysOfYear(y);
      pvHolidaysByYear.set(y, res.days);
      pvPendingYears.set(y, res.calendarPending);
    } catch {
      ElMessage.error(`${y} 年节假日数据加载失败，日历标记暂不可用`);
    }
  }
  pvMonth.value = new Date(y, Number(first.travelDate.slice(5, 7)) - 1, 1);
}

/** 席别代码 → 中文名（由后端透传的席别选项派生，不写死） */
function seatTypeName(codes?: string[] | null): string {
  if (!codes || !codes.length) return '未指定';
  return codes.map((c) => seatTypeNameMap.value[c] ?? c).join('/');
}

function emptyForm(): PlanForm {
  return {
    id: undefined,
    name: '',
    fromStation: '',
    toStation: '',
    dateMode: 'recurring',
    travelDate: null,
    weekday: 1,
    weekEdge: 'start',
    weekInterval: 1,
    offsetDays: 0,
    validFrom: todayCn(),
    validUntil: null,
    timeFrom: '08:00',
    timeTo: '09:00',
    trainNumbers: null,
    trainSegments: [],
    seatPositions: ['A', 'F'],
    seatTypes: ['ZE'],
    allowNoSeat: false,
    passengerIds: [],
  };
}

const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const seatOptions = ['A', 'B', 'C', 'D', 'F'];
const seatPositionHint: Record<string, string> = { A: '靠窗', B: '中间', C: '过道', D: '过道', F: '靠窗' };

async function load(): Promise<void> {
  plans.value = (await planApi.list()) as Plan[];
  passengers.value = (await passengerApi.list()) as Passenger[];
}

/** 站点远程搜索（12306 真实站点库，支持拼音/缩写） */
const stationLoading = ref(false);
async function searchStations(keyword: string, cb: (items: Array<{ value: string }>) => void): Promise<void> {
  if (!keyword) return cb([]);
  stationLoading.value = true;
  try {
    const list = await planApi.stations(keyword);
    cb(list.map((s: { name: string }) => ({ value: s.name })));
  } catch {
    cb([]);
  } finally {
    stationLoading.value = false;
  }
}

/** A separate selection draft keeps cancel/close from modifying the plan. */
const trainSearchVisible = ref(false);
const selectedTrainCodes = ref<string[]>([]);
type TrainSegment = NonNullable<PlanForm['trainSegments']>[number];
const selectedTrainSegments = ref<TrainSegment[]>([]);
const selectedTrainCount = computed(() => selectedTrainCodes.value.length + selectedTrainSegments.value.length);
const segmentKey = (train: TrainSegment) => JSON.stringify([train.trainCode, train.fromStation, train.toStation]);
const isTrainSelected = (train: TrainSegment) => selectedTrainSegments.value.some(s => segmentKey(s) === segmentKey(train));
function clearTrainSelection(): void { selectedTrainCodes.value = []; selectedTrainSegments.value = []; }
watch(() => editing.trainNumbers, codes => {
  editing.trainSegments = editing.trainSegments?.filter(s => codes?.includes(s.trainCode)) ?? [];
}, { deep: true });
watch(() => [editing.fromStation, editing.toStation], () => { editing.trainSegments = []; }, { flush: 'sync' });
const trainLoading = ref(false);
const trainResults = ref<TrainOption[]>([]);
const visibleTrains = computed(() => filterDepartureRange(trainResults.value, editing.timeFrom, editing.timeTo)
  .sort((a, b) => a.departTime.localeCompare(b.departTime)));
/** 12306 是否已登录（车次查询需要登录态） */
const loggedIn = computed(() => !!sessionState.value.loggedIn);
const trainSearchError = ref('');
const trainSearched = ref(false);
const searchDate = ref<string | null>(null);
const dateRule = computed(() => [editing.dateMode, editing.travelDate, editing.validFrom, editing.validUntil, editing.weekEdge, editing.weekday, editing.weekInterval, editing.offsetDays]);
let trainSearchVersion = 0;
let editorVersion = 0;
watch(dialogVisible, () => {
  editorVersion++;
  previewing.value = false;
  if (!dialogVisible.value) { previewVisible.value = false; trainSearchVisible.value = false; }
}, { flush: 'sync' });
watch(trainSearchVisible, visible => {
  if (!visible) { trainSearchVersion++; trainLoading.value = false; }
}, { flush: 'sync' });
watch(() => [editing.fromStation, editing.toStation, ...dateRule.value, dialogVisible.value], () => {
  trainSearchVersion++;
  searchDate.value = null;
  trainResults.value = [];
  trainSearchError.value = '';
  trainSearched.value = false;
  trainLoading.value = false;
}, { flush: 'sync' });

/** 余票文本 → 颜色：有票绿、无票灰 */
function seatColor(text: string | undefined): string {
  if (!text || text === '无' || text === '') return '#c0c4cc';
  if (text === '有') return '#67c23a';
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? '#67c23a' : '#c0c4cc';
}

function openTrainSearch(): void {
  if (!validateDates()) return;
  if (!editing.fromStation || !editing.toStation) { ElMessage.warning('请先填写出发站和到达站'); return; }
  selectedTrainSegments.value = (editing.trainSegments ?? []).map(s => ({ ...s }));
  selectedTrainCodes.value = [...new Set(editing.trainNumbers ?? [])].filter(code => !selectedTrainSegments.value.some(s => s.trainCode === code));
  trainSearchVisible.value = true;
  void searchTrains();
}

async function searchTrains(): Promise<void> {
  if (trainLoading.value || !validateDates()) return;
  if (!editing.fromStation || !editing.toStation) {
    ElMessage.warning('请先填写出发站和到达站');
    return;
  }
  if (!loggedIn.value) {
    ElMessage.warning('请先在顶栏扫码登录 12306 后再查询车次');
    return;
  }
  const version = ++trainSearchVersion;
  trainLoading.value = true;
  trainSearched.value = true;
  trainSearchError.value = '';
  trainResults.value = [];
  searchDate.value = null;
  try {
    const form = JSON.parse(JSON.stringify(editing)) as PlanForm;
    const target = await resolvePlanSearchTarget(form, planApi.previewDates);
    if (version !== trainSearchVersion) return;
    if (!target) {
      trainSearchError.value = '该生效区间内没有符合规则的出行日期，请调整日期或工作周规则';
      return;
    }
    searchDate.value = target.travelDate;
    if (target.estimatedSaleDate > todayCn()) {
      trainSearchError.value = `${target.travelDate} 尚未开售，预计 ${target.estimatedSaleDate} 开售。可先保存计划，开售后自动查询；也可返回手动填写车次。`;
      return;
    }
    const res = await metaApi.trains(form.fromStation, form.toStation, target.travelDate);
    if (version !== trainSearchVersion) return;
    trainResults.value = res.trains;
    if (!visibleTrains.value.length) {
      ElMessage.warning('当前日期、区间和出发时间段内暂无车次，请调整条件');
    }
  } catch (e) {
    if (version !== trainSearchVersion) return;
    trainResults.value = [];
    trainSearchError.value = trainSearchErrorMessage(e);
  } finally {
    if (version === trainSearchVersion) trainLoading.value = false;
  }
}

function toggleTrain(train: TrainSegment): void {
  selectedTrainCodes.value = selectedTrainCodes.value.filter(code => code !== train.trainCode);
  selectedTrainSegments.value = isTrainSelected(train)
    ? selectedTrainSegments.value.filter(s => segmentKey(s) !== segmentKey(train))
    : [...selectedTrainSegments.value, { trainCode: train.trainCode, fromStation: train.fromStation, toStation: train.toStation }];
}

function confirmTrainSelection(): void {
  const codes = [...new Set([...selectedTrainCodes.value, ...selectedTrainSegments.value.map(s => s.trainCode)])];
  editing.trainNumbers = codes.length ? codes : null;
  editing.trainSegments = selectedTrainSegments.value.map(s => ({ ...s }));
  trainSearchVisible.value = false;
}

function openNew(): void {
  Object.assign(editing, emptyForm());
  editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
  trainResults.value = [];
  trainSearchVisible.value = false;
  dialogVisible.value = true;
}

function openEdit(p: Plan): void {
  Object.assign(editing, JSON.parse(JSON.stringify(p)));
  trainResults.value = [];
  trainSearchVisible.value = false;
  dialogVisible.value = true;
}

const saving = ref(false);
const previewing = ref(false);
watch(() => [...dateRule.value, editing.timeFrom, editing.timeTo], () => {
  editorVersion++;
  previewing.value = false;
  previewVisible.value = false;
}, { flush: 'sync' });
watch(() => [editing.timeFrom, editing.timeTo], () => {
  // 时间修改可能使当日目标失效，也不能接收按旧时间窗口推算的在途响应。
  if (!trainLoading.value && searchDate.value !== todayCn()) return;
  trainSearchVersion++;
  searchDate.value = null;
  trainResults.value = [];
  trainLoading.value = false;
  trainSearched.value = false;
  trainSearchError.value = '';
}, { flush: 'sync' });

function validateDates(): boolean {
  const error = editing.dateMode === 'single' && !editing.travelDate ? '请选择乘车日期'
    : editing.dateMode === 'single' && editing.travelDate! < todayCn() ? '乘车日期不能早于今天'
    : editing.dateMode !== 'single' && !editing.validFrom ? '请选择开始日期'
    : editing.validUntil && editing.validUntil < editing.validFrom ? '结束日期不能早于开始日期'
    : editing.timeFrom && editing.timeTo && editing.timeFrom > editing.timeTo ? '出发时间段的结束时间不能早于开始时间'
    : '';
  if (error) ElMessage.warning(error);
  return !error;
}

async function save(): Promise<void> {
  if (saving.value || !validateDates()) return;
  editing.name = editing.name.trim();
  editing.fromStation = editing.fromStation.trim();
  editing.toStation = editing.toStation.trim();
  if (editing.fromStation && editing.fromStation === editing.toStation) {
    ElMessage.warning('出发站和到达站不能相同');
    return;
  }
  if (!editing.name || !editing.fromStation || !editing.toStation) {
    ElMessage.warning('请填写计划名称与出发站、到达站');
    return;
  }
  if (!editing.passengerIds.length) {
    ElMessage.warning('请至少选择一名乘车人');
    return;
  }
  if (!editing.seatTypes || !editing.seatTypes.length) {
    ElMessage.warning('请至少选择一种席别');
    return;
  }
  saving.value = true;
  try {
    await planApi.save(editing);
    ElMessage.success('计划已保存');
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '保存失败');
  } finally {
    saving.value = false;
  }
}

async function setStatus(id: string, status: 'active' | 'paused' | 'deleted'): Promise<void> {
  await planApi.setStatus(id, status);
  await load();
}

async function confirmDelete(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认删除该计划？关联任务将不再执行', '提示', { type: 'warning' });
    await setStatus(id, 'deleted');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error('删除失败，请重试');
  }
}

/**
 * 操作栏「操作」下拉的命令分发。
 *
 * 详情通过点击计划名称链接打开，操作栏只留编辑/暂停·恢复/删除，
 * 危险操作（删除）走二次确认。
 */
async function handlePlanCommand(cmd: string, row: Plan): Promise<void> {
  switch (cmd) {
    case 'edit':
      openEdit(row);
      break;
    case 'pause':
      await setStatus(row.id, 'paused');
      break;
    case 'resume':
      await setStatus(row.id, 'active');
      break;
    case 'delete':
      await confirmDelete(row.id);
      break;
    default:
      break;
  }
}

async function preview(): Promise<void> {
  if (previewing.value || !validateDates()) return;
  previewing.value = true;
  const version = editorVersion;
  try {
    const rows = (await planApi.previewDates(editing)) as PreviewEntry[];
    if (version !== editorVersion || !dialogVisible.value) return;
    previewRows.value = rows;
    await pvToFirst();
    await reloadPvHolidays();
    if (version !== editorVersion || !dialogVisible.value) return;
    previewVisible.value = true;
  } catch (e) {
    if (version !== editorVersion || !dialogVisible.value) return;
    const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e);
    ElMessage.error('推算失败：' + msg);
  } finally {
    if (version === editorVersion) previewing.value = false;
  }
}

// ---- 计划详情抽屉：执行历史 + 当前动作 ----
const detailVisible = ref(false);
const detailPlan = ref<Plan | null>(null);
const detailRows = ref<PlanDateEntry[]>([]);
const detailView = ref('calendar');
const skippingDate = ref(false);
function canSkipDate(row: PlanDateEntry): boolean {
  return !row.cancellationPending && row.travelDate >= todayCn() && detailPlan.value?.status !== 'deleted' && !['running', 'success'].includes(row.task?.status ?? '');
}
function canCancelDate(row: PlanDateEntry): boolean {
  return row.task?.status === 'success' && row.task.result?.paid !== true && !!row.task.result?.orderNo;
}
async function cancelAndSkipDate(row: PlanDateEntry): Promise<void> {
  if (!detailPlan.value || !row.task || skippingDate.value) return;
  const id = detailPlan.value.id;
  try {
    await ElMessageBox.confirm(`确认取消 ${row.travelDate} 的整笔未支付订单 ${row.task.result?.orderNo}（包含该订单全部乘车人），并跳过当天购票？`, '取消订单并跳过', { confirmButtonText:'取消订单并跳过',cancelButtonText:'保留订单',type:'warning' });
    skippingDate.value = true;
    await planApi.cancelAndSkip(id,row.task.id);
    ElMessage.success('订单已取消，该日期已跳过');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error((e as {response?:{data?:{error?:string}}}).response?.data?.error ?? '取消结果未确认，请刷新查看状态');
  } finally {
    if (skippingDate.value) await loadDetail(id);
    skippingDate.value = false;
  }
}
async function toggleSkipDate(row: PlanDateEntry): Promise<void> {
  if (!detailPlan.value || skippingDate.value) return;
  const id = detailPlan.value.id;
  const skipped = !row.manuallySkipped;
  try {
    await ElMessageBox.confirm(skipped ? `跳过 ${row.travelDate}？该日期将不再自动购票，其他日期不受影响。` : `恢复 ${row.travelDate} 的购票安排？如果已开售，启用中的计划可能立即开始购票。`, skipped ? '跳过这一天' : '恢复购票', { confirmButtonText: skipped ? '确认跳过' : '确认恢复', cancelButtonText: '取消', type: 'warning' });
    skippingDate.value = true;
    await planApi.skipDate(id, row.travelDate, skipped);
    await loadDetail(id);
    ElMessage.success(skipped ? '已跳过该日期' : '已恢复购票安排');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error((e as {response?:{data?:{error?:string}}}).response?.data?.error ?? '修改失败，请重试');
  } finally { skippingDate.value = false; }
}
/** 计划详情数据是否正在加载（也用于刷新按钮的 loading 态） */
const detailLoading = ref(false);
let detailRequestVersion = 0;
let detailRefreshing = false;
let detailPoll: ReturnType<typeof setInterval> | undefined;
watch(detailVisible, visible => {
  clearInterval(detailPoll);
  if (visible) detailPoll = setInterval(() => {
    if (detailPlan.value && !detailRefreshing) void loadDetail(detailPlan.value.id, true);
  }, 5000);
  else { ++detailRequestVersion; detailRefreshing = false; detailLoading.value = false; }
});
onUnmounted(() => { clearInterval(detailPoll); ++detailRequestVersion; });
const detailNow = ref(new Date());
function detailStatus(row: PlanDateEntry): string {
  return planDateStatus(row, detailPlan.value?.status ?? 'active', loggedIn.value, detailNow.value);
}
const nextDetailRow = computed(() => detailRows.value.find(row => row.travelDate >= todayCn(detailNow.value)
  && !row.manuallySkipped && !['success', 'failed', 'skipped', 'cancelled'].includes(row.task?.status ?? '')));

const taskStatusType: Record<string, string> = {
  pending: 'info',
  queried: 'info',
  queued: 'warning',
  running: 'warning',
  success: 'success',
  failed: 'danger',
  skipped: 'info',
  cancelled: 'info',
};

/** 起售时间 → 北京时间可读串（接口返回 ISO，可能是 +08:00 或 Z） */
function fmtSaleAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const cn = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${cn.getFullYear()}-${p(cn.getMonth() + 1)}-${p(cn.getDate())} ${p(cn.getHours())}:${p(cn.getMinutes())}`;
}

/** 当前正在执行的任务（running / queried 中最近一条） */
const activeTask = computed<TaskSnapshot | null>(() => {
  const running = detailRows.value.map((r) => r.task).filter(Boolean) as TaskSnapshot[];
  return (
    running.find((t) => t.status === 'running') ??
    running.find((t) => t.status === 'queued') ??
    running.find((t) => t.status === 'queried') ??
    null
  );
});
const activeDetailStatus = computed(() => {
  const row = detailRows.value.find(row => row.task?.id === activeTask.value?.id && row.task);
  return row ? detailStatus(row) : '';
});

/** 已完成只统计已成功购票的日期。 */
const doneCount = computed(
  () => detailRows.value.filter((r) => r.task?.status === 'success').length,
);

async function openDetail(p: Plan): Promise<void> {
  detailRows.value = [];
  detailPlan.value = p;
  detailVisible.value = true;
  await loadDetail(p.id);
}

/** 手动刷新当前打开的详情 */
function refreshDetail(): void {
  if (detailPlan.value) void loadDetail(detailPlan.value.id);
}

async function loadDetail(id: string, quiet = false): Promise<void> {
  const version = ++detailRequestVersion;
  detailRefreshing = true;
  detailLoading.value = !quiet;
  try {
    const rows = await planApi.dates(id);
    if (detailPlan.value?.id !== id || version !== detailRequestVersion) return;
    detailNow.value = new Date();
    detailRows.value = rows;
    if (!quiet && loggedIn.value && rows.some(row => row.task?.status === 'success')) {
      // Refresh payment status and repair legacy seat summaries without purchasing.
      try {
        await ordersApi.list();
        const fresh = await planApi.dates(id);
        if (detailPlan.value?.id === id && version === detailRequestVersion) detailRows.value = fresh;
      } catch { /* Keep the unverified label when official order details are unavailable. */ }
    }
  } catch (e) {
    if (version !== detailRequestVersion || quiet) return;
    ElMessage.error('加载执行历史失败：' + String(e));
    detailRows.value = [];
  } finally {
    if (version === detailRequestVersion) { detailLoading.value = false; detailRefreshing = false; }
  }
}

/** 手动重试失败/已跳过的任务（如登录失效导致 failed 后，重新扫码登录再来一次） */
const retryingTaskId = ref<string | null>(null);
async function retryTask(row: PlanDateEntry): Promise<void> {
  if (!row.task || !detailPlan.value) return;
  retryingTaskId.value = row.task.id;
  try {
    await planApi.retryTask(detailPlan.value.id, row.task.id);
    ElMessage.success('已安排重新购票，触发器马上执行');
    await loadDetail(detailPlan.value.id);
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '重试失败');
  } finally {
    retryingTaskId.value = null;
  }
}

function closeDetail(): void {
  detailVisible.value = false;
}

onMounted(async () => {
  await load();
  // 席别选项从后端拉取（源自 12306 余票字段），前端不写死
  try {
    seatTypeOptions.value = await metaApi.seatTypes();
  } catch {
    // 拉取失败时给一组兜底，保证表单可用
    seatTypeOptions.value = [
      { code: 'ZE', name: '二等座' },
      { code: 'ZY', name: '一等座' },
      { code: 'TZ', name: '特等座' },
      { code: 'YW', name: '硬卧' },
      { code: 'RW', name: '软卧' },
      { code: 'GR', name: '高级软卧' },
      { code: 'RZ', name: '软座' },
      { code: 'YZ', name: '硬座' },
    ];
  }

  // 从车次查询页「加入计划」带过来的条件：预填站点/日期/车次并直接打开新建弹窗
  const q = router.currentRoute.value.query;
  const from = q.from ? String(q.from) : '';
  const to = q.to ? String(q.to) : '';
  const date = q.date ? String(q.date) : '';
  const train = q.train ? String(q.train) : '';
  if (from || to || train) {
    Object.assign(editing, emptyForm());
    if (from) editing.fromStation = from;
    if (to) editing.toStation = to;
    if (train) {
      editing.trainNumbers = [train];
      editing.timeFrom = null;
      editing.timeTo = null;
      editing.name = `${from} → ${to} ${train}`;
    }
    if (date) {
      editing.dateMode = 'single';
      editing.travelDate = date;
    }
    editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
    dialogVisible.value = true;
    // 用完即清，刷新页面不会重复弹出
    router.replace({ path: '/plans', query: {} });
  }
});
</script>

<template>
  <div>
    <el-card class="page-card">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <b>购票计划</b>
          <el-button type="primary" @click="openNew">新建计划</el-button>
        </div>
      </template>
      <el-table :data="plans" border>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <el-link type="primary" @click="openDetail(row)">{{ row.name }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="区间" min-width="120">
          <template #default="{ row }">{{ row.fromStation }} → {{ row.toStation }}</template>
        </el-table-column>
        <el-table-column label="日期规则" min-width="200">
          <template #default="{ row }">
            <span v-if="row.dateMode === 'single'">单次 {{ row.travelDate }}</span>
            <span v-else-if="row.dateMode === 'workweek'">
              <el-tag size="small" type="success" effect="plain">日历推算</el-tag>
              每{{ row.weekInterval }}周{{ row.weekEdge === 'end' ? '末（最后一个工作日）' : '初（首个工作日）' }}
              <span v-if="row.offsetDays">（{{ row.offsetDays < 0 ? '提前' : '延后' }} {{ Math.abs(row.offsetDays) }} 天）</span>
              <div style="color: #909399; font-size: 12px">按工作日历自动跳节假日、含调休补班（{{ row.validFrom }} 起）</div>
            </span>
            <span v-else>
              <el-tag size="small" type="info" effect="plain">固定周几</el-tag>
              每{{ row.weekInterval }}周的{{ weekdayNames[(row.weekday ?? 1) - 1] }}
              <span v-if="row.offsetDays">（{{ row.offsetDays < 0 ? '提前' : '延后' }} {{ Math.abs(row.offsetDays) }} 天）</span>
              <div style="color: #909399; font-size: 12px">不跳节假日，逢节假日照常（{{ row.validFrom }} 起）</div>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="时间/车次" min-width="160">
          <template #default="{ row }">
            <div>{{ row.timeFrom ?? '--' }} ~ {{ row.timeTo ?? '--' }}</div>
            <div class="mono">{{ row.trainNumbers ? row.trainNumbers.join(', ') : '自动匹配' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="座位/席别" width="130">
          <template #default="{ row }">
            <div>{{ row.seatPositions ? row.seatPositions.join('/') : '不指定' }}</div>
            <div style="font-size: 12px; color: #909399">{{ seatTypeName(row.seatTypes) }}</div>
            <el-tag v-if="row.allowNoSeat" size="small" type="warning" style="margin-top: 2px">允许无座</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : row.status === 'paused' ? 'warning' : 'info'">
              {{ row.status === 'active' ? '进行中' : row.status === 'paused' ? '已暂停' : '已删除' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd: string) => void handlePlanCommand(cmd, row)">
              <el-button size="small" plain>操作<span class="plan-caret" /></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">编辑</el-dropdown-item>
                  <el-dropdown-item v-if="row.status !== 'paused'" command="pause">暂停执行</el-dropdown-item>
                  <el-dropdown-item v-else command="resume">恢复执行</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除计划</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 计划详情：执行历史 + 当前动作 -->
    <el-drawer
      v-model="detailVisible"
      :title="detailPlan ? `计划详情：${detailPlan.name}` : '计划详情'"
      direction="rtl"
      size="min(760px, 100vw)"
      :before-close="closeDetail"
    >
      <template v-if="detailPlan">
        <!-- 当前动作 -->
        <el-card v-if="activeTask" class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-row">
            <el-tag :type="(taskStatusType[activeTask.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'" effect="dark" size="large">
              {{ activeDetailStatus }}
            </el-tag>
            <span class="da-date">{{ activeTask.travelDate }} {{ activeTask.trainNumber ? `· ${activeTask.trainNumber}` : '· 自动匹配车次' }}</span>
          </div>
          <div class="da-meta">
            <span v-if="detailPlan.status === 'paused'">恢复计划后继续购票</span>
            <span v-else-if="activeTask.status === 'queried' && !loggedIn">请先连接 12306 账号</span>
            <span v-else-if="activeTask.status === 'queried' && activeTask.saleAt && Date.parse(activeTask.saleAt) > detailNow.getTime()">{{ fmtSaleAt(activeTask.saleAt) }} 开售后自动购票</span>
            <span v-else-if="activeTask.status === 'queried'">已开售，等待购票</span>
            <span v-else-if="activeTask.status === 'running'">已进入购票流程，请稍候…</span>
            <span v-else-if="activeTask.status === 'queued'">已排队，即将开始</span>
          </div>
        </el-card>
        <el-card v-else class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-meta" style="margin: 6px 0">{{ nextDetailRow ? `${nextDetailRow.travelDate} · ${detailStatus(nextDetailRow)}` : '暂无待购票行程' }}</div>
        </el-card>

        <!-- 执行历史 -->
        <div class="detail-sec-title">
          购票安排 <span class="detail-count">共 {{ detailRows.length }} 个乘车日期，已完成 {{ doneCount }}</span>
          <el-button class="detail-refresh" size="small" :loading="detailLoading" @click="refreshDetail">刷新</el-button>
        </div>
        <el-radio-group v-model="detailView" size="small" aria-label="购票安排显示方式" style="margin-bottom:12px">
          <el-radio-button value="calendar">日历</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <PlanScheduleCalendar v-if="detailView === 'calendar' && detailRows.length > 0" :rows="detailRows" :status="detailStatus" :editable="canSkipDate" :busy="skippingDate" :cancelable="canCancelDate" @skip="toggleSkipDate" @cancel="cancelAndSkipDate" />
        <el-table v-if="detailView === 'list'" v-loading="detailLoading" :data="detailRows" border size="small" max-height="520">
          <el-table-column label="乘车日期" prop="travelDate" width="110" />
          <el-table-column label="开售情况" width="150">
            <template #default="{ row }">
              <div class="mono" style="font-size: 12px">
                {{ saleLabel(row, detailNow) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="购票状态" width="100">
            <template #default="{ row }">
              <el-tag
                :type="(taskStatusType[row.task?.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'"
                size="small"
              >
                {{ detailStatus(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="结果" min-width="120">
            <template #default="{ row }">
              <div v-if="row.task?.status === 'success' && row.task.result" class="mono" style="color: #67c23a">
                <div>{{ row.task.result.trainCode }} · {{ row.task.result.seatInfoSource ? row.task.result.seatInfo : '席别待核实' }}<span v-if="row.task.result.seatInfoSource === 'submitted'">（下单席别）</span></div>
                <div v-if="row.task.result.orderNo">订单 {{ row.task.result.orderNo }}</div>
              </div>
              <div v-else-if="row.task?.error">
                <div class="mono" style="color: #f56c6c; font-size: 12px">{{ row.task.error }}</div>
                <el-button
                  v-if="!row.manuallySkipped && (row.task.status === 'failed' || row.task.status === 'skipped')"
                  size="small"
                  link
                  type="primary"
                  :loading="retryingTaskId === row.task.id"
                  style="margin-top: 2px"
                  @click="void retryTask(row)"
                >重试</el-button>
              </div>
              <div v-else style="color: #c0c4cc; font-size: 12px">—</div>
            </template>
          </el-table-column>
          <el-table-column label="安排" width="135" fixed="right">
            <template #default="{ row }">
              <el-button v-if="canSkipDate(row)" link type="primary" size="small" :loading="skippingDate" @click="toggleSkipDate(row)">{{ row.manuallySkipped ? '恢复购票' : '跳过' }}</el-button>
              <el-button v-else-if="canCancelDate(row)" link type="danger" size="small" :loading="skippingDate" @click="cancelAndSkipDate(row)">取消订单并跳过</el-button>
              <span v-else>—</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="detail-tip">状态每 5 秒自动更新。“已开售”表示进入售票期，购票进度请看“购票状态”。</div>
      </template>
    </el-drawer>

    <el-dialog class="plan-editor-dialog" append-to-body top="4vh" v-model="dialogVisible" :title="editing.id ? '编辑计划' : '新建购票计划'" width="660px" :close-on-click-modal="false">
      <el-form label-width="104px" label-position="right">
        <!-- 基本信息 -->
        <div class="form-section">行程</div>
        <el-form-item label="计划名称">
          <el-input v-model="editing.name" placeholder="如：南京到上海 每周一" maxlength="64" show-word-limit />
        </el-form-item>
        <el-form-item label="出发站">
          <el-autocomplete
            v-model="editing.fromStation"
            :fetch-suggestions="searchStations"
            placeholder="输入站名或拼音首字母，如 南京 / NJ"
            :trigger-on-focus="false"
            clearable
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="到达站">
          <el-autocomplete
            v-model="editing.toStation"
            :fetch-suggestions="searchStations"
            placeholder="输入站名或拼音首字母，如 上海 / SH"
            :trigger-on-focus="false"
            clearable
            style="width: 100%"
          />
        </el-form-item>

        <!-- 出行频率 -->
        <div class="form-section">出行频率</div>
        <el-form-item label="怎么走">
          <el-radio-group v-model="editing.dateMode">
            <el-radio value="single">只走一次</el-radio>
            <el-radio value="recurring">每周固定周几</el-radio>
            <el-radio value="workweek">按工作周（自动跳节假日）</el-radio>
          </el-radio-group>
          <div class="form-hint">
            {{ editing.dateMode === 'single' ? '一次性购票，指定具体乘车日期。'
              : editing.dateMode === 'workweek' ? '系统按国务院工作日历推算：自动跳过法定节假日、识别调休补班日，数据未公布的年份按自然周推算。'
              : '纯按日历周期，逢节假日不跳过（如国庆周照常）。' }}
          </div>
        </el-form-item>
        <el-form-item v-if="editing.dateMode === 'single'" label="乘车日期">
          <el-date-picker v-model="editing.travelDate" type="date" value-format="YYYY-MM-DD" placeholder="选择乘车日期" :disabled-date="isPastDate" style="width: 100%" />
        </el-form-item>
        <template v-else-if="editing.dateMode === 'workweek'">
          <el-form-item label="每周哪天">
            <el-radio-group v-model="editing.weekEdge">
              <el-radio value="start">工作周第一天</el-radio>
              <el-radio value="end">工作周最后一天</el-radio>
            </el-radio-group>
            <div class="form-hint">取完整工作周的首个 / 最后一个工作日，包含节假日调整和调休补班；本周目标日已过则跳到下一周期。</div>
          </el-form-item>
          <el-form-item label="每几周走">
            <el-input-number v-model="editing.weekInterval" :min="1" :max="4" />
            <span class="form-inline">周一次</span>
          </el-form-item>
          <el-form-item label="日期微调">
            <el-input-number v-model="editing.offsetDays" :min="-6" :max="6" />
            <span class="form-inline">天（0=按日历，负=提前，正=延后）</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="每周周几">
            <el-select v-model="editing.weekday" style="width: 120px">
              <el-option v-for="(n, i) in weekdayNames" :key="i" :label="n" :value="i + 1" />
            </el-select>
          </el-form-item>
          <el-form-item label="每几周走">
            <el-input-number v-model="editing.weekInterval" :min="1" :max="4" />
            <span class="form-inline">周一次</span>
          </el-form-item>
          <el-form-item label="日期微调">
            <el-input-number v-model="editing.offsetDays" :min="-6" :max="6" />
            <span class="form-inline">天（0=按日历，负=提前，正=延后）</span>
          </el-form-item>
        </template>
        <el-form-item v-if="editing.dateMode !== 'single'" label="开始日期">
          <el-date-picker v-model="editing.validFrom" type="date" value-format="YYYY-MM-DD" placeholder="从哪天开始执行" style="width: 100%" />
          <div class="form-hint">仅限定生效范围，不代表首次乘车日期。预览和余票查询均按规则取有效出行日期。</div>
        </el-form-item>
        <el-form-item v-if="editing.dateMode !== 'single'" label="结束日期">
          <el-date-picker v-model="editing.validUntil" type="date" value-format="YYYY-MM-DD" placeholder="不填=一直执行" style="width: 100%" />
        </el-form-item>

        <!-- 车次与座位 -->
        <div class="form-section">车次与座位</div>
        <el-form-item label="出发时间段">
          <el-time-picker v-model="editing.timeFrom" format="HH:mm" value-format="HH:mm" placeholder="如 08:00" />
          <span style="margin: 0 8px">至</span>
          <el-time-picker v-model="editing.timeTo" format="HH:mm" value-format="HH:mm" placeholder="如 09:00" />
          <div class="form-hint">只买这个时间段内发车的车次。</div>
        </el-form-item>
        <el-form-item label="车次">
          <div class="train-row">
            <el-select
              v-model="editing.trainNumbers"
              multiple
              filterable
              allow-create
              placeholder="不填=按时间段自动匹配"
              class="train-select"
            >
              <el-option v-for="code in editing.trainNumbers ?? []" :key="code" :label="code" :value="code" />
            </el-select>
            <el-button plain type="primary" @click="openTrainSearch">查车次余票</el-button>
          </div>
          <div class="form-hint">查询后可多选车次，也可直接输入车次号；不选则按时间段自动匹配。</div>
          <div v-for="segment in editing.trainSegments ?? []" :key="segmentKey(segment)" class="form-hint">{{ segment.trainCode }} · {{ segment.fromStation }} → {{ segment.toStation }}</div>
        </el-form-item>
        <el-form-item label="座位位置">
          <el-select v-model="editing.seatPositions" multiple placeholder="靠窗 / 过道偏好（可多选）">
            <el-option v-for="s in seatOptions" :key="s" :label="`${s}（${seatPositionHint[s]}）`" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="席别">
          <el-select v-model="editing.seatTypes" multiple placeholder="想买哪种席别（可多选）">
            <el-option v-for="st in seatTypeOptions" :key="st.code" :label="st.name" :value="st.code" />
          </el-select>
          <div class="form-hint">严格按所选席别买，售罄不回退到其他席别；不购买商务座。</div>
        </el-form-item>
        <el-form-item label="无座票">
          <el-switch v-model="editing.allowNoSeat" />
          <span class="form-inline" style="margin-left: 10px">
            默认关闭：所选席别卖光就放弃并告警；开启后接受无座票。
          </span>
        </el-form-item>

        <!-- 乘车人 -->
        <div class="form-section">乘车人</div>
        <el-alert v-if="!passengers.length" title="暂无乘车人，请先从 12306 同步联系人" type="warning" :closable="false" />
        <el-button text type="primary" :loading="sessionSyncing" :disabled="!loggedIn" @click="async () => { await syncPassengers(); await load(); }">同步并刷新乘车人</el-button>
        <el-form-item label="乘车人">
          <el-select v-model="editing.passengerIds" multiple placeholder="选择要购票的乘车人" style="width: 100%">
            <el-option v-for="p in passengers" :key="p.id" :label="`${p.name}（${p.passengerType}）`" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :loading="previewing" @click="preview">预览购票日期</el-button>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存计划</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="trainSearchVisible" title="选择车次" width="800px" top="6vh" append-to-body class="plan-editor-dialog train-picker-dialog" :close-on-click-modal="false">
      <div class="train-panel-bar">
        <div class="train-panel-cond">
          <strong>{{ editing.fromStation }} → {{ editing.toStation }}</strong>
          <div class="train-panel-date">{{ searchDate ?? (trainLoading ? '正在推算日期…' : '待查询') }} · {{ editing.dateMode === 'single' ? '乘车日期' : '首个有效出行日' }}</div>
          <div class="train-panel-date">出发 {{ editing.timeFrom || '00:00' }}–{{ editing.timeTo || '23:59' }}<span v-if="!trainLoading && trainSearched && !trainSearchError"> · {{ visibleTrains.length }} 班</span></div>
        </div>
        <el-button :loading="trainLoading" @click="searchTrains">刷新余票</el-button>
      </div>
      <el-alert v-if="!loggedIn" type="warning" :closable="false" title="请先连接 12306，再查询车次余票。" />
      <div v-if="trainLoading" class="train-panel-empty" role="status">正在查询余票…</div>
      <div v-else-if="visibleTrains.length" class="train-results" role="list" aria-label="车次余票">
        <div v-for="(train, index) in visibleTrains" :key="`${train.trainCode}-${train.fromStation}-${train.toStation}-${index}`" class="train-result" :class="{ 'train-result-selected': isTrainSelected(train) }" role="listitem">
          <div class="train-result-header">
            <el-checkbox :model-value="isTrainSelected(train)" :aria-label="`选择 ${train.trainCode} ${train.fromStation}至${train.toStation}`" @change="toggleTrain(train)">{{ train.trainCode }}</el-checkbox>
            <strong class="mono train-result-time">{{ train.departTime }} → {{ train.arriveTime }}</strong>
            <span class="train-result-duration">历时 {{ train.duration }}</span>
          </div>
          <div class="train-result-route">{{ train.fromStation }} → {{ train.toStation }}</div>
          <div class="seat-list" aria-label="各席别余票">
            <span v-for="(count, name) in (train.seats ?? {})" :key="name" class="seat-chip" :style="{ color: seatColor(count) }">{{ name }} {{ count }}</span>
            <span v-if="!Object.keys(train.seats ?? {}).length" class="train-result-duration">暂无席别信息</span>
          </div>
        </div>
      </div>
      <div v-else-if="loggedIn" class="train-panel-empty">{{ trainSearchError || (trainSearched ? '当前条件下暂无车次，请返回调整日期或出发时间段' : '点击刷新余票查询车次') }}</div>
      <template #footer>
        <div class="train-selection-summary">
          <span>已选 {{ selectedTrainCount }} 项</span>
          <el-button v-if="selectedTrainCount" link type="primary" @click="clearTrainSelection">清空</el-button>
          <span v-else class="train-result-duration">不选则按时间段自动匹配</span>
        </div>
        <div v-if="selectedTrainCount" class="train-selected-tags">
          <el-tag v-for="code in selectedTrainCodes" :key="code" closable @close="selectedTrainCodes = selectedTrainCodes.filter(c => c !== code)">{{ code }}（未限定站点）</el-tag>
          <el-tag v-for="segment in selectedTrainSegments" :key="segmentKey(segment)" closable @close="toggleTrain(segment)">{{ segment.trainCode }} · {{ segment.fromStation }} → {{ segment.toStation }}</el-tag>
        </div>
        <div class="train-selection-actions">
          <el-button @click="trainSearchVisible = false">取消</el-button>
          <el-button type="primary" @click="confirmTrainSelection">确定</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog class="plan-editor-dialog" append-to-body top="6vh" v-model="previewVisible" title="购票日期推算结果" width="620px">
      <div class="pv-toolbar">
        <div class="pv-legend">
          共 <b style="color: #409eff">{{ previewRows.length }}</b> 个购票日期
          <span class="pv-key"><i class="pv-dot pv-ok" />正常</span>
          <span class="pv-key"><i class="pv-dot pv-warn" />节假日顺延</span>
        </div>
        <div class="pv-nav">
          <el-button size="small" @click="pvShift(-1)">‹</el-button>
          <span class="pv-title">{{ pvTitle }}</span>
          <el-button size="small" @click="pvShift(1)">›</el-button>
          <el-button size="small" text @click="pvToFirst">首个日期</el-button>
        </div>
      </div>
      <el-alert
        v-if="pvCalendarPending"
        class="pv-pending"
        type="warning"
        :closable="false"
        :title="`${pvMonth.getFullYear()} 年的放假安排尚未公布，日历暂按自然周推算。国务院发布后系统会自动更新。`"
      />
      <div v-if="!previewRows.length" class="pv-empty">该生效区间内没有可推算的购票日期</div>
      <template v-else>
        <div class="pv-grid pv-head">
          <div v-for="w in WEEK_LABELS" :key="w" class="pv-cell pv-week">{{ w }}</div>
        </div>
        <div class="pv-grid">
          <template v-for="(cell, i) in pvCells" :key="i">
            <div
              v-if="cell"
              class="pv-cell"
              :class="{
                'pv-has': cell.entry,
                'pv-post': cell.entry?.postponed,
              }"
            >
              <CalendarDayHeader :date="cell.date" :holiday="pvHolidayOf(cell.date)" :today="cell.date === todayCn()" />
              <div v-if="cell.entry" class="pv-entry" :title="cell.entry.note || (cell.entry.originalDate !== cell.entry.travelDate ? `原始推算 ${cell.entry.originalDate}` : '')">
                <div class="pv-line">
                  <i class="pv-dot pv-ok" /><span>乘车</span>
                  <el-tag v-if="cell.entry.postponed" size="small" type="warning">顺延</el-tag>
                </div>
                <div class="pv-sale">起售 {{ cell.entry.estimatedSaleDate.slice(5) }}</div>
              </div>
            </div>
            <div v-else class="pv-cell pv-blank" />
          </template>
        </div>
        <div v-if="!pvMonthEntries.length" class="pv-empty">本月没有购票日期，用 ‹ › 切换到其他月份</div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ---- 新建/编辑计划表单：分区标题与行内提示 ---- */
.form-section {
  font-weight: 700;
  font-size: 13px;
  color: #303133;
  margin: 4px 0 12px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
.form-hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
  margin-top: 4px;
}
.form-inline {
  font-size: 12px;
  color: #909399;
  margin-left: 6px;
}

.pv-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.pv-legend {
  font-size: 12px;
  color: #909399;
}
.pv-key {
  margin-left: 10px;
}
.pv-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}
.pv-ok {
  background: #67c23a;
}
.pv-warn {
  background: #e6a23c;
}
.pv-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-title {
  min-width: 110px;
  text-align: center;
  font-weight: 600;
  font-size: 13px;
}
.pv-empty {
  color: #909399;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
}
.pv-pending {
  margin-bottom: 10px;
}
.pv-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.pv-head {
  margin-bottom: 6px;
}
.pv-cell {
  min-height: 72px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 4px 6px;
  background: #fff;
}
.pv-week {
  min-height: auto;
  text-align: center;
  font-size: 12px;
  color: #909399;
  border: none;
  background: transparent;
  padding: 2px 0;
}
.pv-blank {
  background: #fafafa;
  border-color: #f5f5f5;
}
.pv-has {
  background: #f0f9eb;
  border-color: #c2e7b0;
}
.pv-post {
  background: #fdf6ec;
  border-color: #f5dab1;
}
.pv-entry {
  font-size: 11px;
}
.pv-line {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #529b2e;
}
.pv-post .pv-line {
  color: #b88230;
}
.pv-post .pv-dot {
  background: #e6a23c;
}
.pv-sale {
  color: #909399;
  font-size: 10px;
  margin-top: 2px;
}

.train-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.train-select {
  min-width: 0;
  flex: 1;
}

/* ---- 选择车次：紧凑列表，底部固定保留选择和确认操作 ---- */
.train-panel-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 12px; }
.train-panel-cond { min-width: 0; line-height: 1.6; font-size: 14px; color: #303133; }
.train-panel-bar > .el-button { flex-shrink: 0; }
.train-panel-date { color: #909399; font-size: 12px; }
.train-panel-empty { padding: 40px 12px; text-align: center; font-size: 13px; color: #909399; }
.train-results { min-height: 0; max-height: 60dvh; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid #ebeef5; }
.train-result { padding: 8px 10px; border-bottom: 1px solid #ebeef5; line-height: 1.5; }
.train-result-selected { background: #f0f7ff; }
.train-result-header { display: flex; align-items: center; gap: 20px; }
.train-result-header .el-checkbox { margin-right: 0; height: 22px; min-width: 90px; }
.train-result-header :deep(.el-checkbox__label) { font-size: 14px; font-weight: 600; }
.train-result-time { font-size: 14px; color: #303133; white-space: nowrap; }
.train-result-duration { color: #909399; font-size: 12px; }
.train-result-header > .train-result-duration { margin-left: auto; }
.train-result-route { margin: 2px 0 2px 22px; font-size: 12px; color: #606266; overflow-wrap: anywhere; }
.seat-list { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-left: 22px; }
.seat-chip { font-size: 12px; white-space: nowrap; }
.train-selection-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 13px; color: #606266; }
.train-selected-tags { display: flex; flex-wrap: wrap; gap: 6px; max-height: 64px; overflow-y: auto; margin-top: 8px; }
.train-selection-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.train-selection-actions > .el-button { margin-left: 0; }
@media (max-width: 560px) {
  .train-result-header { flex-wrap: wrap; gap: 4px 12px; }
  .train-result-header .el-checkbox { min-width: 78px; }
  .train-result-header > .train-result-duration { margin-left: 22px; }
}

/* ---- 操作栏：「操作」下拉（详情走名称链接，这里只留编辑/暂停·恢复/删除）---- */
.plan-caret {
  display: inline-block;
  width: 0;
  height: 0;
  margin-left: 3px;
  border: 4px solid transparent;
  border-top-color: currentColor;
  vertical-align: -2px;
}

/* ---- 计划详情抽屉 ---- */
.detail-active {
  margin-bottom: 14px;
}
.detail-active :deep(.el-card__body) {
  padding: 12px 14px;
}
.da-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}
.da-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.da-date {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}
.da-meta {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
.detail-sec-title {
  display: flex;
  align-items: center;
  font-weight: 700;
  font-size: 14px;
  margin: 4px 0 10px;
}
.detail-refresh {
  margin-left: auto;
}
.detail-count {
  font-weight: 400;
  font-size: 12px;
  color: #909399;
  margin-left: 6px;
}
.detail-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #c0c4cc;
}
</style>
