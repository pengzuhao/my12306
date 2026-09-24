<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { passengerApi, planApi } from '../api';
import PlanPanels from './plans/PlanPanels.vue';
import { usePlanDetail } from './plans/use-plan-detail';
import { usePlanEditor, type Passenger, type Plan } from './plans/use-plan-editor';

const router = useRouter();
const plans = ref<Plan[]>([]);
const passengers = ref<Passenger[]>([]);

async function reload(): Promise<void> {
  plans.value = (await planApi.list()) as Plan[];
  passengers.value = (await passengerApi.list()) as Passenger[];
}

const editor = usePlanEditor({ passengers, reload });
const detail = usePlanDetail();

async function setStatus(id: string, status: 'active' | 'paused' | 'deleted'): Promise<void> {
  await planApi.setStatus(id, status);
  await reload();
}

async function confirmDelete(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认删除该计划？关联任务将不再执行', '提示', { type: 'warning' });
    await setStatus(id, 'deleted');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error('删除失败，请重试');
  }
}

async function handlePlanCommand(cmd: string, row: Plan): Promise<void> {
  if (cmd === 'edit') editor.openEdit(row);
  else if (cmd === 'pause') await setStatus(row.id, 'paused');
  else if (cmd === 'resume') await setStatus(row.id, 'active');
  else if (cmd === 'delete') await confirmDelete(row.id);
}

onMounted(async () => {
  await reload();
  await editor.loadSeatTypes();
  editor.consumeQuery(router);
});
</script>

<template>
  <div>
    <el-card class="page-card">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <b>购票计划</b>
          <el-button type="primary" @click="editor.openNew">新建计划</el-button>
        </div>
      </template>
      <el-table :data="plans" border>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <el-link type="primary" @click="detail.openDetail(row)">{{ row.name }}</el-link>
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
              每{{ row.weekInterval }}周的{{ editor.weekdayNames[(row.weekday ?? 1) - 1] }}
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
            <div style="font-size: 12px; color: #909399">{{ editor.seatTypeName(row.seatTypes) }}</div>
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

    <PlanPanels :editor="editor" :detail="detail" />
  </div>
</template>

<style scoped>
.plan-caret {
  display: inline-block;
  width: 0;
  height: 0;
  margin-left: 3px;
  border: 4px solid transparent;
  border-top-color: currentColor;
  vertical-align: -2px;
}
</style>
