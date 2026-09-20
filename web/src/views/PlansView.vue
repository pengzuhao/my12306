<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { planApi, passengerApi, type PlanForm } from '../api';

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
const previewRows = ref<Array<Record<string, unknown>>>([]);
const editing = reactive<PlanForm>(emptyForm());

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
    passengerIds: [],
  };
}

const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const seatOptions = ['A', 'B', 'C', 'D', 'F'];

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
    ElMessage.warning('请选择座位席别（必填，按偏好席别严格匹配购票）');
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
    previewRows.value = (await planApi.previewDates(editing)) as Array<Record<string, unknown>>;
    previewVisible.value = true;
  } catch (e) {
    ElMessage.error('推算失败：' + String(e));
  }
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
        <el-table-column prop="name" label="名称" min-width="160" />
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
        <el-table-column label="座位" width="90">
          <template #default="{ row }">{{ row.seatPositions ? row.seatPositions.join('/') : '不指定' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : row.status === 'paused' ? 'warning' : 'info'">
              {{ row.status === 'active' ? '进行中' : row.status === 'paused' ? '已暂停' : '已删除' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status !== 'paused'" size="small" @click="setStatus(row.id, 'paused')">暂停</el-button>
            <el-button v-if="row.status === 'paused'" size="small" type="success" @click="setStatus(row.id, 'active')">恢复</el-button>
            <el-button size="small" type="danger" @click="confirmDelete(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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

    <el-dialog v-model="previewVisible" title="购票日期推算结果" width="560px">
      <el-table :data="previewRows" border max-height="400">
        <el-table-column label="乘车日期" prop="travelDate" width="130" />
        <el-table-column label="原始推算" prop="originalDate" width="130" />
        <el-table-column label="周几" width="70">
          <template #default="{ row }">{{ weekdayNames[(row.weekday ?? 1) - 1] }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="160">
          <template #default="{ row }">
            <el-tag v-if="row.postponed" type="warning">⏩ 顺延</el-tag>
            <span v-if="row.note" style="margin-left: 6px; color: #909399; font-size: 12px">{{ row.note }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>
