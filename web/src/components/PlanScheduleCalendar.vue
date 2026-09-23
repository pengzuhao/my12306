<script setup lang="ts">
import CalendarDayHeader from './CalendarDayHeader.vue';
import { calendarDayMarker, CALENDAR_WEEK_LABELS } from '../utils/calendar-day';
import { computed, ref, watch } from 'vue';
import { calendarApi, type HolidayDay, type PlanDateEntry } from '../api';
import { todayCn } from '../utils/time';
import { saleLabel } from '../utils/plan-status';
const props = defineProps<{ rows: PlanDateEntry[]; status: (row: PlanDateEntry) => string; busy: boolean; editable: (row: PlanDateEntry) => boolean; cancelable: (row: PlanDateEntry) => boolean }>();
const emit = defineEmits<{ skip: [row: PlanDateEntry]; cancel: [row: PlanDateEntry] }>();
const initial = props.rows.find(r => r.travelDate >= todayCn())?.travelDate ?? props.rows[0]?.travelDate ?? todayCn();
const month = ref(initial.slice(0, 7));
const selected = ref(initial);
const holidays = ref<HolidayDay[]>([]);
const loading = ref(false);
const error = ref('');
const pending = ref(false);
let request = 0;
async function load() {
  const version = ++request;
  loading.value = true; error.value = ''; holidays.value = [];
  try {
    const [year, m] = month.value.split('-').map(Number);
    const data = await calendarApi.holidays(year, m);
    if (version !== request) return;
    holidays.value = data.days; pending.value = data.calendarPending;
  } catch { if (version === request) error.value = '日历信息加载失败'; }
  finally { if (version === request) loading.value = false; }
}
watch(month, load, { immediate: true });
const dateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function shift(delta: number) {
  const [y,m] = month.value.split('-').map(Number);
  month.value = dateString(new Date(y, m-1+delta, 1)).slice(0,7);
}
const cells = computed(() => {
  const [y,m] = month.value.split('-').map(Number);
  const first = new Date(y,m-1,1);
  const offset = (first.getDay()+6)%7;
  const days = new Date(y,m,0).getDate();
  return Array.from({length: Math.ceil((offset+days)/7)*7}, (_,i) => {
    const d = new Date(y,m-1,1-offset+i), date = dateString(d);
    const holiday = holidays.value.find(h => h.date === date);
    const row = props.rows.find(r => r.travelDate === date);
    const label = calendarDayMarker(holiday).label;
    return { date, day:d.getDate(), current:date.startsWith(month.value), label, holiday, row };
  });
});
const selectedRow = computed(() => props.rows.find(r => r.travelDate === selected.value));
function tone(row?: PlanDateEntry) {
  if (!row) return '';
  if (row.manuallySkipped || ['skipped','cancelled'].includes(row.task?.status ?? '')) return 'skipped';
  return row.cancellationPending ? 'failed' : row.task?.status === 'success' && row.task.result?.paid === false ? 'unpaid' : row.task?.status === 'success' ? 'success' : row.task?.status === 'failed' ? 'failed' : 'planned';
}
</script>
<template>
  <section class="schedule-calendar">
    <div class="month-bar">
      <el-button size="small" aria-label="上个月" @click="shift(-1)">‹</el-button>
      <el-date-picker v-model="month" type="month" value-format="YYYY-MM" format="YYYY 年 MM 月" :clearable="false" aria-label="选择月份" style="width:160px" />
      <el-button size="small" aria-label="下个月" @click="shift(1)">›</el-button>
      <el-button size="small" @click="month = todayCn().slice(0,7); selected = todayCn()">本月</el-button>
    </div>
    <div v-if="error" role="alert" class="calendar-notice">{{ error }} <el-button link type="primary" @click="load">重试</el-button></div>
    <div v-else-if="pending" class="calendar-notice">该年节假日安排尚未公布，暂按周一至周五标注。</div>
    <div class="weekdays"><span v-for="day in CALENDAR_WEEK_LABELS" :key="day">{{ day }}</span></div>
    <div v-loading="loading" class="month-grid">
      <button v-for="cell in cells" :key="cell.date" type="button" class="day-cell" :class="[tone(cell.row), { outside:!cell.current, selected:selected===cell.date, today:cell.date===todayCn() }]" :aria-label="`${cell.date} ${cell.label} ${cell.row ? status(cell.row) : '无购票安排'}`" :aria-pressed="selected===cell.date" @click="selected=cell.date">
        <CalendarDayHeader :date="cell.date" :holiday="cell.current ? cell.holiday : undefined" :today="cell.date === todayCn()" />
        <span v-if="cell.row" class="day-status">{{ status(cell.row) }}</span>
      </button>
    </div>
    <div class="calendar-selection">
      <strong>{{ selected }}</strong>
      <template v-if="selectedRow">
        <span>{{ status(selectedRow) }} · {{ saleLabel(selectedRow) }}</span>
        <span v-if="selectedRow.task?.result && selectedRow.task.status==='success'">{{ selectedRow.task.result.trainCode }} · {{ selectedRow.task.result.seatInfoSource ? selectedRow.task.result.seatInfo : '席别待核实' }}</span>
        <span v-if="selectedRow.task?.error && !selectedRow.manuallySkipped" class="calendar-error">{{ selectedRow.task.error }}</span>
        <el-button v-if="cancelable(selectedRow)" type="danger" plain size="small" :loading="busy" @click="emit('cancel',selectedRow)">取消订单并跳过</el-button>
        <el-button v-if="editable(selectedRow)" size="small" :loading="busy" @click="emit('skip',selectedRow)">{{ selectedRow.manuallySkipped ? '恢复购票' : '跳过这一天' }}</el-button>
      </template>
      <span v-else>当天没有购票安排</span>
    </div>
  </section>
</template>
<style scoped>
.month-bar{display:flex;align-items:center;justify-content:center;gap:8px;margin:14px 0}.month-bar .el-button+.el-button{margin-left:0}.weekdays,.month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.weekdays{text-align:center;color:#89929f;font-size:12px;padding:8px 0}.month-grid{gap:4px}.day-cell{min-height:64px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 2px;border:1px solid #e7ebf0;background:#fff;border-radius:8px;cursor:pointer;color:#485568;font:inherit}.day-cell:hover{border-color:#409eff}.day-cell.selected{outline:2px solid #409eff;outline-offset:-2px}.day-status{font-size:11px;line-height:1.4}.planned{background:#f0f7ff;color:#2879ce}.unpaid{background:#fff7e9;color:#ba7b22}.success{background:#eff9f1;color:#338354}.failed{background:#fff2f0;color:#cd5555}.skipped{background:#f3f4f6;color:#969ca5}.outside{opacity:.35}.calendar-selection{display:flex;align-items:flex-start;flex-direction:column;gap:8px;margin-top:14px;padding:14px;background:#f6f8fb;border-radius:10px;font-size:13px}.calendar-error{color:#d25c5c;overflow-wrap:anywhere}.calendar-notice{font-size:12px;color:#a0793e;padding:6px 0}@media(max-width:480px){.day-cell{min-height:68px}.day-status{font-size:10px}.month-grid{gap:2px}}
</style>
