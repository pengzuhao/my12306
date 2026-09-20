/**
 * 时间显示工具：后端存储/传输一律用 UTC ISO，前端统一按东八区（Asia/Shanghai）展示。
 */

/** 将 UTC ISO 字符串格式化为东八区时间（YYYY-MM-DD HH:mm:ss），输入为空返回占位符 */
export function fmtCn(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  // toLocaleString 按 Asia/Shanghai 时区输出，en-CA 给出 YYYY-MM-DD HH:mm:ss 形态
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 仅日期（YYYY-MM-DD） */
export function fmtCnDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 10);
}
