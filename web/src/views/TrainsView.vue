<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { metaApi, planApi, sessionApi, type TrainOption } from '../api';

const router = useRouter();

/** 查询表单 */
const form = reactive({
  from: '',
  to: '',
  date: new Date().toISOString().slice(0, 10),
});

/** 今天（日期选择器最小值，不能查过去的票） */
const today = new Date().toISOString().slice(0, 10);

const loading = ref(false);
const trains = ref<TrainOption[]>([]);
/** 12306 是否已登录（未登录时给引导） */
const loggedIn = ref(false);

/** 余票文本 → 颜色：有票绿、无票灰 */
function seatColor(text: string | undefined): string {
  if (!text || text === '无' || text === '') return '#c0c4cc';
  if (text === '有' || text === '*') return '#67c23a';
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? '#67c23a' : '#c0c4cc';
}

async function searchStations(keyword: string, cb: (items: Array<{ value: string }>) => void): Promise<void> {
  if (!keyword) return cb([]);
  try {
    const list = await planApi.stations(keyword);
    cb(list.map((s: { name: string }) => ({ value: s.name })));
  } catch {
    cb([]);
  }
}

async function checkLogin(): Promise<void> {
  try {
    const state = (await sessionApi.state()) as { loggedIn?: boolean };
    loggedIn.value = !!state.loggedIn;
  } catch {
    loggedIn.value = false;
  }
}

async function search(): Promise<void> {
  if (!form.from || !form.to) {
    ElMessage.warning('请填写出发站和到达站');
    return;
  }
  if (!form.date) {
    ElMessage.warning('请选择乘车日期');
    return;
  }
  if (!loggedIn.value) {
    ElMessage.warning('请先在顶栏扫码登录 12306 后再查询车次');
    return;
  }
  loading.value = true;
  try {
    const res = await metaApi.trains(form.from, form.to, form.date);
    trains.value = res.trains;
    if (!res.trains.length) {
      ElMessage.warning('该日期/区间暂无可查车次（可能未到预售期或无直达车）');
    } else {
      ElMessage.success(`查到 ${res.trains.length} 趟车次`);
    }
  } catch (e) {
    trains.value = [];
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '车次查询失败');
  } finally {
    loading.value = false;
  }
}

/** 交换出发站和到达站 */
function swapStations(): void {
  const tmp = form.from;
  form.from = form.to;
  form.to = tmp;
}

/** 跳到新建计划页，并带上当前查询条件作为草稿 */
function newPlanWithTrain(t: TrainOption): void {
  router.push({
    path: '/plans',
    query: { from: form.from, to: form.to, date: form.date, train: t.trainCode },
  });
}

onMounted(async () => {
  await checkLogin();
  // 从购票计划页带过来的查询条件
  const q = router.currentRoute.value.query;
  if (q.from) form.from = String(q.from);
  if (q.to) form.to = String(q.to);
  if (q.date) form.date = String(q.date);
  if (form.from && form.to && loggedIn.value) void search();
});
</script>

<template>
  <el-card class="page-card">
    <template #header>
      <b>车次查询</b>
      <span class="sub-hint">从 12306 实时查询余票，选好车次可直接创建购票计划</span>
    </template>

    <el-alert
      v-if="!loggedIn"
      class="login-tip"
      type="warning"
      :closable="false"
      title="12306 未登录，车次查询需要先登录。请在右上角「扫码登录」后重试。"
    />

    <el-form :inline="true" class="search-form">
      <el-form-item label="出发站">
        <el-autocomplete
          v-model="form.from"
          :fetch-suggestions="searchStations"
          placeholder="南京 / NJ"
          :trigger-on-focus="false"
          clearable
          style="width: 180px"
        />
      </el-form-item>
      <el-form-item>
        <el-button text circle @click="swapStations" title="交换出发和到达站">⇄</el-button>
      </el-form-item>
      <el-form-item label="到达站">
        <el-autocomplete
          v-model="form.to"
          :fetch-suggestions="searchStations"
          placeholder="上海 / SH"
          :trigger-on-focus="false"
          clearable
          style="width: 180px"
        />
      </el-form-item>
      <el-form-item label="乘车日期">
        <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" :disabled-date="(d: Date) => d < new Date(today)" placeholder="选择日期" style="width: 160px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="search">查询车次</el-button>
      </el-form-item>
    </el-form>

    <el-table
      v-if="trains.length"
      :data="trains"
      border
      v-loading="loading"
      :default-sort="{ prop: 'departTime', order: 'ascending' }"
    >
      <el-table-column label="车次" prop="trainCode" width="100" fixed />
      <el-table-column label="乘降站" min-width="170">
        <template #default="{ row }">
          <div>{{ row.fromStation }} → {{ row.toStation }}</div>
        </template>
      </el-table-column>
      <el-table-column label="发车 → 到达" width="160" sortable prop="departTime">
        <template #default="{ row }">
          <span class="mono">{{ row.departTime }} → {{ row.arriveTime }}</span>
        </template>
      </el-table-column>
      <el-table-column label="历时" prop="duration" width="90" />
      <el-table-column label="余票（席别）" min-width="240">
        <template #default="{ row }">
          <div class="seat-list">
            <span v-for="(count, name) in (row.seats ?? {})" :key="name" class="seat-chip" :style="{ color: seatColor(count) }">
              {{ name }} {{ count }}
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click="newPlanWithTrain(row)">加入计划</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else-if="!loading" description="输入站点和日期后点「查询车次」" />
  </el-card>
</template>

<style scoped>
.sub-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
  font-weight: 400;
}
.login-tip {
  margin-bottom: 12px;
}
.search-form {
  margin-bottom: 8px;
}
.seat-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
}
.seat-chip {
  white-space: nowrap;
  font-weight: 600;
}
</style>
