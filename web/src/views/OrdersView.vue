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
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ordersApi, type ChangeOption, type OrderRow } from '../api';
import ShareImageDialog from '../components/ShareImageDialog.vue';
import type { ShareContent } from '../utils/share-image';
const shareContent = ref<ShareContent | null>(null);
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
const lastManual = ref(0);
const cooldown = computed(() => Math.max(0, Math.ceil((lastManual.value + MANUAL_COOLDOWN - tick.value) / 1000)));

const unpaidOrders = computed(() => orders.value.filter((o) => o.status === 'unpaid')
  .sort((a, b) => (a.payLimitTs ?? Infinity) - (b.payLimitTs ?? Infinity)));

/** 按状态多选过滤后的列表（未选任何状态时显示全部） */
const filteredOrders = computed(() =>
  statusFilter.value.length ? orders.value.filter((o) => statusFilter.value.includes(o.status)) : orders.value,
);

interface JourneyView { id: string; legs: OrderRow[] }
const router = useRouter();
const journeys = computed<JourneyView[]>(() => {
  const groups = new Map<string, OrderRow[]>();
  const order: string[] = [];
  for (const row of filteredOrders.value) {
    const id = row.journeyId || `${row.orderNo}|${row.trainCode}|${row.fromStation}|${row.toStation}|${row.travelDateTime}`;
    if (!groups.has(id)) { groups.set(id, []); order.push(id); }
    groups.get(id)!.push(row);
  }
  return order.map((id) => ({ id, legs: groups.get(id)!.slice().sort((a, b) => (a.legIndex ?? 1) - (b.legIndex ?? 1)) }));
});

const refunding = ref(false);
const changeOpen = ref(false);
const changeLoading = ref(false);
const changeTarget = ref<JourneyView | null>(null);
const changeMode = ref<'to-direct' | 'to-transfer'>('to-direct');
const changeOptions = ref<ChangeOption[]>([]);
const changeError = ref('');

function journeyTitle(item: JourneyView): string {
  const head = item.legs[0];
  const tail = item.legs[item.legs.length - 1];
  return `${head.fromStation} → ${tail.toStation}`;
}

function journeyTrains(item: JourneyView): string {
  return item.legs.map((leg) => leg.trainCode).join(' / ');
}

function money(value: number): string {
  return `¥${value.toFixed(2)}`;
}

/** 单程只显示总价。换乘显示总价和每一程，例如 ¥425.00（¥200.00/¥225.00）。 */
function journeyPrice(item: JourneyView): string {
  const prices = item.legs.map((leg) => leg.totalPrice);
  if (prices.every((price) => price == null)) return '';
  const total = prices.reduce<number>((sum, price) => sum + (price ?? 0), 0);
  const head = money(total);
  if (item.legs.length < 2) return head;
  return `${head}（${prices.map((price) => (price == null ? '—' : money(price))).join('/')}）`;
}

/** 同车接续两程车次相同，退票按钮用区间区分。 */
function refundLabel(item: JourneyView, leg: OrderRow): string {
  const route = `${leg.fromStation}→${leg.toStation}`;
  const sameTrain = item.legs.every((itemLeg) => itemLeg.trainCode === leg.trainCode);
  return sameTrain ? `退${route}` : `退${leg.trainCode} ${route}`;
}

async function refundLegs(legs: OrderRow[]): Promise<void> {
  if (refunding.value || !legs.length) return;
  const text = legs.length > 1
    ? `确认退掉全部 ${legs.length} 程？待支付的会取消订单，已支付的按 12306 规则扣退票费。`
    : `确认退 ${legs[0].trainCode} ${legs[0].fromStation} → ${legs[0].toStation}？`;
  await ElMessageBox.confirm(text, '退票', { type: 'warning', confirmButtonText: '确认退票', cancelButtonText: '取消' });
  refunding.value = true;
  try {
    await ordersApi.refund(legs.map((leg) => ({ orderNo: leg.orderNo, trainCode: leg.trainCode, fromStation: leg.fromStation, toStation: leg.toStation })));
    ElMessage.success('退票请求已提交');
    lastManual.value = 0;
    await load(true);
  } catch (e) {
    if (e === 'cancel') return;
    const err = e as { response?: { data?: { error?: string } } };
    ElMessage.error(err.response?.data?.error ?? '退票失败');
  } finally {
    refunding.value = false;
  }
}

async function openChange(item: JourneyView): Promise<void> {
  changeTarget.value = item;
  changeMode.value = item.legs.length > 1 ? 'to-direct' : 'to-transfer';
  changeOpen.value = true;
  await loadChangeOptions();
}

