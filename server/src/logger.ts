import { AsyncLocalStorage } from 'node:async_hooks';
import { nanoid } from 'nanoid';
import { getDb } from './db/index.js';
import { MULTI_USER, SYSTEM_USER_ID } from './config.js';
import { cnTime } from './utils/cn-time.js';
import type { WsHub } from './ws/hub.js';
export const logContext = new AsyncLocalStorage<string>();
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"<>]+/gi, '[链接已隐藏]').replace(/\b\d{17}[\dXx]\b/g, '[证件已隐藏]').replace(/\b1[3-9]\d{9}\b/g, '[手机已隐藏]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /password|secret|token|cookie|authorization|idNo|phone|webhook|raw/i.test(k) ? '[已隐藏]' : redact(v)]));
  return value;
}
type Level = 'debug' | 'info' | 'warn' | 'error';
let hub: WsHub | null = null;
export function setLogHub(h: WsHub): void { hub = h; }
function owner(detail: unknown): string | null {
  const d = detail as Record<string, unknown> | undefined;
  if (typeof d?.userId === 'string') return d.userId;
  if (typeof d?.user === 'string') return d.user;
  if (typeof d?.taskId === 'string') return (getDb().prepare('SELECT user_id FROM tasks WHERE id = ?').get(d.taskId) as { user_id: string } | undefined)?.user_id ?? null;
  if (typeof d?.planId === 'string') return (getDb().prepare('SELECT user_id FROM plans WHERE id = ?').get(d.planId) as { user_id: string } | undefined)?.user_id ?? null;
  return null;
}
export class Logger {
  constructor(private category: string, private userId?: string) {}
  private write(level: Level, message: string, detail?: unknown): void {
    const time = cnTime();
    let userId = this.userId ?? logContext.getStore() ?? (!MULTI_USER ? SYSTEM_USER_ID : null);
    try { userId ??= owner(detail); } catch { /* 数据库可能未初始化 */ }
    message = String(redact(message));
    detail = redact(detail);
    const detailStr = detail === undefined ? null : JSON.stringify(detail);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${time}] [${level.toUpperCase()}] [${this.category}] ${message}${detailStr ? ' ' + detailStr : ''}`);
    try { getDb().prepare('INSERT INTO logs (id, user_id, level, category, message, detail) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), userId, level, this.category, message, detailStr); } catch { /* 日志失败不影响业务 */ }
    const msg = { type: 'log' as const, payload: { level, category: this.category, message, detail, time, userId } };
    if (userId) hub?.broadcastToUser(userId, msg);
    else if (!MULTI_USER) hub?.broadcast(msg);
  }
  debug(message: string, detail?: unknown): void { this.write('debug', message, detail); }
  info(message: string, detail?: unknown): void { this.write('info', message, detail); }
  warn(message: string, detail?: unknown): void { this.write('warn', message, detail); }
  error(message: string, detail?: unknown): void { this.write('error', message, detail); }
}
