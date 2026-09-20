<script setup lang="ts">
/**
 * 已购车票主页面（需求：已支付 + 待支付的都要展示）。
 *
 * 刷新策略（防止被 12306 封禁）：
 *  1) 定时刷新：每 POLL_INTERVAL（5 分钟）一次，且仅在页面可见时执行——
 *     切到后台时暂停，回来时立刻补一次。这是"不确定"的常规刷新。
 *  2) 确定刷新节点：待支付订单的 payLimitTs（支付截止时刻）到达时，
 *     到点立刻刷一次——未支付订单超时会自动失效，这一刷能把状态即时更新出来。
 *     （用户说未支付 20 分钟未付自动失效，以 12306 下发的 pay_limit_time 为准。）
 *  3) 手动刷新：按钮带冷却（MANUAL_COOLDOWN），防止手滑连点。
 *  4) 服务端也有 20 秒最小间隔节流，双重保险。
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { ordersApi, type OrderRow } from '../api';
import { fmtCn } from '../utils/time';

/** 定时刷新间隔（毫秒）——不能太频繁，否则有被封风险 */
const POLL_INTERVAL = 5 * 60 * 1000;
/** 支付截止后留一点缓冲再刷，让 12306 把订单状态改完 */
const EXPIRY_BUFFER = 8_000;
/** 手动刷新冷却（毫秒） */
const MANUAL_COOLDOWN = 20_000;

const orders = ref<OrderRow[]>([]);
const loading = ref(false);
const errorMsg = ref('');
/** 后端返回的数据时间（毫秒时间戳） */
const fetchedAt = ref<number | null>(null);
const cached = ref(false);
/** 每秒跳动一次的"当前时间"，用于倒计时显示 */
const tick = ref(Date.now());
/** 状态多选过滤（空=全部） */
const statusFilter = ref<OrderRow['status'][]>([]);

/** 状态 → 标签风格 + 文案 */
const STATUS_META: Record<OrderRow['status'], { type: 'danger' | 'success' | 'info'; label: string }> = {
  unpaid: { type: 'danger', label: '待支付' },
  paid: { type: 'success', label: '已支付' },
  refunded: { type: 'info', label: '已退票' },
};
const statusOptions = Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label }));

let pollTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastManual = 0;

const unpaidOrders = computed(() => orders.value.filter((o) => o.status === 'unpaid'));

/** 按状态多选过滤后的列表（未选任何状态时显示全部） */
const filteredOrders = computed(() =>
  statusFilter.value.length ? orders.value.filter((o) => statusFilter.value.includes(o.status)) : orders.value,
);

/** 距支付截止的剩余毫秒（负数表示已过期） */
function remainingMs(o: OrderRow): number {
  return (o.payLimitTs ?? 0) - tick.value;
}

