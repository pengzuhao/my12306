/**
 * 东八区（北京时间）时间工具。
 *
 * 独立成模块是为了打断 logger ↔ calendar/holidays 的循环依赖：
 * logger 初始化时就需要 cnTime，而 holidays 初始化时需要 Logger，
 * 两者互相 import 会导致「Cannot access 'Logger' before initialization」。
 */
export function cnTime(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '');
}
