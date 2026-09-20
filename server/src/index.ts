/**
 * 后端服务入口。
 *
 * - Fastify HTTP API（JWT 鉴权）
 * - WebSocket：日志/会话/任务状态推送 + 验证码透传
 * - 静态托管管理台前端（生产环境）
 * - 启动调度器与保活
 *
 * 运行：
 *   npm run dev:server     开发模式（热重载）
 *   npm run build:server && npm run start:server   生产模式
 */
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { HOST, PORT } from './config.js';
import { cnTime } from './utils/cn-time.js';
import { applySchema, seedAdmin } from './db/index.js';
import { setLogHub, Logger } from './logger.js';
import { wsHub } from './ws/hub.js';
import { authRoutes, currentUser } from './routes/auth.routes.js';
import { planRoutes } from './routes/plan.routes.js';
import { sessionRoutes } from './routes/session.routes.js';
import { orderRoutes } from './routes/order.routes.js';
import { miscRoutes } from './routes/misc.routes.js';
import { startScheduler } from './scheduler/scheduler.js';
import { startKeepalive, cancelQrLogin } from './bot/session.js';
import { cleanupBrowser } from './bot/browser.js';

const logger = new Logger('app');

async function bootstrap(): Promise<void> {
  // 数据库
  applySchema();
  seedAdmin();

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  // WebSocket：/ws?token=<jwt>
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket, request) => {
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');
      let userId: string | null = null;
      if (token) {
        const user = currentUser({ headers: { authorization: `Bearer ${token}` } });
        userId = user?.id ?? null;
      }
      if (!userId) {
        socket.close(4001, '未授权');
        return;
      }
      (socket as unknown as { userId: string }).userId = userId;
      wsHub.add(socket);
      socket.send(JSON.stringify({ type: 'status', payload: { connected: true, time: cnTime() } }));
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
          // 管理台取消扫码登录
          if (msg.type === 'qr_cancel') {
            cancelQrLogin(userId as string);
          }
        } catch {
          // 忽略非法消息
        }
      });
    });
  });

  // 路由
  await app.register(authRoutes);
  await app.register(planRoutes);
  await app.register(sessionRoutes);
  await app.register(orderRoutes);
  await app.register(miscRoutes);

  // 健康检查（东八区时间，用户要求所有时间都展示北京时间）
  app.get('/api/health', async () => ({ ok: true, time: cnTime() }));

  // 生产环境托管前端
  const webDist = path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // SPA 回退：非 /api 的 GET 404 一律返回 index.html，交给前端路由处理
    app.setNotFoundHandler((request, reply) => {
      const isHtml =
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        (request.headers.accept ?? '').includes('text/html');
      if (isHtml) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
    logger.info('已挂载管理台前端', { dir: webDist });
  }

  setLogHub(wsHub);
  startScheduler();
  startKeepalive();

  // 优雅退出
  const shutdown = () => {
    logger.info('服务关闭中...');
    cleanupBrowser();
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: HOST, port: PORT });
  logger.info(`my12306 后端服务已启动: http://${HOST}:${PORT}`);
  logger.info('默认管理员账号：admin / admin123（请尽快修改）');
}

void bootstrap().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
