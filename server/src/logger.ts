/** 轻量日志器：同时写入控制台、数据库 logs 表，并广播到 WebSocket 管理台。 */
import { nanoid } from 'nanoid';
import { getDb } from './db/index.js';
import { cnTime } from './utils/cn-time.js';
import type { WsHub } from './ws/hub.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

let hub: WsHub | null = null;

export function setLogHub(h: WsHub): void {
  hub = h;
}

export class Logger {
  constructor(private category: string, private userId?: string) {}

  private write(level: Level, message: string, detail?: unknown): void {
    // 统一用北京时间展示（用户要求所有时间都是东八区）
    const time = cnTime();
    const detailStr = detail !== undefined ? JSON.stringify(detail) : null;
    // 控制台
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${time}] [${level.toUpperCase()}] [${this.category}] ${message}${detailStr ? ' ' + detailStr : ''}`);
    // 数据库（异步失败不影响主流程）
    try {
      getDb()
        .prepare(
          'INSERT INTO logs (id, user_id, level, category, message, detail) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(nanoid(), this.userId ?? null, level, this.category, message, detailStr);
    } catch {
      // 库未就绪等情况忽略
    }
    // WebSocket 广播给管理台
    if (hub) {
      hub.broadcast({
        type: 'log',
        payload: {
          level,
          category: this.category,
          message,
          detail,
          time,
          userId: this.userId ?? null,
        },
      });
    }
  }

  debug(message: string, detail?: unknown): void {
    this.write('debug', message, detail);
  }
  info(message: string, detail?: unknown): void {
    this.write('info', message, detail);
  }
  warn(message: string, detail?: unknown): void {
    this.write('warn', message, detail);
  }
  error(message: string, detail?: unknown): void {
    this.write('error', message, detail);
  }
}
