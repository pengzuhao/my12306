<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { feishuApi, taskApi, ordersApi, calendarApi, type OrderRow, type HolidayDay } from '../api';
import { fmtCn } from '../utils/time';
import {
  sessionState,
  sessionLoading,
  sessionSyncing,
  startLogin,
  checkNow,
  syncPassengers,
  doLogout,
} from '../store/session';

const feishu = ref<Record<string, unknown>>({});
const stats = ref({ pending: 0, queried: 0, running: 0, success: 0, failed: 0 });
const loading = ref(false);

// ---- 车票日历：已支付车票按乘车日标记，支持乘车人筛选 ----
const orders = ref<OrderRow[]>([]);
const ordersError = ref('');
/** 日历当前展示的月份 */
const calMonth = ref(new Date());
/** 乘车人筛选：'' = 全部乘车人 */
const calPassenger = ref('');

/** 可选乘车人（全部订单去重） */
const passengers = computed(() => {
  const set = new Set<string>();
  for (const o of orders.value) for (const p of o.passengers ?? []) set.add(p);
  return [...set].sort();
});

/** 已支付车票（排除退票/未支付），按选中乘车人过滤 */
const paidOrders = computed(() =>
  orders.value.filter(
    (o) => o.status === 'paid' && (!calPassenger.value || (o.passengers ?? []).includes(calPassenger.value)),
  ),
);

interface DayCell {
  day: number;
  date: string;
  tickets: OrderRow[];
}
/** 月份网格（前置空位用 null 占位） */
const calendarCells = computed<(DayCell | null)[]>(() => {
  const y = calMonth.value.getFullYear();
  const m = calMonth.value.getMonth();
  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (DayCell | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({
      day: d,
      date: dateStr,
      tickets: paidOrders.value.filter((o) => (o.travelDateTime ?? '').slice(0, 10) === dateStr),
    });
  }
  return cells;
});

const calTitle = computed(() => `${calMonth.value.getFullYear()} 年 ${calMonth.value.getMonth() + 1} 月`);
const monthTicketCount = computed(() => calendarCells.value.reduce((n, c) => n + (c?.tickets.length ?? 0), 0));
const paidCount = computed(() => orders.value.filter((o) => o.status === 'paid').length);

/** 今天（本地时区，YYYY-MM-DD）——不能用 toISOString，那是 UTC，东八区凌晨会差一天 */
const todayStr = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

function shiftMonth(delta: number): void {
  calMonth.value = new Date(calMonth.value.getFullYear(), calMonth.value.getMonth() + delta, 1);
}

// ---- 节假日标记：当月每天的放假/补班信息 ----
const holidays = ref<HolidayDay[]>([]);

async function reloadHolidays(): Promise<void> {
  try {
    holidays.value = await calendarApi.holidays(calMonth.value.getFullYear(), calMonth.value.getMonth() + 1);
  } catch {
    holidays.value = [];
  }
}

/** 某日期的节假日信息（放假/补班），用于日历格子标记 */
function holidayOf(dateStr: string): HolidayDay | undefined {
  return holidays.value.find((h) => h.date === dateStr);
}

