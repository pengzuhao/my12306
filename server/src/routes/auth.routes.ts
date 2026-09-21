/**
 * 内置用户解析。
 *
 * 系统取消"用户"概念与登录机制后，所有数据（计划、任务、乘车人、飞书配置、
 * 12306 会话）都归属唯一的内置用户。需要人为区分的只有"12306 账号是否已扫码
 * 登录"，由 session 路由与前端顶栏承载，与本模块无关。
 *
 * 保留单一内置用户而不是彻底移除 user_id 字段：改动小、历史数据不丢、可回退。
 */
import { UsersRepo } from '../db/repo.js';
import { SYSTEM_USER_ID } from '../config.js';
import type { AuthUser } from '../types.js';

/** 内置用户 ID（固定常量，新建库直接用此 ID） */
export { SYSTEM_USER_ID };

let resolved: AuthUser | null = null;

/**
 * 返回当前请求所属用户。单用户模式下忽略请求头，恒返回内置用户；
 * 内置用户不存在时（理论上仅旧库未迁移时发生）即时创建一个。
 */
export function currentUser(): AuthUser {
  if (resolved) return resolved;
  const existing = UsersRepo.findById(SYSTEM_USER_ID);
  if (existing) {
    resolved = existing;
    return existing;
  }
  // 旧库没有 id='system' 的用户：直接把记录建出来。历史数据仍归属于各自 user_id，
  // 但新建数据从此统一走内置用户——对本系统（此前只有一个 admin）无实际影响。
  const created = UsersRepo.createBuiltIn(SYSTEM_USER_ID);
  resolved = created;
  return created;
}