function fmtRemaining(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 0) return '已过期';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}小时${m}分` : m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
}

/** 调一次接口；pageHidden 时跳过定时刷新（手动刷新强制执行） */
async function load(force = false): Promise<void> {
  if (!force && document.hidden) return;
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await ordersApi.list();
    orders.value = data.orders;
    fetchedAt.value = data.fetchedAt;
    cached.value = !!data.cached;
    errorMsg.value = data.stale ? `刷新失败，显示 ${fmtCn(new Date(data.fetchedAt).toISOString())} 的旧数据：${data.error ?? ''}` : '';
    scheduleExpiryRefresh();
  } catch (e) {
    errorMsg.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '查询已购车票失败';
  } finally {
    loading.value = false;
  }
}

/**
 * 安排"确定刷新节点"：取最早一笔待支付订单的支付截止时刻，
 * 到点（+ 缓冲）立刻刷新。每次数据变化后重新安排。
 */
function scheduleExpiryRefresh(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const future = unpaidOrders.value
    .map((o) => o.payLimitTs)
    .filter((t): t is number => typeof t === 'number')
    .filter((t) => t > Date.now());
  if (!future.length) return;
  const delay = Math.min(...future) - Date.now() + EXPIRY_BUFFER;
  // 已过期或延迟过短时，至少等 5 秒，避免立刻连续刷
  expiryTimer = setTimeout(() => void load(true), Math.max(delay, 5_000));
}

async function manualRefresh(): Promise<void> {
  if (Date.now() - lastManual < MANUAL_COOLDOWN) return;
  lastManual = Date.now();
  await load(true);
}

function fmtFetchedAt(): string {
  return fetchedAt.value ? fmtCn(new Date(fetchedAt.value).toISOString()) : '-';
}

onMounted(() => {
  void load(true);
  pollTimer = setInterval(() => void load(false), POLL_INTERVAL);
  tickTimer = setInterval(() => {
    tick.value = Date.now();
  }, 1000);
  // 页面重新可见时立刻补一次（不可见期间的定时刷新被跳过了）
  document.addEventListener('visibilitychange', onVisibilityChange);
});

function onVisibilityChange(): void {
  if (!document.hidden) void load(true);
}

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (expiryTimer) clearTimeout(expiryTimer);
  if (tickTimer) clearInterval(tickTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <div>
    <!-- 待支付横幅：最紧急的信息放最上面 -->
    <el-alert
      v-if="unpaidOrders.length"
      type="error"
      :closable="false"
      style="margin-bottom: 16px"
    >
      <template #title>
        <b>有 {{ unpaidOrders.length }} 笔待支付订单</b>
      </template>
      <div style="font-size: 13px; line-height: 1.8">
        请尽快打开 12306 APP 完成支付。超时未支付订单会自动失效，系统会在失效后自动重新下单。
        <span v-if="unpaidOrders.length">
          最近一笔截止：<b>{{ unpaidOrders[0].payLimitTime ?? '-' }}</b>
          （剩 {{ fmtRemaining(remainingMs(unpaidOrders[0])) }}）
        </span>
      </div>
    </el-alert>

    <el-card class="page-card">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
          <b>已购车票</b>
          <div style="display: flex; align-items: center; gap: 12px; font-size: 12px; color: #909399">
            <span>最后刷新 {{ fmtFetchedAt() }}<span v-if="cached">（缓存）</span></span>
            <span>定时刷新每 5 分钟 · 页面不可见时暂停</span>
            <el-button type="primary" size="small" :loading="loading" @click="manualRefresh">刷新</el-button>
          </div>
        </div>
      </template>

      <div v-if="errorMsg" style="color: #e6a23c; margin-bottom: 12px; font-size: 13px">{{ errorMsg }}</div>

      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap">
        <span style="font-size: 13px; color: #606266">状态筛选</span>
        <el-select
          v-model="statusFilter"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部状态"
          style="width: 220px"
        >
          <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <span style="font-size: 12px; color: #909399">共 {{ filteredOrders.length }} 条（全部 {{ orders.length }} 条）</span>
      </div>

      <el-table :data="filteredOrders" border v-loading="loading" empty-text="暂无已购车票">
        <el-table-column label="订单号" width="150">
          <template #default="{ row }">
            <span class="mono">{{ row.orderNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="STATUS_META[row.status as OrderRow['status']].type">
              {{ row.statusText || STATUS_META[row.status as OrderRow['status']].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="乘车日期" width="150">
          <template #default="{ row }">
            <span class="mono">{{ row.travelDateTime }}</span>
          </template>
        </el-table-column>
        <el-table-column label="车次" width="90">
          <template #default="{ row }">{{ row.trainCode || '-' }}</template>
        </el-table-column>
        <el-table-column label="发到站" min-width="160">
          <template #default="{ row }">{{ row.fromStation }} → {{ row.toStation }}</template>
        </el-table-column>
        <el-table-column label="乘车人" min-width="140">
          <template #default="{ row }">{{ (row.passengers ?? []).join('、') || '-' }}</template>
        </el-table-column>
        <el-table-column label="席别" min-width="140">
          <template #default="{ row }">{{ (row.seats ?? []).join('、') || '-' }}</template>
        </el-table-column>
        <el-table-column label="票价" width="100">
          <template #default="{ row }">
            <span v-if="row.totalPrice != null">¥{{ row.totalPrice.toFixed(2) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="支付截止" width="180">
          <template #default="{ row }">
            <template v-if="row.status === 'unpaid'">
              <div class="mono">{{ row.payLimitTime ?? '-' }}</div>
              <div :style="{ color: remainingMs(row) < 10 * 60 * 1000 ? '#f56c6c' : '#909399', fontSize: '12px' }">
                剩 {{ fmtRemaining(remainingMs(row)) }}
              </div>
            </template>
            <span v-else style="color: #909399">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