watch(calMonth, () => void reloadHolidays(), { immediate: false });

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 车票日历数据（12306 未登录时优雅降级为空日历） */
async function reloadOrders(): Promise<void> {
  try {
    const data = await ordersApi.list();
    orders.value = data.orders ?? [];
    ordersError.value = '';
  } catch (e) {
    orders.value = [];
    ordersError.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '车票数据加载失败';
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    feishu.value = await feishuApi.get();
    const tasks = (await taskApi.list()) as Array<{ status: string }>;
    stats.value = {
      pending: tasks.filter((t) => t.status === 'pending').length,
      queried: tasks.filter((t) => t.status === 'queried').length,
      running: tasks.filter((t) => t.status === 'running').length,
      success: tasks.filter((t) => t.status === 'success').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
    await reloadOrders();
  } finally {
    loading.value = false;
  }
}

/**
 * 12306 登录/退出后立即刷新车票日历：扫码登录成功时用户通常正停在仪表盘上，
 * 只更新会话状态不重拉车票，日历就会一直空着。
 */
watch(
  () => sessionState.value.loggedIn,
  (loggedIn, prev) => {
    if (loggedIn === prev) return;
    if (loggedIn) {
      void reloadOrders();
    } else {
      orders.value = [];
      ordersError.value = '';
    }
  },
);

onMounted(async () => {
  await reload();
  void reloadHolidays();
});
</script>

<template>
  <div class="dash">
    <el-row :gutter="14" class="stat-row">
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">本月车票</div>
          <div class="stat-value" style="color: #67c23a">{{ monthTicketCount }}</div>
          <div class="stat-sub">共 {{ paidCount }} 张已支付车票</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">飞书通知</div>
          <div class="stat-value" :style="{ color: feishu.enabled ? '#67c23a' : '#909399' }">
            {{ feishu.webhookUrl ? (feishu.enabled ? '已启用' : '已停用') : '未配置' }}
          </div>
          <div class="stat-sub">购票成功将提醒付款</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">待触发任务</div>
          <div class="stat-value" style="color: #409eff">{{ stats.queried }}</div>
          <div class="stat-sub">等待起售时刻到点抢票</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="page-card stat-card">
          <div class="stat-title">累计成功</div>
          <div class="stat-value" style="color: #67c23a">{{ stats.success }}</div>
          <div class="stat-sub">失败 {{ stats.failed }} 次</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="14" class="main-row">
      <!-- 左：车票日历（紧凑，固定一屏） -->
      <el-col :span="17" class="main-col">
        <el-card class="page-card cal-card">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
              <b>车票日历</b>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <el-select v-model="calPassenger" placeholder="全部乘车人" clearable size="small" style="width: 130px">
                  <el-option v-for="p in passengers" :key="p" :label="p" :value="p" />
                </el-select>
                <el-button size="small" @click="shiftMonth(-1)">‹</el-button>
                <span style="min-width: 104px; text-align: center; font-weight: 600; font-size: 13px">{{ calTitle }}</span>
                <el-button size="small" @click="shiftMonth(1)">›</el-button>
                <el-button size="small" text @click="calMonth = new Date()">今天</el-button>
              </div>
            </div>
          </template>

          <div v-if="ordersError" style="color: #e6a23c; margin-bottom: 6px; font-size: 12px">
            {{ ordersError }}（日历暂不可用，登录 12306 后刷新本页）
          </div>
          <div style="font-size: 12px; color: #909399; margin-bottom: 6px">
            本月已标记 <b style="color: #67c23a">{{ monthTicketCount }}</b> 张已支付车票{{ calPassenger ? `（乘车人：${calPassenger}）` : '' }}
          </div>

          <!-- 星期表头 -->
          <div class="cal-grid cal-head">
            <div v-for="w in WEEK_LABELS" :key="w" class="cal-cell cal-week">{{ w }}</div>
          </div>
          <!-- 日期网格 -->
          <div class="cal-grid">
            <template v-for="(cell, i) in calendarCells" :key="i">
              <div
                v-if="cell"
                class="cal-cell"
                :class="{
                  'cal-today': cell.date === todayStr,
                  'cal-holiday': holidayOf(cell.date)?.holiday && !holidayOf(cell.date)?.isWorkday,
                  'cal-makeUp': !holidayOf(cell.date)?.isWorkday && !holidayOf(cell.date)?.holiday,
                }"
              >
                <div class="cal-day">
                  {{ cell.day }}<span v-if="holidayOf(cell.date)?.holiday && !holidayOf(cell.date)?.isWorkday" class="cal-hol-tag">{{ holidayOf(cell.date)?.holiday }}</span>
                </div>
                <div
                  v-for="t in cell.tickets.slice(0, 1)"
                  :key="t.orderNo"
                  class="cal-ticket"
                  :title="`${t.travelDateTime} ${t.trainCode} ${t.fromStation}→${t.toStation} ${(t.passengers ?? []).join('、')}`"
                >
                  <span class="cal-train">{{ t.trainCode }}</span>
                  <span class="cal-time">{{ (t.travelDateTime ?? '').slice(11) }}</span>
                  <span class="cal-route">{{ t.fromStation }}→{{ t.toStation }}</span>
                </div>
                <div v-if="cell.tickets.length > 1" class="cal-more">+{{ cell.tickets.length - 1 }} 张</div>
              </div>
              <div v-else class="cal-cell cal-blank" />
            </template>
          </div>
        </el-card>
      </el-col>

      <!-- 右：12306 会话 + 系统说明 -->
      <el-col :span="7" class="main-col">
        <el-card class="page-card sess-card">
          <template #header><b>12306 会话</b></template>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
            <el-tag :type="sessionState.loggedIn ? 'success' : 'danger'" effect="dark">
              {{ sessionState.loggedIn ? '已登录' : '未登录' }}
            </el-tag>
            <span v-if="sessionState.userName" style="color: #606266; font-size: 13px">{{ sessionState.userName }}</span>
          </div>
          <div class="sess-meta">
            <div>最后登录：<span>{{ fmtCn(sessionState.lastLoginAt as string) }}</span></div>
            <div>最后检查：<span>{{ fmtCn(sessionState.lastCheckAt as string) }}</span></div>
            <div v-if="sessionState.failReason" style="color: #f56c6c">
              失败原因：{{ sessionState.failReason }}
            </div>
          </div>
          <div class="sess-actions">
            <el-button type="primary" size="small" :loading="sessionLoading" @click="startLogin">扫码登录</el-button>
            <el-button size="small" :loading="sessionLoading" @click="checkNow">检查会话</el-button>
            <el-button size="small" :loading="sessionSyncing" @click="syncPassengers">同步联系人</el-button>
            <el-button size="small" type="danger" :disabled="!sessionState.loggedIn" @click="doLogout">退出</el-button>
          </div>
          <el-alert type="warning" :closable="false" style="margin-top: 8px">
            <span style="font-size: 12px">本系统<b>不保存 12306 密码</b>：用 12306 APP 扫码确认即完成登录。</span>
          </el-alert>
        </el-card>

        <el-card class="page-card note-card">
          <template #header><b>系统说明</b></template>
          <ol class="note-list">
            <li>右侧「12306 会话」扫码登录（只需 12306 APP 扫码，全程不保存密码），会话自动保存并保活。</li>
            <li>在「购票计划」创建计划：指定乘车人、日期规则、时间范围、车次与座位偏好。</li>
            <li>系统自动推算购票日期（节假日顺延并标注），并在<b>车票起售时刻</b>触发购买。</li>
            <li>购票成功后<b>不会自动付款</b>，飞书会提醒你登录 12306 完成支付。</li>
            <li>会话失活时通过飞书通知你重新登录。</li>
          </ol>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
}
.stat-row {
  margin-bottom: 14px;
}
.stat-card {
  width: 100%;
  margin-bottom: 0;
}
:deep(.stat-card .el-card__body) {
  padding: 10px 14px;
}
.stat-title {
  color: #909399;
  font-size: 12px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  margin: 2px 0;
}
.stat-sub {
  color: #909399;
  font-size: 11px;
}
.main-row {
  margin-bottom: 0;
}
/* 两列均为 flex 列：日历卡与「系统说明」卡撑满列高，底部对齐 */
.main-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.main-col > .el-card {
  margin-bottom: 0;
  flex: 0 0 auto;
}
.main-col > .el-card.cal-card,
.main-col > .el-card.note-card {
  flex: 1 1 auto;
}
/* ---- 车票日历（紧凑，保证一屏装下） ---- */
.cal-card :deep(.el-card__body) {
  padding: 12px 14px;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
}
.cal-head {
  margin-bottom: 5px;
}
.cal-cell {
  min-height: 52px;
  border: 1px solid #ebeef5;
  border-radius: 5px;
  padding: 3px 5px;
  background: #fff;
  overflow: hidden;
}
.cal-week {
  min-height: auto;
  text-align: center;
  font-size: 11px;
  color: #909399;
  border: none;
  background: transparent;
  padding: 1px 0;
}
.cal-blank {
  background: #fafafa;
  border-color: #f5f5f5;
}
.cal-today {
  border-color: #409eff;
  box-shadow: inset 0 0 0 1px #409eff;
}
/* 节假日（背景淡红、日期数字红） */
.cal-holiday {
  background: #fef0f0;
}
.cal-holiday .cal-day {
  color: #f56c6c;
}
.cal-hol-tag {
  margin-left: 4px;
  font-size: 9px;
  font-weight: 400;
  color: #f56c6c;
  background: #fde2e2;
  border-radius: 3px;
  padding: 0 3px;
}
/* 周末（无节假日数据时才标，避免重复） */
.cal-makeUp .cal-day {
  color: #c0c4cc;
}
.cal-day {
  font-size: 11px;
  color: #606266;
  font-weight: 600;
  margin-bottom: 2px;
}
.cal-ticket {
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
  border-radius: 3px;
  padding: 1px 4px;
  margin-bottom: 2px;
  font-size: 10px;
  line-height: 1.5;
  color: #529b2e;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cal-train {
  font-weight: 700;
  margin-right: 3px;
}
.cal-time {
  color: #67c23a;
  margin-right: 3px;
}
.cal-route {
  color: #73767a;
}
.cal-more {
  font-size: 10px;
  color: #909399;
  padding-left: 2px;
}
/* ---- 右侧会话卡片 ---- */
.sess-card :deep(.el-card__body) {
  padding: 12px 14px;
}
.sess-meta {
  font-size: 12px;
  color: #909399;
  line-height: 1.8;
  margin-bottom: 10px;
}
.sess-meta span {
  color: #606266;
}
.sess-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.note-card :deep(.el-card__body) {
  padding: 10px 14px;
}
.note-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
  font-size: 12px;
  color: #606266;
}
</style>
