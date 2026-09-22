import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DATA_DIR, SYSTEM_USER_ID, MULTI_USER } from '../config.js';

// 注意：本模块不依赖 Logger（Logger 反向依赖 db 写日志），否则会产生循环初始化。
// DB 层自身日志直接走控制台。
const log = (msg: string, extra?: unknown) =>
  console.log(`[db] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  _db = db;
  log('sqlite 已初始化', { path: DB_PATH });
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 执行 schema.sql 建表（幂等） */
export function applySchema(): void {
  const db = getDb();
  const schemaPath = path.resolve(import.meta.dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  dropLegacyPasswordColumn();
  relaxUsernameNotNull();
  addPlanDatesStatusColumn();
  migratePlansWeekEdgeColumn();
  addPlansOffsetDaysColumn();
  addPlansAllowNoSeatColumn();
  addPlansSeatTypesColumn();
  if (!(db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>).some(c => c.name === 'train_segments')) db.exec("ALTER TABLE plans ADD COLUMN train_segments TEXT NOT NULL DEFAULT '[]'");
  if (!(db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).some(c => c.name === 'disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  log('数据库 schema 已应用');
}

/**
 * 兼容迁移：旧版把 12306 密码加密存放在 railway_accounts.password_enc。
 * 新版不保存密码，启动时删除该列（含历史密文）。
 * SQLite >= 3.35 支持 ALTER TABLE DROP COLUMN。
 */
function dropLegacyPasswordColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(railway_accounts)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'password_enc')) return;
  db.exec('ALTER TABLE railway_accounts DROP COLUMN password_enc');
  log('已移除 railway_accounts.password_enc（不再保存 12306 密码，历史密文已删除）');
}

/**
 * 兼容迁移：扫码登录不记录 12306 用户名，railway_accounts.username 需允许为空。
 * 旧库该列为 NOT NULL，用「新建表 + 迁移数据 + 替换」改为可空。
 */
function relaxUsernameNotNull(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(railway_accounts)').all() as Array<{ name: string; notnull: number }>;
  const usernameCol = cols.find((c) => c.name === 'username');
  if (!usernameCol || usernameCol.notnull === 0) return;
  db.exec(`
    CREATE TABLE railway_accounts_new (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL UNIQUE,
      username      TEXT,
      status        TEXT NOT NULL DEFAULT 'none',
      last_login_at TEXT,
      last_check_at TEXT,
      fail_reason   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO railway_accounts_new (id, user_id, username, status, last_login_at, last_check_at, fail_reason, created_at, updated_at)
    SELECT id, user_id, username, status, last_login_at, last_check_at, fail_reason, created_at, updated_at FROM railway_accounts;
    DROP TABLE railway_accounts;
    ALTER TABLE railway_accounts_new RENAME TO railway_accounts;
  `);
  log('已将 railway_accounts.username 改为可空（扫码登录不记录用户名）');
}

/**
 * 兼容迁移：plan_dates 增加 status 列（pending|done）。
 * 用于标记某一天的车票已购得（含查重命中"已有同车次"的情况），避免重复下单。
 */
function addPlanDatesStatusColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(plan_dates)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'status')) return;
  db.exec("ALTER TABLE plan_dates ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  log('已为 plan_dates 增加 status 列（pending|done）');
}

/**
 * 兼容迁移：plans 的工作周模式改为 week_edge（start=工作周开始 / end=工作周结束）。
 * 工作周不由用户选具体周几，而是按工作日历推算（常态周一至周五，节假日/调休自动顺延）。
 */
function migratePlansWeekEdgeColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'week_start') || cols.some((c) => c.name === 'week_end')) {
    if (cols.some((c) => c.name === 'week_start')) db.exec('ALTER TABLE plans DROP COLUMN week_start');
    if (cols.some((c) => c.name === 'week_end')) db.exec('ALTER TABLE plans DROP COLUMN week_end');
    log('已移除 plans.week_start/week_end（工作周模式改为日历推算，不再选具体周几）');
  }
  if (!cols.some((c) => c.name === 'week_edge')) {
    db.exec('ALTER TABLE plans ADD COLUMN week_edge TEXT');
    log('已为 plans 增加 week_edge 列（start=工作周开始 | end=工作周结束）');
  }
}

/**
 * 兼容迁移：plans 增加 offset_days 列（相对工作周推算日的提前/延后天数，负=提前）。
 */
function addPlansOffsetDaysColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'offset_days')) return;
  db.exec("ALTER TABLE plans ADD COLUMN offset_days INTEGER NOT NULL DEFAULT 0");
  log('已为 plans 增加 offset_days 列（相对推算日的提前/延后天数）');
}

/**
 * 兼容迁移：plans 增加 allow_no_seat 列。
 * 用户要求"除非计划明确允许，否则不买无座票"——旧行政默认 0（不允许），
 * 行为与之前的"回退到无座"不同，但这是用户明确的新规则，老计划若确实想接受
 * 无座需要手动开启。
 */
function addPlansAllowNoSeatColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'allow_no_seat')) return;
  db.exec("ALTER TABLE plans ADD COLUMN allow_no_seat INTEGER NOT NULL DEFAULT 0");
  log('已为 plans 增加 allow_no_seat 列（是否允许购买无座票，默认不允许）');
}

/**
 * 兼容迁移：plans 增加 seat_types 列（席别，必选多选）。
 * 用户要求计划里必须选择席别（二等座/一等座等），订票时严格按所选席别匹配。
 * 老计划没填过席别，默认给 ['ZE']（二等座，最常用），用户可自行编辑修改。
 */
function addPlansSeatTypesColumn(): void {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'seat_types')) return;
  db.exec("ALTER TABLE plans ADD COLUMN seat_types TEXT NOT NULL DEFAULT '[\"ZE\"]'");
  log('已为 plans 增加 seat_types 列（席别，老计划默认二等座）');
}

/** 保留所有用户数据，切换模式仅改变访问方式。 */
export function seedAdmin(): void {
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, '(disabled)', 'admin', '本地用户') ON CONFLICT(id) DO NOTHING").run(SYSTEM_USER_ID, SYSTEM_USER_ID);
  if (!MULTI_USER) return;
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash != '(disabled)'").get();
  if (existing) return;
  const username = process.env.MY12306_ADMIN_USER || 'admin';
  const password = process.env.MY12306_ADMIN_PASSWORD || '';
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('首次启用多用户模式请设置 MY12306_ADMIN_USER（3–40 位字母数字）和 MY12306_ADMIN_PASSWORD（至少 12 字符，最多 72 字节）');
  }
  db.prepare("UPDATE users SET username = ?, password_hash = ?, role = 'admin', disabled = 0, display_name = '管理员' WHERE id = ?").run(username, bcrypt.hashSync(password, 12), SYSTEM_USER_ID);
  log('管理员已初始化，现有数据及 12306 会话已保留');
}
