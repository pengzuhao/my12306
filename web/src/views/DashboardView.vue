<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { sessionApi, feishuApi, taskApi, ordersApi, type OrderRow } from '../api';

const state = ref<Record<string, unknown>>({});
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

/** 今天（本地时区，YYYY-MM-DD）——不能用 toISOString，那是 UTC，东八区凌晨会差一天 */
const todayStr = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

function shiftMonth(delta: number): void {
  calMonth.value = new Date(calMonth.value.getFullYear(), calMonth.value.getMonth() + delta, 1);
}

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

async function reload(): Promise<void> {
  loading.value = true;
  try {
    state.value = await sessionApi.state();
    feishu.value = await feishuApi.get();
    const tasks = (await taskApi.list()) as Array<{ status: string }>;
    stats.value = {
      pending: tasks.filter((t) => t.status === 'pending').length,
      queried: tasks.filter((t) => t.status === 'queried').length,
      running: tasks.filter((t) => t.status === 'running').length,
      success: tasks.filter((t) => t.status === 'success').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
    // 车票日历数据（12306 未登录时优雅降级为空日历）
    try {
      const data = await ordersApi.list();
      orders.value = data.orders ?? [];
      ordersError.value = '';
    } catch (e) {
      orders.value = [];
      ordersError.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '车票数据加载失败';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<template>
  <div>
    <el-row :gutter="16" class="stat-row">
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">12306 会话</div>
          <div class="stat-value" :style="{ color: state.loggedIn ? '#67c23a' : '#f56c6c' }">
            {{ state.loggedIn ? '已登录' : '未登录' }}
          </div>
          <div class="stat-sub">{{ state.userName }}</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">飞书通知</div>
          <div class="stat-value" :style="{ color: feishu.enabled ? '#67c23a' : '#909399' }">
            {{ feishu.webhookUrl ? (feishu.enabled ? '已启用' : '已停用') : '未配置' }}
          </div>
          <div class="stat-sub">购票成功将提醒付款</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">待触发任务</div>
          <div class="stat-value" style="color: #409eff">{{ stats.queried }}</div>
          <div class="stat-sub">等待起售时刻到点抢票</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">累计成功</div>
          <div class="stat-value" style="color: #67c23a">{{ stats.success }}</div>
          <div class="stat-sub">失败 {{ stats.failed }} 次</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="page-card">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px">
          <b>车票日历</b>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
            <el-select v-model="calPassenger" placeholder="全部乘车人" clearable size="small" style="width: 150px">
              <el-option v-for="p in passengers" :key="p" :label="p" :value="p" />
            </el-select>
            <el-button size="small" @click="shiftMonth(-1)">‹ 上月</el-button>
            <span style="min-width: 110px; text-align: center; font-weight: 600">{{ calTitle }}</span>
            <el-button size="small" @click="shiftMonth(1)">下月 ›</el-button>
            <el-button size="small" text @click="calMonth = new Date()">回到今天</el-button>
          </div>
        </div>
      </template>

      <div v-if="ordersError" style="color: #e6a23c; margin-bottom: 10px; font-size: 13px">
        {{ ordersError }}（日历暂不可用，可在「12306 会话」页登录后刷新）
      </div>
      <div style="font-size: 12px; color: #909399; margin-bottom: 10px">
        本月已标记 <b style="color: #67c23a">{{ monthTicketCount }}</b> 张已支付车票{{ calPassenger ? `（乘车人：${calPassenger}）` : '' }}
      </div>

      <!-- 星期表头 -->
      <div class="cal-grid cal-head">
        <div v-for="w in WEEK_LABELS" :key="w" class="cal-cell cal-week">{{ w }}</div>
      </div>
      <!-- 日期网格 -->
      <div class="cal-grid">
        <template v-for="(cell, i) in calendarCells" :key="i">
          <div v-if="cell" class="cal-cell" :class="{ 'cal-today': cell.date === todayStr }">
            <div class="cal-day">{{ cell.day }}</div>
            <div v-for="t in cell.tickets" :key="t.orderNo" class="cal-ticket" :title="`${t.travelDateTime} ${t.trainCode} ${t.fromStation}→${t.toStation} ${(t.passengers ?? []).join('、')}`">
              <span class="cal-train">{{ t.trainCode }}</span>
              <span class="cal-time">{{ (t.travelDateTime ?? '').slice(11) }}</span>
              <span class="cal-route">{{ t.fromStation }}→{{ t.toStation }}</span>
            </div>
          </div>
          <div v-else class="cal-cell cal-blank" />
        </template>
      </div>
    </el-card>

    <el-card class="page-card">
      <template #header><b>系统说明</b></template>
      <ol style="line-height: 2; color: #606266">
        <li>在「12306 会话」扫码登录（<b>只需 12306 APP 扫码，全程不保存密码</b>），登录会话自动保存并保活。</li>
        <li>在「购票计划」创建计划：指定乘车人、日期规则（单次或按工作周期）、时间范围、车次与座位偏好。</li>
        <li>系统自动推算购票日期（节假日顺延并标注），并在<b>车票起售时刻</b>触发购买。</li>
        <li>购票成功后<b>不会自动付款</b>，飞书会提醒你登录 12306 完成支付。</li>
        <li>会话失活时通过飞书通知你重新登录。</li>
      </ol>
    </el-card>
  </div>
</template>

<style scoped>
.stat-row {
  margin-bottom: 16px;
}
/* 让每列成为 flex 容器，卡片撑满列高，4 张卡片底边对齐 */
.stat-col {
  display: flex;
}
.stat-card {
  width: 100%;
  margin-bottom: 0;
}
.stat-title {
  color: #909399;
  font-size: 13px;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  margin: 6px 0;
}
.stat-sub {
  color: #909399;
  font-size: 12px;
}
/* ---- 车票日历 ---- */
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.cal-head {
  margin-bottom: 6px;
}
.cal-cell {
  min-height: 96px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 4px 6px;
  background: #fff;
}
.cal-week {
  min-height: auto;
  text-align: center;
  font-size: 12px;
  color: #909399;
  border: none;
  background: transparent;
  padding: 2px 0;
}
.cal-blank {
  background: #fafafa;
  border-color: #f5f5f5;
}
.cal-today {
  border-color: #409eff;
  box-shadow: inset 0 0 0 1px #409eff;
}
.cal-day {
  font-size: 12px;
  color: #606266;
  font-weight: 600;
  margin-bottom: 3px;
}
.cal-ticket {
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
  border-radius: 3px;
  padding: 2px 5px;
  margin-bottom: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: #529b2e;
  cursor: default;
}
.cal-train {
  font-weight: 700;
  margin-right: 4px;
}
.cal-time {
  color: #67c23a;
  margin-right: 4px;
}
.cal-route {
  display: block;
  color: #73767a;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
