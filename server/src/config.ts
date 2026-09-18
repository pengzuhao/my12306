import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 数据目录（数据库、浏览器 profile、会话、节假日缓存、主密钥） */
export const DATA_DIR = process.env.MY12306_DATA_DIR || path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'my12306.db');
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const HOLIDAY_CACHE_PATH = path.join(DATA_DIR, 'holidays.json');
export const MASTER_KEY_PATH = path.join(DATA_DIR, 'master.key');

export const PORT = Number(process.env.MY12306_PORT || process.env.PORT || 7788);
export const HOST = process.env.MY12306_HOST || '127.0.0.1';

/** 12306 互联网预售期（天）。最终以起售查询接口返回为准，此为兜底默认值 */
export const DEFAULT_PRESALE_DAYS = Number(process.env.MY12306_PRESALE_DAYS || 14);

/** JWT 有效期 */
export const JWT_TTL = '7d';

/** 抢票触发提前量：起售时刻前 N 毫秒进入待触发队列 */
export const PRE_TRIGGER_MS = Number(process.env.MY12306_PRE_TRIGGER_MS || 3000);

function readMasterKey(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(MASTER_KEY_PATH)) {
    return fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim();
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600 });
  return key;
}

export const MASTER_KEY = readMasterKey();

/** JWT 密钥（与主密钥分离，固定常量 + 主密钥哈希，保证重启后 token 仍有效） */
export const JWT_SECRET = crypto.createHash('sha256').update('my12306-jwt:' + MASTER_KEY).digest('hex');

/** 浏览器是否使用无头模式。macOS 固定无头（等价于 xvfb 效果），Linux 有 DISPLAY 时可设为 false */
export const HEADLESS = process.env.MY12306_HEADLESS !== 'false';

/** 12306 相关常量 */
export const RAILWAY = {
  LOGIN_URL: 'https://kyfw.12306.cn/otn/login/init',
  INDEX_URL: 'https://kyfw.12306.cn/otn/index/initMy12306Api',
  CHECK_USER_URL: 'https://kyfw.12306.cn/otn/login/checkUser',
  LEFT_TICKET_QUERY: 'https://kyfw.12306.cn/otn/leftTicket/queryZ',
  STATION_NAME_JS: 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js',
  HOME_URL: 'https://kyfw.12306.cn/otn/index/init',
} as const;
