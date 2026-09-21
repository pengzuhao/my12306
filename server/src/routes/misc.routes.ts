/**
 * 飞书配置与通知路由（需求 4）；任务与日志查询（需求 5）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { FeishuRepo, TasksRepo, LogsRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
import { sendFeishu } from '../notify/feishu.js';
import { Logger } from '../logger.js';

const logger = new Logger('api');

const feishuSchema = z.object({
  webhookUrl: z.string().url(),
  secret: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
  remark: z.string().nullable().optional(),
});

export const miscRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  /** 飞书配置 */
  app.get('/api/feishu', async () => {
    const user = currentUser();
    return FeishuRepo.get(user.id) ?? { webhookUrl: '', secret: null, enabled: true, remark: null };
  });

  app.post('/api/feishu', async (request, reply) => {
    const user = currentUser();
    const parsed = feishuSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.flatten() });
    const cfg = FeishuRepo.upsert(
      user.id,
      parsed.data.webhookUrl,
      parsed.data.secret ?? null,
      parsed.data.enabled,
      parsed.data.remark ?? undefined,
    );
    logger.info('保存飞书配置', { by: user.username });
    return cfg;
  });

  /** 发送测试消息（验证 webhook + 签名是否可用） */
  app.post('/api/feishu/test', async (request, reply) => {
    const user = currentUser();
    const result = await sendFeishu(user.id, '【my12306】飞书消息通道测试 ✓ 收到此消息说明 webhook 与签名配置正确');
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  /** 任务列表 */
  app.get('/api/tasks', async () => {
    const user = currentUser();
    return TasksRepo.list(user.id, 100);
  });

  /** 日志列表 */
  app.get('/api/logs', async (request) => {
    const user = currentUser();
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 100), 500);
    // 单用户模式下内置用户即管理员，可看全部日志
    return LogsRepo.list(user.role === 'admin' ? null : user.id, limit);
  });

  done();
};