async function loadChangeOptions(): Promise<void> {
  const item = changeTarget.value;
  if (!item) return;
  const head = item.legs[0];
  const tail = item.legs[item.legs.length - 1];
  changeLoading.value = true;
  changeError.value = '';
  changeOptions.value = [];
  try {
    const data = await ordersApi.changeOptions({
      mode: changeMode.value,
      fromStation: head.fromStation,
      toStation: tail.toStation,
      date: head.travelDateTime.slice(0, 10),
      departTime: head.travelDateTime.slice(11, 16) || '00:00',
      currentTrains: item.legs.map((leg) => leg.trainCode),
    });
    changeOptions.value = data.options;
    if (!data.options.length) changeError.value = '没有找到同时段、且普通席别有余票的方案';
  } catch (e) {
    changeError.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '改签方案查询失败';
  } finally {
    changeLoading.value = false;
  }
}

function useChangeOption(option: ChangeOption): void {
  if (option.legs.length > 1) {
    sessionStorage.setItem('my12306-transfer-draft', JSON.stringify(option.legs.map((leg) => ({
      trainCode: leg.trainCode, fromStation: leg.fromStation, toStation: leg.toStation, date: leg.date, seatTypes: leg.seatTypes,
    }))));
    changeOpen.value = false;
    void router.push({ path: '/plans', query: { transfer: '1' } });
    return;
  }
  const leg = option.legs[0];
  changeOpen.value = false;
  void router.push({ path: '/plans', query: { from: leg.fromStation, to: leg.toStation, date: leg.date, train: leg.trainCode } });
}

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
  if (Date.now() - lastManual.value < MANUAL_COOLDOWN) return;
  if (loading.value) return;
  lastManual.value = Date.now();
  tick.value = Date.now();
  await load(true);
  if (errorMsg.value) lastManual.value = 0;
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
          （{{ unpaidOrders[0].payLimitTs ? fmtRemaining(remainingMs(unpaidOrders[0])) : '请以 12306 显示为准' }}）
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
            <el-button type="primary" size="small" :loading="loading" :disabled="cooldown > 0" @click="manualRefresh">{{ cooldown > 0 ? `${cooldown} 秒后可刷新` : '刷新' }}</el-button>
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
        <span style="font-size: 12px; color: #909399">共 {{ journeys.length }} 条行程（车票 {{ filteredOrders.length }} 张）</span>
      </div>

      <div class="mobile-tickets" v-loading="loading">
        <el-empty v-if="!journeys.length" description="暂无符合条件的车票" />
        <article v-for="item in journeys" :key="item.id" class="mobile-ticket">
          <div class="ticket-top"><strong>{{ journeyTrains(item) }}</strong><el-tag size="small" :type="STATUS_META[item.legs[0].status].type">{{ item.legs.length > 1 ? item.legs.length + ' 程' : (item.legs[0].statusText || STATUS_META[item.legs[0].status].label) }}</el-tag></div>
          <h3>{{ journeyTitle(item) }}</h3>
          <p v-for="leg in item.legs" :key="leg.orderNo + leg.trainCode">第 {{ leg.legIndex || 1 }} 程 {{ leg.trainCode }} {{ leg.fromStation }} → {{ leg.toStation }} · {{ leg.travelDateTime }}</p>
          <p>{{ item.legs[0].passengers.join('、') }}</p>
          <div class="ticket-bottom">
            <span>{{ journeyPrice(item) }}</span>
            <span>
              <el-button v-if="item.legs.some(leg => leg.status !== 'refunded')" type="danger" plain size="small" @click="item.legs.length > 1 ? refundLegs(item.legs.filter(leg => leg.status !== 'refunded')) : refundLegs(item.legs)">{{ item.legs.length > 1 ? '全部退' : '退票' }}</el-button>
              <el-button v-for="leg in item.legs.filter(leg => item.legs.length > 1 && leg.status !== 'refunded')" :key="leg.orderNo + leg.fromStation + leg.toStation" type="danger" plain size="small" @click="refundLegs([leg])">{{ refundLabel(item, leg) }}</el-button>
              <el-button v-if="item.legs[0].status !== 'refunded'" type="primary" plain size="small" @click="openChange(item)">智能改签</el-button>
            </span>
          </div>
        </article>
      </div>
      <el-table class="desktop-tickets" :data="journeys" border v-loading="loading" empty-text="暂无已购车票">
        <el-table-column label="订单号" width="150">
          <template #default="{ row }">
            <div v-for="leg in row.legs" :key="leg.orderNo + leg.trainCode" class="mono">{{ leg.orderNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <div v-for="leg in row.legs" :key="leg.orderNo + leg.statusText">
              <el-tag :type="STATUS_META[leg.status as OrderRow['status']].type">{{ leg.statusText || STATUS_META[leg.status as OrderRow['status']].label }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="出发 / 到达" width="190">
          <template #default="{ row }">
            <div v-for="leg in row.legs" :key="leg.trainCode + leg.travelDateTime" class="mono">{{ leg.trainCode }} {{ leg.travelDateTime }} → {{ leg.arrivalDateTime || '待确认' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="车次" width="90">
          <template #default="{ row }">{{ journeyTrains(row) }}</template>
        </el-table-column>
        <el-table-column label="发到站" min-width="160">
          <template #default="{ row }">
            <div>{{ journeyTitle(row) }}</div>
            <div v-for="leg in row.legs" :key="leg.trainCode + leg.fromStation" style="font-size: 12px; color: #909399">{{ leg.fromStation }} → {{ leg.toStation }}</div>
          </template>
        </el-table-column>
        <el-table-column label="乘车人" min-width="140">
          <template #default="{ row }">{{ (row.legs[0].passengers ?? []).join('、') || '-' }}</template>
        </el-table-column>
        <el-table-column label="席别" min-width="140">
          <template #default="{ row }">
            <div v-for="leg in row.legs" :key="leg.trainCode + (leg.seats ?? []).join()">{{ leg.trainCode }} {{ (leg.seats ?? []).join('、') || '-' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="票价" min-width="210">
          <template #default="{ row }">
            <span v-if="journeyPrice(row)">{{ journeyPrice(row) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="支付截止" width="180">
          <template #default="{ row }">
            <template v-if="row.legs.some((leg: OrderRow) => leg.status === 'unpaid')">
              <div v-for="leg in row.legs.filter((leg: OrderRow) => leg.status === 'unpaid')" :key="leg.orderNo" class="mono">{{ leg.payLimitTime ?? '-' }}</div>
            </template>
            <span v-else style="color: #909399">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
            <el-button v-if="row.legs.some((leg: OrderRow) => leg.status !== 'refunded')" link type="danger" @click="refundLegs(row.legs.length > 1 ? row.legs.filter((leg: OrderRow) => leg.status !== 'refunded') : row.legs)">{{ row.legs.length > 1 ? '全部退' : '退票' }}</el-button>
            <el-button v-for="leg in row.legs.filter((leg: OrderRow) => row.legs.length > 1 && leg.status !== 'refunded')" :key="leg.orderNo + leg.fromStation + leg.toStation" link type="danger" @click="refundLegs([leg])">{{ refundLabel(row, leg) }}</el-button>
            <el-button v-if="row.legs[0].status !== 'refunded'" link type="primary" @click="openChange(row)">智能改签</el-button>
            <el-button link type="primary" @click="shareContent = { kind: 'ticket', ticket: row.legs[0] }">分享</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <ShareImageDialog :content="shareContent" @close="shareContent = null" />
    <el-dialog v-model="changeOpen" title="智能改签" width="640px" append-to-body>
      <p style="font-size: 13px; color: #606266; margin-top: 0">只列出同时段、普通席别有余票的方案。选定后去新建购票计划，新票支付成功前不会退掉现在的票。</p>
      <el-radio-group v-model="changeMode" @change="loadChangeOptions">
        <el-radio-button value="to-direct">改成直达</el-radio-button>
        <el-radio-button value="to-transfer">改成换乘</el-radio-button>
      </el-radio-group>
      <div v-loading="changeLoading" style="min-height: 80px; margin-top: 12px">
        <div v-if="changeError" style="color: #e6a23c; font-size: 13px">{{ changeError }}</div>
        <div v-for="(option, index) in changeOptions" :key="index" style="border: 1px solid #ebeef5; border-radius: 8px; padding: 10px 12px; margin-top: 8px">
          <div style="display: flex; justify-content: space-between; gap: 8px">
            <b>{{ option.label }} {{ option.trains.join(' / ') }}</b>
            <el-button size="small" type="primary" @click="useChangeOption(option)">按此方案下单</el-button>
          </div>
          <div style="font-size: 13px; margin-top: 4px">{{ option.fromStation }} → {{ option.toStation }} · {{ option.departTime }} 到 {{ option.arriveTime }} · {{ option.duration }}</div>
          <div style="font-size: 12px; color: #909399">{{ option.reason }}</div>
          <div v-for="leg in option.legs" :key="leg.trainCode + leg.fromStation" style="font-size: 12px; color: #606266">{{ leg.date }} {{ leg.trainCode }} {{ leg.fromStation }} → {{ leg.toStation }} {{ leg.departTime }}</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.row-actions { display: flex; flex-direction: column; align-items: flex-start; }
.row-actions :deep(.el-button) { margin-left: 0; height: auto; padding: 2px 0; }
.mobile-tickets { display: none; }
@media (max-width: 760px) {
  .desktop-tickets { display: none; }
  .mobile-tickets { display: grid; gap: 14px; }
  .mobile-ticket { border: 1px solid #e5ecf5; border-radius: 12px; padding: 16px; background: linear-gradient(120deg, #f8fbff, #fff); }
  .ticket-top, .ticket-bottom { display: flex; align-items: center; justify-content: space-between; }
  .ticket-top strong { font-size: 19px; color: #3467a6; }
  .mobile-ticket h3 { font-size: 17px; color: #304e6e; margin: 14px 0 10px; }
  .mobile-ticket h3 span { color: #a4b3c3; margin: 0 4px; }
  .mobile-ticket p { font-size: 12px; color: #7d8da0; line-height: 1.7; margin: 5px 0; }
  .ticket-bottom { margin-top: 14px; padding-top: 12px; border-top: 1px dashed #dbe5f1; color: #667e98; font-size: 14px; }
  .mobile-ticket .unpaid-note { color: #c27b44; }
}
</style>
