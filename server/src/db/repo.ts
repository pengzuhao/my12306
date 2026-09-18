import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { getDb } from './index.js';
import type {
  AuthUser,
  FeishuConfig,
  Passenger,
  Plan,
  RailwayAccountStatus,
  Task,
  TaskStatus,
  UserRole,
} from '../types.js';

/** 把行记录里的 JSON 文本字段解包，转为领域模型 */
function rowToPlan(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    status: row.status as Plan['status'],
    fromStation: row.from_station as string,
    toStation: row.to_station as string,
    dateMode: row.date_mode as Plan['dateMode'],
    travelDate: (row.travel_date as string) ?? null,
    weekday: (row.weekday as number) ?? null,
    weekInterval: (row.week_interval as number) ?? 1,
    validFrom: row.valid_from as string,
    validUntil: (row.valid_until as string) ?? null,
    timeFrom: (row.time_from as string) ?? null,
    timeTo: (row.time_to as string) ?? null,
    trainNumbers: row.train_numbers ? JSON.parse(row.train_numbers as string) : null,
    seatPositions: row.seat_positions ? JSON.parse(row.seat_positions as string) : null,
    passengerIds: JSON.parse(row.passenger_ids as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    planId: row.plan_id as string,
    planDateId: (row.plan_date_id as string) ?? null,
    userId: row.user_id as string,
    travelDate: row.travel_date as string,
    trainNumber: (row.train_number as string) ?? null,
    saleAt: (row.sale_at as string) ?? null,
    status: row.status as TaskStatus,
    result: row.result ? JSON.parse(row.result as string) : null,
    attempts: (row.attempts as number) ?? 0,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
  };
}

export const UsersRepo = {
  findByUsername(username: string): AuthUser & { passwordHash: string } | null {
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      username: r.username as string,
      role: r.role as UserRole,
      displayName: (r.display_name as string) ?? (r.username as string),
      passwordHash: r.password_hash as string,
    };
  },
  findById(id: string): AuthUser | null {
    const row = getDb().prepare('SELECT id, username, role, display_name FROM users WHERE id = ?').get(id);
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      username: r.username as string,
      role: r.role as UserRole,
      displayName: (r.display_name as string) ?? (r.username as string),
    };
  },
  list(): AuthUser[] {
    const rows = getDb()
      .prepare('SELECT id, username, role, display_name FROM users ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      username: r.username as string,
      role: r.role as UserRole,
      displayName: (r.display_name as string) ?? (r.username as string),
    }));
  },
  create(username: string, passwordHash: string, role: UserRole, displayName?: string): AuthUser {
    const id = nanoid();
    getDb()
      .prepare('INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, passwordHash, role, displayName ?? username);
    return { id, username, role, displayName: displayName ?? username };
  },
  updatePassword(id: string, passwordHash: string): void {
    getDb().prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, id);
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

export const RailwayAccountRepo = {
  get(userId: string): { id: string; username: string | null; status: RailwayAccountStatus; lastLoginAt: string | null; failReason: string | null } | null {
    const row = getDb().prepare('SELECT * FROM railway_accounts WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      username: (row.username as string | null) ?? null,
      status: row.status as RailwayAccountStatus,
      lastLoginAt: (row.last_login_at as string) ?? null,
      failReason: (row.fail_reason as string) ?? null,
    };
  },
  /** 记录一次登录尝试（不保存密码，仅记用户名用于展示） */
  upsert(userId: string, username: string | null): void {
    getDb()
      .prepare(
        `INSERT INTO railway_accounts (id, user_id, username, status, updated_at)
         VALUES (?, ?, ?, 'logging_in', datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, updated_at = datetime('now')`,
      )
      .run(nanoid(), userId, username);
  },
  updateStatus(userId: string, status: RailwayAccountStatus, failReason?: string | null): void {
    const db: Database.Database = getDb();
    if (status === 'active') {
      db.prepare(
        `UPDATE railway_accounts SET status = ?, fail_reason = NULL, last_login_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`,
      ).run(status, userId);
    } else {
      db.prepare(
        `UPDATE railway_accounts SET status = ?, fail_reason = ?, last_check_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`,
      ).run(status, failReason ?? null, userId);
    }
  },
  touchCheck(userId: string): void {
    getDb()
      .prepare(`UPDATE railway_accounts SET last_check_at = datetime('now') WHERE user_id = ?`)
      .run(userId);
  },
};

export const PassengersRepo = {
  list(userId: string): Passenger[] {
    const rows = getDb().prepare('SELECT * FROM passengers WHERE user_id = ? ORDER BY created_at').all(userId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      name: r.name as string,
      idTypeCode: (r.id_type_code as string) ?? '1',
      idNo: r.id_no as string,
      phone: (r.phone as string) ?? null,
      passengerType: (r.passenger_type as string) ?? '成人',
      source: (r.source as 'manual' | '12306') ?? 'manual',
      createdAt: r.created_at as string,
    }));
  },
  upsert(userId: string, p: Omit<Passenger, 'id' | 'userId' | 'createdAt'> & { id?: string }): Passenger {
    const db = getDb();
    const id = p.id ?? nanoid();
    db.prepare(
      `INSERT INTO passengers (id, user_id, name, id_type_code, id_no, phone, passenger_type, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, id_no = excluded.id_no, phone = excluded.phone, passenger_type = excluded.passenger_type`,
    ).run(id, userId, p.name, p.idTypeCode, p.idNo, p.phone, p.passengerType, p.source);
    return { ...p, id, userId, createdAt: new Date().toISOString() };
  },
  bulkUpsert(userId: string, list: Omit<Passenger, 'id' | 'userId' | 'createdAt'>[]): void {
    const db = getDb();
    const tx = db.transaction((rows: typeof list) => {
      for (const p of rows) PassengersRepo.upsert(userId, p);
    });
    tx(list);
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM passengers WHERE id = ?').run(id);
  },
};

