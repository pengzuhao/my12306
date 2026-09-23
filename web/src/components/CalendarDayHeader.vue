<script setup lang="ts">
import { computed } from 'vue';
import type { HolidayDay } from '../api';
import { calendarDayMarker } from '../utils/calendar-day';
const props = defineProps<{ date: string; holiday?: HolidayDay; today?: boolean }>();
const marker = computed(() => calendarDayMarker(props.holiday));
</script>
<template>
  <div class="calendar-day-header" :class="{ 'is-today': today }">
    <span class="calendar-day-number">{{ Number(date.slice(-2)) }}</span>
    <span v-if="marker.label" class="calendar-day-marker" :class="marker.kind" :title="marker.label">{{ marker.label }}</span>
  </div>
</template>
<style scoped>
.calendar-day-header{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;margin-bottom:5px;line-height:1.4}.calendar-day-number{font-size:13px;font-weight:600;color:#606266}.is-today .calendar-day-number{color:#2879ce}.calendar-day-marker{max-width:100%;box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border-radius:3px;padding:0 4px;font-size:10px;font-weight:400}.work{color:#2879ce;background:#ecf5ff}.rest{color:#858d98;background:#f3f4f6}.holiday{color:#d45f5f;background:#fef0f0}.makeup{color:#b88230;background:#fdf6ec}
</style>
