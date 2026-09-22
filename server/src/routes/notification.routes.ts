import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { currentUser } from './auth.routes.js';
import { getDb } from '../db/index.js';
import { CHANNEL_TYPES, EVENTS, listChannels, publicChannel, validateConfig, deliver } from '../notify/channels.js';
const schema = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(60), type: z.enum(CHANNEL_TYPES), enabled: z.boolean(), events: z.array(z.enum(EVENTS)).min(1), config: z.object({ webhookUrl: z.string().max(2000).optional(), secret: z.string().max(500).optional(), botToken: z.string().max(200).optional(), chatId: z.string().max(200).optional(), bearerToken: z.string().max(1000).optional() }), clearSecrets: z.array(z.enum(['secret', 'bearerToken'])).default([]) });
export const notificationRoutes: FastifyPluginAsync = async app => {
  app.get('/api/notifications', async request => listChannels(currentUser(request).id).map(publicChannel));
  app.post('/api/notifications', async (request, reply) => {
    const user = currentUser(request), parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写名称、通道类型并至少选择一种通知事件' });
    const p = parsed.data, existing = listChannels(user.id), old = existing.find(c => c.id === p.id);
    if (p.id && !old) return reply.code(404).send({ error: '通道不存在' });
    if (!old && existing.length >= 20) return reply.code(400).send({ error: '每个用户最多配置 20 个通道' });
    const config = old?.type === p.type ? { ...old.config } : {};
    for (const [key, value] of Object.entries(p.config)) if (value?.trim()) config[key] = value.trim();
    for (const key of p.clearSecrets) delete config[key];
    try { validateConfig(p.type, config); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const id = old?.id || nanoid();
    getDb().prepare('INSERT INTO notification_channels (id, user_id, name, type, config, enabled, events) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, config=excluded.config, enabled=excluded.enabled, events=excluded.events').run(id, user.id, p.name, p.type, JSON.stringify(config), Number(p.enabled), JSON.stringify(p.events));
    return publicChannel(listChannels(user.id).find(c => c.id === id)!);
  });
  app.delete('/api/notifications/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = getDb().prepare('DELETE FROM notification_channels WHERE id = ? AND user_id = ?').run(id, currentUser(request).id);
    return result.changes ? { ok: true } : reply.code(404).send({ error: '通道不存在' });
  });
  const lastTest = new Map<string, number>();
  app.post('/api/notifications/:id/test', async (request, reply) => {
    const user = currentUser(request), { id } = request.params as { id: string };
    const channel = listChannels(user.id).find(c => c.id === id);
    if (!channel) return reply.code(404).send({ error: '通道不存在' });
    if (!channel.enabled) return reply.code(400).send({ error: '请先启用通道' });
    if (Date.now() - (lastTest.get(user.id) || 0) < 10000) return reply.code(429).send({ error: '请等待 10 秒后重试' });
    lastTest.set(user.id, Date.now());
    const result = await deliver(channel, '【my12306】通知通道测试：收到此消息说明配置成功。', 'test');
    return result.ok ? result : reply.code(400).send(result);
  });
};