export const FeishuRepo = {
  get(userId: string): FeishuConfig | null {
    const row = getDb().prepare('SELECT * FROM feishu_configs WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      userId: row.user_id as string,
      webhookUrl: row.webhook_url as string,
      secret: (row.secret as string) ?? null,
      enabled: Boolean(row.enabled),
      remark: (row.remark as string) ?? null,
      createdAt: row.created_at as string,
    };
  },
  upsert(userId: string, webhookUrl: string, secret: string | null, enabled: boolean, remark?: string): FeishuConfig {
    getDb()
      .prepare(
        `INSERT INTO feishu_configs (id, user_id, webhook_url, secret, enabled, remark)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET webhook_url = excluded.webhook_url, secret = excluded.secret, enabled = excluded.enabled, remark = excluded.remark`,
      )
      .run(nanoid(), userId, webhookUrl, secret, enabled ? 1 : 0, remark ?? null);
    return FeishuRepo.get(userId) as FeishuConfig;
  },
};

export const PlansRepo = {
  list(userId: string, includeDeleted = false): Plan[] {
    const sql = includeDeleted
      ? 'SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM plans WHERE user_id = ? AND status != ? ORDER BY created_at DESC';
    const rows = getDb().prepare(sql).all(userId, 'deleted') as Record<string, unknown>[];
    return rows.map(rowToPlan);
  },
  get(id: string): Plan | null {
    const row = getDb().prepare('SELECT * FROM plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToPlan(row) : null;
  },
  save(plan: Omit<Plan, 'createdAt' | 'updatedAt'>): Plan {
    const db = getDb();
    const now = new Date().toISOString();
    const json = <T>(v: T[] | null): string | null => (v ? JSON.stringify(v) : null);
    db.prepare(
      `INSERT INTO plans (id, user_id, name, status, from_station, to_station, date_mode, travel_date, weekday, week_interval, valid_from, valid_until, time_from, time_to, train_numbers, seat_positions, passenger_ids, created_at, updated_at)
       VALUES (@id, @user_id, @name, @status, @from_station, @to_station, @date_mode, @travel_date, @weekday, @week_interval, @valid_from, @valid_until, @time_from, @time_to, @train_numbers, @seat_positions, @passenger_ids, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, from_station = excluded.from_station, to_station = excluded.to_station, date_mode = excluded.date_mode, travel_date = excluded.travel_date, weekday = excluded.weekday, week_interval = excluded.week_interval, valid_from = excluded.valid_from, valid_until = excluded.valid_until, time_from = excluded.time_from, time_to = excluded.time_to, train_numbers = excluded.train_numbers, seat_positions = excluded.seat_positions, passenger_ids = excluded.passenger_ids, updated_at = excluded.updated_at`,
    ).run({
      id: plan.id,
      user_id: plan.userId,
      name: plan.name,
      status: plan.status,
      from_station: plan.fromStation,
      to_station: plan.toStation,
      date_mode: plan.dateMode,
      travel_date: plan.travelDate,
      weekday: plan.weekday,
      week_interval: plan.weekInterval,
      valid_from: plan.validFrom,
      valid_until: plan.validUntil,
      time_from: plan.timeFrom,
      time_to: plan.timeTo,
      train_numbers: json(plan.trainNumbers),
      seat_positions: json(plan.seatPositions),
      passenger_ids: JSON.stringify(plan.passengerIds),
      created_at: now,
      updated_at: now,
    });
    return PlansRepo.get(plan.id) as Plan;
  },
  setStatus(id: string, status: Plan['status']): void {
    getDb().prepare(`UPDATE plans SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  },
  listActive(): Plan[] {
    const rows = getDb()
      .prepare(`SELECT * FROM plans WHERE status = 'active' ORDER BY user_id, created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToPlan);
  },
};

export const PlanDatesRepo = {
  /** 用本次推算结果整体覆盖该计划的日期（保留既有 travel_date 以便任务关联） */
  replaceForPlan(planId: string, entries: { travelDate: string; originalDate: string; postponed: boolean; weekday: number }[]): void {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const e of entries) {
        db.prepare(
          `INSERT INTO plan_dates (id, plan_id, travel_date, original_date, postponed, weekday)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(plan_id, travel_date) DO UPDATE SET original_date = excluded.original_date, postponed = excluded.postponed, weekday = excluded.weekday`,
        ).run(nanoid(), planId, e.travelDate, e.originalDate, e.postponed ? 1 : 0, e.weekday);
      }
    });
    tx();
  },
  list(planId: string): { id: string; travelDate: string; originalDate: string; postponed: boolean; weekday: number; status: 'pending' | 'done' }[] {
    const rows = getDb()
      .prepare('SELECT * FROM plan_dates WHERE plan_id = ? ORDER BY travel_date ASC')
      .all(planId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      travelDate: r.travel_date as string,
      originalDate: r.original_date as string,
      postponed: Boolean(r.postponed),
      weekday: r.weekday as number,
      status: (r.status as 'pending' | 'done') ?? 'pending',
    }));
  },
  /** 标记某一天的车票已购得（查重命中或下单成功后调用） */
  markDone(planId: string, travelDate: string): void {
    getDb().prepare("UPDATE plan_dates SET status = 'done' WHERE plan_id = ? AND travel_date = ?").run(planId, travelDate);
  },
};

