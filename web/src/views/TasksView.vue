<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { taskApi, logApi } from '../api';
import { fmtCn } from '../utils/time';

const tasks = ref<Array<Record<string, unknown>>>([]);
const logs = ref<Array<Record<string, unknown>>>([]);

const statusType: Record<string, string> = {
  pending: 'info',
  queried: 'primary',
  queued: 'warning',
  running: 'warning',
  success: 'success',
  failed: 'danger',
  cancelled: 'info',
};
const statusName: Record<string, string> = {
  pending: '待查起售',
  queried: '待触发',
  queued: '已排队',
  running: '抢票中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

async function load(): Promise<void> {
  tasks.value = (await taskApi.list()) as Array<Record<string, unknown>>;
  logs.value = (await logApi.list(80)) as Array<Record<string, unknown>>;
}

onMounted(load);
</script>

<template>
  <div>
    <el-card class="page-card">
      <template #header><b>购票任务</b>（按起售时刻触发）</template>
      <el-table :data="tasks" border max-height="380">
        <el-table-column label="乘车日期" prop="travelDate" width="120" />
        <el-table-column label="车次" width="100">
          <template #default="{ row }">{{ row.trainNumber ?? '自动匹配' }}</template>
        </el-table-column>
        <el-table-column label="起售时间" width="170">
          <template #default="{ row }">
            <span class="mono">{{ fmtCn(row.saleAt as string) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="(statusType[row.status as string] ?? 'info') as 'info' | 'primary' | 'warning' | 'success' | 'danger'">
              {{ statusName[row.status as string] ?? row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="重试" prop="attempts" width="70" />
        <el-table-column label="结果/错误" min-width="220">
          <template #default="{ row }">
            <div v-if="row.result" class="mono">
              {{ row.result.trainCode }} · {{ row.result.seatInfo }} · 订单 {{ row.result.orderNo ?? '-' }}
            </div>
            <div v-if="row.error" style="color: #f56c6c" class="mono">{{ row.error }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="page-card">
      <template #header><b>系统日志</b>（实时）</template>
      <el-table :data="logs" border max-height="380">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span class="mono">{{ fmtCn(row.created_at as string) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="级别" prop="level" width="80">
          <template #default="{ row }">
            <el-tag :type="row.level === 'error' ? 'danger' : row.level === 'warn' ? 'warning' : 'info'" size="small">
              {{ row.level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模块" prop="category" width="100" />
        <el-table-column label="内容" prop="message" min-width="260" />
        <el-table-column label="详情" min-width="200">
          <template #default="{ row }">
            <div class="mono" style="color: #909399">{{ row.detail ?? '' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
