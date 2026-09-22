/**
 * 时间显示工具：后端存储/传输一律用 UTC ISO，前端统一按东八区（Asia/Shanghai）展示。
 */

/** 将 UTC ISO 字符串格式化为东八区时间（YYYY-MM-DD HH:mm:ss），输入为空返回占位符 */
export function fmtCn(iso: string | null | undefined): string {
  if (!iso) return '-';
  // SQLite datetime('now') 是 UTC，但不带时区后缀；不能按浏览器本地时间解析。
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(iso);
  // toLocaleString 按 Asia/Shanghai 时区输出，en-CA 给出 YYYY-MM-DD HH:mm:ss 形态
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 仅日期（YYYY-MM-DD） */
export function fmtCnDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  // SQLite datetime('now') 是 UTC，但不带时区后缀；不能按浏览器本地时间解析。
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 10);
}

/** 北京日期与日期选择器的本地日历值分开处理，避免 UTC 零点禁用今天。 */
export function todayCn(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isPastDate(date: Date): boolean {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return day < todayCn();
}
