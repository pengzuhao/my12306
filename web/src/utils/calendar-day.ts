import type { HolidayDay } from '../api';
export const CALENDAR_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
export function calendarDayMarker(day?: HolidayDay): { label: string; kind: string } {
  if (!day) return { label: '', kind: '' };
  if (!day.isWorkday) return day.holiday ? { label: day.holiday, kind: 'holiday' } : { label: '休息日', kind: 'rest' };
  const weekday = new Date(`${day.date}T12:00:00+08:00`).getUTCDay();
  return day.holiday || weekday === 0 || weekday === 6 ? { label: '补班', kind: 'makeup' } : { label: '工作日', kind: 'work' };
}
