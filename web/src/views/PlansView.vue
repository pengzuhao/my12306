<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  planApi,
  passengerApi,
  calendarApi,
  type PlanForm,
  type HolidayDay,
  type PlanDateEntry,
  type TaskSnapshot,
} from '../api';

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
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

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
  const startWeekday = new Date(y, m, 1).getDay();
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
      const yearDays = await calendarApi.holidaysOfYear(y);
      pvHolidaysByYear.set(y, yearDays);
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

async function reloadPvHolidays(): Promise<void> {
  const y = pvMonth.value.getFullYear();
  const m = pvMonth.value.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, '0')}-`;
  // 年度缓存命中：同步切片返回，无网络延迟
  const cached = pvHolidaysByYear.get(y);
  if (cached) {
    pvHolidays.value = cached.filter((h) => h.date.startsWith(prefix));
    return;
  }
  // 首次访问该年：一次接口拿全年数据，之后该年内切月份不再请求
  // 失败时清空该年标记并提示——节假日数据是工作周推算的前提，不能静默吞掉
  try {
    const yearDays = await calendarApi.holidaysOfYear(y);
    pvHolidaysByYear.set(y, yearDays);
    pvHolidays.value = yearDays.filter((h) => h.date.startsWith(prefix));
  } catch {
    pvHolidaysByYear.delete(y);
    pvHolidays.value = [];
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
      pvHolidaysByYear.set(y, await calendarApi.holidaysOfYear(y));
    } catch {
      ElMessage.error(`${y} 年节假日数据加载失败，日历标记暂不可用`);
    }
  }
  pvMonth.value = new Date(y, Number(first.travelDate.slice(5, 7)) - 1, 1);
}

/** 席别代码 → 中文名（计划列表展示用） */
function seatTypeName(codes?: string[] | null): string {
  if (!codes || !codes.length) return '二等座';
  const map: Record<string, string> = {
    ZE: '二等座', ZY: '一等座', TZ: '特等座', YW: '硬卧', RW: '软卧', GR: '高级软卧', RZ: '软座', YZ: '硬座',
  };
  return codes.map((c) => map[c] ?? c).join('/');
}

function emptyForm(): PlanForm {
  return {
    name: '',
    fromStation: '',
    toStation: '',
    dateMode: 'recurring',
    travelDate: null,
    weekday: 1,
    weekEdge: 'start',
    weekInterval: 1,
    offsetDays: 0,
    validFrom: new Date().toISOString().slice(0, 10),
    validUntil: null,
    timeFrom: '08:00',
    timeTo: '09:00',
    trainNumbers: null,
    seatPositions: ['A', 'F'],
    seatTypes: ['ZE'],
    allowNoSeat: false,
    passengerIds: [],
  };
}

const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const seatOptions = ['A', 'B', 'C', 'D', 'F'];
/** 席别选项（不含商务座 SWZ：用户明确要求不买商务座） */
const seatTypeOptions = [
  { code: 'ZE', name: '二等座' },
  { code: 'ZY', name: '一等座' },
  { code: 'TZ', name: '特等座' },
  { code: 'YW', name: '硬卧' },
  { code: 'RW', name: '软卧' },
  { code: 'GR', name: '高级软卧' },
  { code: 'RZ', name: '软座' },
  { code: 'YZ', name: '硬座' },
];

async function load(): Promise<void> {
  plans.value = (await planApi.list()) as Plan[];
  passengers.value = (await passengerApi.list()) as Passenger[];
}

function openNew(): void {
  Object.assign(editing, emptyForm());
  editing.passengerIds = passengers.value.length ? [passengers.value[0].id] : [];
  dialogVisible.value = true;
}

function openEdit(p: Plan): void {
  Object.assign(editing, JSON.parse(JSON.stringify(p)));
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!editing.name || !editing.fromStation || !editing.toStation) {
    ElMessage.warning('请填写计划名称与起止站点');
    return;
  }
  if (!editing.passengerIds.length) {
    ElMessage.warning('请至少选择一名乘车人');
    return;
  }
  if (!editing.seatPositions || !editing.seatPositions.length) {
    ElMessage.warning('请选择座位偏好（必填：A/F 靠窗、C/D 过道）');
    return;
  }
  if (!editing.seatTypes || !editing.seatTypes.length) {
    ElMessage.warning('请选择席别（必填：购票时按所选席别严格匹配）');
    return;
  }
  try {
    await planApi.save(editing);
    ElMessage.success('计划已保存');
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '保存失败');
  }
}

async function setStatus(id: string, status: 'active' | 'paused' | 'deleted'): Promise<void> {
  await planApi.setStatus(id, status);
  await load();
}

async function confirmDelete(id: string): Promise<void> {
  await ElMessageBox.confirm('确认删除该计划？关联任务将不再执行', '提示', { type: 'warning' });
  await setStatus(id, 'deleted');
}

async function preview(): Promise<void> {
  try {
    previewRows.value = (await planApi.previewDates(editing)) as PreviewEntry[];
    await pvToFirst();
    await reloadPvHolidays();
    previewVisible.value = true;
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(e);
    ElMessage.error('推算失败：' + msg);
  }
}

// ---- 计划详情抽屉：执行历史 + 当前动作 ----
const detailVisible = ref(false);
const detailPlan = ref<Plan | null>(null);
const detailRows = ref<PlanDateEntry[]>([]);
/** 计划详情数据是否正在加载（也用于刷新按钮的 loading 态） */
const detailLoading = ref(false);

/** 任务状态 → 中文显示名 */
const taskStatusName: Record<string, string> = {
  pending: '待查起售时间',
  queried: '待起售',
  queued: '排队中',
  running: '正在购票',
  success: '已购票',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
};
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
    running.find((t) => t.status === 'queried') ??
    running.find((t) => t.status === 'queued') ??
    null
  );
});

/** 执行历史里有结果的条数（成功 + 失败） */
const doneCount = computed(
  () => detailRows.value.filter((r) => r.task?.status === 'success' || r.task?.status === 'failed').length,
);

async function openDetail(p: Plan): Promise<void> {
  detailPlan.value = p;
  detailVisible.value = true;
  await loadDetail(p.id);
}

/** 手动刷新当前打开的详情 */
function refreshDetail(): void {
  if (detailPlan.value) void loadDetail(detailPlan.value.id);
}

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true;
  try {
    detailRows.value = await planApi.dates(id);
  } catch (e) {
    ElMessage.error('加载执行历史失败：' + String(e));
    detailRows.value = [];
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  detailVisible.value = false;
}

onMounted(load);
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
        <el-table-column label="操作" width="240">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail(row)">详情</el-button>
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status !== 'paused'" size="small" @click="setStatus(row.id, 'paused')">暂停</el-button>
            <el-button v-if="row.status === 'paused'" size="small" type="success" @click="setStatus(row.id, 'active')">恢复</el-button>
            <el-button size="small" type="danger" @click="confirmDelete(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 计划详情：执行历史 + 当前动作 -->
    <el-drawer
      v-model="detailVisible"
      :title="detailPlan ? `计划详情：${detailPlan.name}` : '计划详情'"
      direction="rtl"
      size="560px"
      :before-close="closeDetail"
    >
      <template v-if="detailPlan">
        <!-- 当前动作 -->
        <el-card v-if="activeTask" class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-row">
            <el-tag :type="(taskStatusType[activeTask.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'" effect="dark" size="large">
              {{ taskStatusName[activeTask.status] ?? activeTask.status }}
            </el-tag>
            <span class="da-date">{{ activeTask.travelDate }} {{ activeTask.trainNumber ? `· ${activeTask.trainNumber}` : '· 自动匹配车次' }}</span>
          </div>
          <div class="da-meta">
            <span v-if="activeTask.status === 'queried' && activeTask.saleAt">起售时间 {{ fmtSaleAt(activeTask.saleAt) }} 到点自动购票</span>
            <span v-else-if="activeTask.status === 'running'">已进入购票流程，请稍候…</span>
            <span v-else-if="activeTask.status === 'queued'">已排队，即将开始</span>
          </div>
        </el-card>
        <el-card v-else class="page-card detail-active" shadow="never">
          <div class="da-label">当前进行</div>
          <div class="da-meta" style="margin: 6px 0">暂无正在执行的任务——下一班车票起售前会自动生成任务。</div>
        </el-card>

        <!-- 执行历史 -->
        <div class="detail-sec-title">
          执行历史 <span class="detail-count">共 {{ detailRows.length }} 个购票日期，已完成 {{ doneCount }}</span>
          <el-button class="detail-refresh" size="small" :loading="detailLoading" @click="refreshDetail">刷新</el-button>
        </div>
        <el-table v-loading="detailLoading" :data="detailRows" border size="small" max-height="520">
          <el-table-column label="乘车日期" prop="travelDate" width="110" />
          <el-table-column label="起售时间" width="150">
            <template #default="{ row }">
              <div class="mono" style="font-size: 12px">
                {{ fmtSaleAt(row.task?.saleAt ?? null) || row.estimatedSaleDate + ' 08:00' }}
              </div>
              <div v-if="!row.task?.saleAt" style="font-size: 11px; color: #c0c4cc">推算，以实际为准</div>
            </template>
          </el-table-column>
          <el-table-column label="任务状态" width="120">
            <template #default="{ row }">
              <el-tag
                v-if="row.task"
                :type="(taskStatusType[row.task.status] ?? 'info') as 'primary' | 'warning' | 'success' | 'danger' | 'info'"
                size="small"
              >
                {{ taskStatusName[row.task.status] ?? row.task.status }}
              </el-tag>
              <span v-else style="color: #c0c4cc; font-size: 12px">待生成</span>
            </template>
          </el-table-column>
          <el-table-column label="结果" min-width="180">
            <template #default="{ row }">
              <div v-if="row.task?.result" class="mono" style="color: #67c23a">
                {{ row.task.result.trainCode }} · {{ row.task.result.seatInfo }} · 订单 {{ row.task.result.orderNo ?? '-' }}
              </div>
              <div v-else-if="row.task?.error" class="mono" style="color: #f56c6c; font-size: 12px">{{ row.task.error }}</div>
              <div v-else-if="row.postponed" style="color: #e6a23c; font-size: 12px">节假日顺延（原始 {{ row.originalDate }}）</div>
              <div v-else style="color: #c0c4cc; font-size: 12px">—</div>
            </template>
          </el-table-column>
        </el-table>
        <div class="detail-tip">点击右上方「刷新」手动更新执行历史；关闭本页面前任务会一直按计划执行。</div>
      </template>
    </el-drawer>

    <el-dialog v-model="dialogVisible" :title="editing.id ? '编辑计划' : '新建计划'" width="640px">
      <el-form label-width="110px">
        <el-form-item label="计划名称">
          <el-input v-model="editing.name" placeholder="如：南京到上海 每周一" />
        </el-form-item>
        <el-form-item label="出发站">
          <el-input v-model="editing.fromStation" placeholder="如：南京" />
        </el-form-item>
        <el-form-item label="到达站">
          <el-input v-model="editing.toStation" placeholder="如：上海" />
        </el-form-item>
        <el-form-item label="日期模式">
          <el-radio-group v-model="editing.dateMode">
            <el-radio value="single">具体日期</el-radio>
            <el-radio value="recurring">固定周几（不跳节假日）</el-radio>
            <el-radio value="workweek">工作周（日历推算，自动跳节假日）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="editing.dateMode === 'single'" label="乘车日期">
          <el-date-picker v-model="editing.travelDate" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <template v-else-if="editing.dateMode === 'workweek'">
          <el-form-item label="工作周类型">
            <el-radio-group v-model="editing.weekEdge">
              <el-radio value="start">工作周开始（首个工作日）</el-radio>
              <el-radio value="end">工作周结束（最后一个工作日）</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="提前/延后">
            <el-input-number v-model="editing.offsetDays" :min="-6" :max="6" />
            <span style="margin-left: 8px; color: #909399; font-size: 12px">天（负=提前，如 -1 提前一天；正=延后。0=按日历推算日）</span>
          </el-form-item>
          <el-form-item label="周期（周）">
            <el-input-number v-model="editing.weekInterval" :min="1" :max="4" />
          </el-form-item>
          <el-form-item label="生效日期">
            <el-date-picker v-model="editing.validFrom" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="editing.validUntil" type="date" value-format="YYYY-MM-DD" placeholder="留空=长期" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="每周周几">
            <el-select v-model="editing.weekday" style="width: 120px">
              <el-option v-for="(n, i) in weekdayNames" :key="i" :label="n" :value="i + 1" />
            </el-select>
          </el-form-item>
          <el-form-item label="提前/延后">
            <el-input-number v-model="editing.offsetDays" :min="-6" :max="6" />
            <span style="margin-left: 8px; color: #909399; font-size: 12px">天（负=提前，正=延后，0=不偏移）</span>
          </el-form-item>
          <el-form-item label="周期（周）">
            <el-input-number v-model="editing.weekInterval" :min="1" :max="4" />
          </el-form-item>
          <el-form-item label="生效日期">
            <el-date-picker v-model="editing.validFrom" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="editing.validUntil" type="date" value-format="YYYY-MM-DD" placeholder="留空=长期" />
          </el-form-item>
        </template>
        <el-form-item label="出发时间范围">
          <el-time-picker v-model="editing.timeFrom" format="HH:mm" value-format="HH:mm" placeholder="如 08:00" />
          <span style="margin: 0 8px">至</span>
          <el-time-picker v-model="editing.timeTo" format="HH:mm" value-format="HH:mm" placeholder="如 09:00" />
        </el-form-item>
        <el-form-item label="指定车次">
          <el-select v-model="editing.trainNumbers" multiple filterable allow-create placeholder="留空=按时间范围自动匹配" style="width: 100%">
            <el-option label="G1" value="G1" /><el-option label="G3" value="G3" /><el-option label="G5" value="G5" />
          </el-select>
        </el-form-item>
        <el-form-item label="座位偏好" required>
          <el-select v-model="editing.seatPositions" multiple placeholder="必选：A/F 靠窗、C/D 过道">
            <el-option v-for="s in seatOptions" :key="s" :label="s + '（' + ({ A: '靠窗', B: '中间', C: '过道', D: '过道', F: '靠窗' } as Record<string, string>)[s] + '）'" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="席别" required>
          <el-select v-model="editing.seatTypes" multiple placeholder="必选：购票时严格按所选席别匹配，售罄不回退">
            <el-option v-for="st in seatTypeOptions" :key="st.code" :label="st.name" :value="st.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="允许无座">
          <el-switch v-model="editing.allowNoSeat" />
          <span style="margin-left: 10px; color: #909399; font-size: 12px">
            默认关闭：目标席别售罄时宁可失败告警，也不买无座票。开启后接受无座。
          </span>
        </el-form-item>
        <el-form-item label="乘车人">
          <el-select v-model="editing.passengerIds" multiple style="width: 100%">
            <el-option v-for="p in passengers" :key="p.id" :label="`${p.name}（${p.passengerType}）`" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="preview">推算日期预览</el-button>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="购票日期推算结果" width="620px">
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
                'pv-holiday': pvHolidayOf(cell.date)?.holiday && !pvHolidayOf(cell.date)?.isWorkday,
                'pv-rest': !pvHolidayOf(cell.date)?.isWorkday && !pvHolidayOf(cell.date)?.holiday,
              }"
            >
                <div class="pv-day">
                {{ cell.day
                }}<span v-if="pvHolidayOf(cell.date)?.holiday && !pvHolidayOf(cell.date)?.isWorkday" class="pv-hol-tag">{{
                  pvHolidayOf(cell.date)?.holiday
                }}</span>
                <span v-else-if="pvHolidayOf(cell.date)?.holiday && pvHolidayOf(cell.date)?.isWorkday" class="pv-ban-tag">补班</span>
                <span v-else-if="!pvHolidayOf(cell.date)?.holiday && pvHolidayOf(cell.date)?.isWorkday" class="pv-work-tag">班</span>
                <span v-else-if="cell.entry" class="pv-wk"> 周{{ WEEK_LABELS[cell.entry.weekday] }}</span>
              </div>
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
.pv-day {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 3px;
}
.pv-wk {
  font-weight: 400;
  color: #909399;
  font-size: 10px;
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
/* 节假日 */
.pv-holiday {
  background: #fef0f0;
  border-color: #fbc4c4;
}
.pv-holiday .pv-day {
  color: #f56c6c;
}
.pv-hol-tag {
  margin-left: 3px;
  font-size: 9px;
  font-weight: 400;
  color: #f56c6c;
  background: #fde2e2;
  border-radius: 3px;
  padding: 0 3px;
}
/* 调休补班日 */
.pv-ban-tag {
  margin-left: 3px;
  font-size: 9px;
  font-weight: 400;
  color: #e6a23c;
  background: #fdf6ec;
  border-radius: 3px;
  padding: 0 3px;
}
/* 普通休息日（周末） */
.pv-rest .pv-day {
  color: #c0c4cc;
}
/* 普通工作日（蓝色「班」角标，不加背景，避免与乘车日/顺延日的底色冲突） */
.pv-work-tag {
  margin-left: 3px;
  font-size: 9px;
  font-weight: 400;
  color: #409eff;
  background: #ecf5ff;
  border-radius: 3px;
  padding: 0 3px;
}
.pv-sale {
  color: #909399;
  font-size: 10px;
  margin-top: 2px;
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
