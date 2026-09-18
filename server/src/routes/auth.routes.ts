/**
 * 认证与用户管理路由（需求 1：多用户，用户名+密码登录）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { UsersRepo } from '../db/repo.js';
import { JWT_SECRET, JWT_TTL } from '../config.js';
import { Logger } from '../logger.js';
import type { AuthUser } from '../types.js';

const logger = new Logger('auth');

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6),
  role: z.enum(['admin', 'user']).default('user'),
  displayName: z.string().optional(),
});

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
}

/** 签发 JWT */
function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role } satisfies JwtPayload, JWT_SECRET, {
    expiresIn: JWT_TTL,
  });
}

/** 从请求头解析当前用户（供其他路由复用） */
export function currentUser(request: { headers: Record<string, string | string[] | undefined> }): AuthUser | null {
  const header = request.headers.authorization;
  const token = Array.isArray(header) ? header[0] : header;
  if (!token?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(token.slice(7), JWT_SECRET) as JwtPayload;
    const user = UsersRepo.findById(payload.sub);
    return user ?? null;
  } catch {
    return null;
  }
}

export const authRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 登录 */
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    const { username, password } = parsed.data;
    const user = UsersRepo.findByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      logger.warn('登录失败：用户名或密码错误', { username });
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    logger.info('用户登录成功', { username });
    return {
      token: signToken(user),
      user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
    };
  });

  /** 当前用户信息 */
  app.get('/api/auth/me', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    return user;
  });

  /** 修改自己的密码 */
  app.post('/api/auth/change-password', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    const body = z.object({ oldPassword: z.string(), newPassword: z.string().min(6) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const record = UsersRepo.findByUsername(user.username);
    if (!record || !bcrypt.compareSync(body.data.oldPassword, record.passwordHash)) {
      return reply.code(401).send({ error: '原密码错误' });
    }
    UsersRepo.updatePassword(user.id, bcrypt.hashSync(body.data.newPassword, 10));
    return { ok: true };
  });

  /** 用户列表（仅管理员） */
  app.get('/api/users', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    if (user.role !== 'admin') return reply.code(403).send({ error: '无权限' });
    return UsersRepo.list();
  });

  /** 创建用户（仅管理员） */
  app.post('/api/users', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    if (user.role !== 'admin') return reply.code(403).send({ error: '无权限' });
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    const { username, password, role, displayName } = parsed.data;
    if (UsersRepo.findByUsername(username)) return reply.code(409).send({ error: '用户名已存在' });
    const created = UsersRepo.create(username, bcrypt.hashSync(password, 10), role, displayName);
    logger.info('创建用户', { username, role, by: user.username });
    return created;
  });

  /** 删除用户（仅管理员，不可删自己） */
  app.delete('/api/users/:id', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: '未登录' });
    if (user.role !== 'admin') return reply.code(403).send({ error: '无权限' });
    const { id } = request.params as { id: string };
    if (id === user.id) return reply.code(400).send({ error: '不可删除自己' });
    UsersRepo.delete(id);
    logger.info('删除用户', { id, by: user.username });
    return { ok: true };
  });

  done();
};
