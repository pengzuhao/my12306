import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { DB_PATH, DATA_DIR } from '../config.js';

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

/** 初始化内置管理员账号 */
export function seedAdmin(): void {
  const db = getDb();
  const row = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (row) return;
  const id = nanoid();
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'admin', hash, 'admin', '系统管理员');
  log('已创建默认管理员账号: admin / admin123（请尽快修改密码）');
}
