-- my12306 数据库 schema（SQLite）
-- 多用户体系：每个系统用户绑定自己的 12306 账号、乘车人、飞书配置与购票计划。

-- 系统用户（管理台账号）
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',          -- admin | user
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 12306 账号会话（不保存密码：用户每次登录自己输入，仅保存浏览器会话并保活）
CREATE TABLE IF NOT EXISTS railway_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,
  username      TEXT,                                     -- 最近一次登录的 12306 登录名（仅展示用）
  status        TEXT NOT NULL DEFAULT 'none',           -- none|logging_in|active|invalid|logged_out
  last_login_at TEXT,
  last_check_at TEXT,
  fail_reason   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 乘车人
CREATE TABLE IF NOT EXISTS passengers (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  id_type_code   TEXT NOT NULL DEFAULT '1',
  id_no          TEXT NOT NULL,
  phone          TEXT,
  passenger_type TEXT NOT NULL DEFAULT '成人',
  source         TEXT NOT NULL DEFAULT 'manual',        -- manual | 12306
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_passengers_user ON passengers(user_id);

-- 飞书群机器人配置
CREATE TABLE IF NOT EXISTS feishu_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL UNIQUE,
  webhook_url TEXT NOT NULL,
  secret      TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 购票计划
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',        -- active|paused|deleted
  from_station   TEXT NOT NULL,                          -- 出发站（城市/车站名）
  to_station     TEXT NOT NULL,                          -- 到达站
  date_mode      TEXT NOT NULL,                          -- single | recurring | workweek
  travel_date    TEXT,                                    -- single 模式的具体乘车日期
  weekday        INTEGER,                                 -- recurring 模式：1-7（周一至周日）
  week_edge      TEXT,                                    -- workweek 模式：start=工作周开始 | end=工作周结束
  week_interval  INTEGER NOT NULL DEFAULT 1,              -- 每隔几周
  offset_days    INTEGER NOT NULL DEFAULT 0,              -- 相对推算日的偏移：负=提前（如 -1 提前一天），正=延后
  valid_from     TEXT NOT NULL,                           -- 生效起始日期
  valid_until    TEXT,                                    -- 生效结束日期（可空=长期）
  time_from      TEXT,                                    -- 出发时间范围起，如 08:00
  time_to        TEXT,                                    -- 出发时间范围止，如 09:00
  train_numbers  TEXT,                                    -- JSON 数组：具体车次（可空=按时间范围自动匹配）
  seat_positions TEXT,                                    -- JSON 数组：座位偏好 A/B/C/D/F（可空=不指定）
  passenger_ids  TEXT NOT NULL,                           -- JSON 数组：乘车人 ID
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_user_status ON plans(user_id, status);

-- 计划推算日期（每次预览/调度时生成）
CREATE TABLE IF NOT EXISTS plan_dates (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL,
  travel_date   TEXT NOT NULL,                            -- 顺延后的实际出行日期
  original_date TEXT NOT NULL,                            -- 规则原始推算日期
  postponed     INTEGER NOT NULL DEFAULT 0,
  weekday       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',          -- pending | done（该日车票已购得/已有同车次）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, travel_date),
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_dates_plan ON plan_dates(plan_id);

-- 购票任务
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL,
  plan_date_id  TEXT,
  user_id       TEXT NOT NULL,
  travel_date   TEXT NOT NULL,
  train_number  TEXT,
  sale_at       TEXT,                                     -- 起售时间（ISO，到点触发）
  status        TEXT NOT NULL DEFAULT 'pending',
  result        TEXT,                                     -- JSON
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_sale ON tasks(status, sale_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at);

-- 系统日志
CREATE TABLE IF NOT EXISTS logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  level      TEXT NOT NULL DEFAULT 'info',               -- debug|info|warn|error
  category   TEXT NOT NULL,                              -- auth|plan|session|bot|notify|scheduler
  message    TEXT NOT NULL,
  detail     TEXT,                                        -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_user_created ON logs(user_id, created_at DESC);