export const TasksRepo = {
  list(userId: string, limit = 50): Task[] {
    const rows = getDb()
      .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map(rowToTask);
  },
  get(id: string): Task | null {
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  },
  create(task: Omit<Task, 'id' | 'createdAt' | 'attempts' | 'status' | 'result' | 'error' | 'startedAt' | 'finishedAt'> & { status?: TaskStatus }): Task {
    const id = nanoid();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, plan_id, plan_date_id, user_id, travel_date, train_number, sale_at, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(id, task.planId, task.planDateId, task.userId, task.travelDate, task.trainNumber, task.saleAt, task.status ?? 'pending');
    return TasksRepo.get(id) as Task;
  },
  update(id: string, patch: Partial<Task>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.saleAt !== undefined) {
      sets.push('sale_at = ?');
      values.push(patch.saleAt);
    }
    if (patch.trainNumber !== undefined) {
      sets.push('train_number = ?');
      values.push(patch.trainNumber);
    }
    if (patch.result !== undefined) {
      sets.push('result = ?');
      values.push(patch.result ? JSON.stringify(patch.result) : null);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      values.push(patch.error);
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?');
      values.push(patch.attempts);
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?');
      values.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now')");
    values.push(id);
    getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },
  /** 取出到点需要触发的任务 */
  listDue(now: string, limit = 20): Task[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('queried')
           AND sale_at IS NOT NULL
           AND sale_at <= ?
         ORDER BY sale_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map(rowToTask);
  },
  listPending(limit = 50): Task[] {
    const rows = getDb()
      .prepare(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY travel_date ASC, created_at ASC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToTask);
  },
};

export const LogsRepo = {
  list(userId: string | null, limit = 100): Record<string, unknown>[] {
    const sql = userId
      ? 'SELECT * FROM logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM logs ORDER BY created_at DESC LIMIT ?';
    const params = userId ? [userId, limit] : [limit];
    return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  },
};
