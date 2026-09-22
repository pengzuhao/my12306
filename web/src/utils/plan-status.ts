import type { PlanDateEntry } from '../api';
import { fmtCn, todayCn } from './time';

export function saleLabel(row: PlanDateEntry, now = new Date()): string {
  const saleAt = row.task?.saleAt;
  if (saleAt && Number.isFinite(Date.parse(saleAt))) {
    return Date.parse(saleAt) <= now.getTime() ? '已开售' : fmtCn(saleAt).slice(0, 16);
  }
  const today = todayCn(now);
  if (row.estimatedSaleDate < today) return '已开售';
  if (row.estimatedSaleDate === today) return '今日开售';
  return `预计 ${row.estimatedSaleDate}`;
}

export function planDateStatus(row: PlanDateEntry, planStatus: string, loggedIn: boolean, now = new Date()): string {
  const status = row.task?.status;
  if (status === 'failed' && row.task?.error?.startsWith('执行中断：')) return '执行中断';
  const finalNames: Record<string, string> = { success: '已购票', failed: '购票失败', skipped: '已跳过', cancelled: '已取消', running: '正在购票', queued: '排队中' };
  if (status && finalNames[status]) return finalNames[status];
  if (row.travelDate < todayCn(now)) return '已结束';
  if (planStatus === 'paused') return '已暂停';
  if (planStatus === 'deleted') return '已停止';
  const saleAt = row.task?.saleAt;
  const waiting = saleAt && Number.isFinite(Date.parse(saleAt))
    ? Date.parse(saleAt) > now.getTime()
    : row.estimatedSaleDate > todayCn(now);
  if (waiting) return '待开售';
  if (!loggedIn) return '待登录';
  if (status === 'queried') return '等待购票';
  if (status === 'pending') return '准备购票';
  return '待购票';
}
