import { socketRoutes } from './ws/routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { migrateNotifications } from './notify/channels.js';
import { logRoutes } from './routes/log.routes.js';
/**
 * 后端服务入口。
 *
 * - Fastify HTTP API（默认本地单用户，可选管理员多用户模式）
 * - WebSocket：日志/会话/任务状态推送 + 验证码透传
 * - 静态托管管理台前端（生产环境）
 * - 启动调度器与保活
 *
 * 运行：
 *   npm run dev:server     开发模式（热重载）
 *   npm run build:server && npm run start:server   生产模式
 */
import { registerAuth } from './routes/auth.routes.js';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { HOST, PORT, MULTI_USER, SYSTEM_USER_ID } from './config.js';
import { attachDesktopTransport, type DesktopPort } from './desktop-transport.js';
import { cnTime } from './utils/cn-time.js';
import { applySchema, seedAdmin, closeDb } from './db/index.js';
import { setLogHub, Logger } from './logger.js';
import { wsHub } from './ws/hub.js';
import { planRoutes } from './routes/plan.routes.js';
import { sessionRoutes } from './routes/session.routes.js';
import { orderRoutes } from './routes/order.routes.js';
import { miscRoutes } from './routes/misc.routes.js';
import { startScheduler, stopScheduler } from './scheduler/scheduler.js';
import { startKeepalive, stopKeepalive, shutdownSessions, runKeepalive } from './bot/session.js';
import { cleanupBrowser } from './bot/browser.js';
import { ensureYears } from './calendar/holidays.js';

const logger = new Logger('app');

async function bootstrap(): Promise<void> {
  // 数据库
  applySchema();
  seedAdmin();
  migrateNotifications();

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  const runtimeToken = process.env.MY12306_RUNTIME_TOKEN;
  if (runtimeToken) {
    if (HOST !== '127.0.0.1') throw new Error('桌面后端只允许监听本机');
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-my12306-desktop'] !== runtimeToken) return reply.code(403).send({ error: '桌面服务仅允许本应用访问' });
    });
  }
  registerAuth(app);

  // WebSocket 与 HTTP 使用同一登录会话，消息按用户隔离。
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  await app.register(socketRoutes);

  // 路由
  await app.register(planRoutes);
  await app.register(sessionRoutes);
  await app.register(orderRoutes);
  await app.register(miscRoutes);
  await app.register(logRoutes);
  await app.register(notificationRoutes);

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

  // 优雅退出
  let shuttingDown = false;
  let detachDesktop: (() => void) | undefined;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    detachDesktop?.();
    stopScheduler();
    stopKeepalive();
    logger.info('服务关闭中...');
    await app.close();
    await shutdownSessions();
    cleanupBrowser();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const parentPort = (process as typeof process & { parentPort?: DesktopPort }).parentPort;
  parentPort?.on('message', event => { if (event.data?.type === 'shutdown') void shutdown();
    if (event.data?.type === 'resume') void runKeepalive().catch(error => logger.warn('唤醒后会话检查失败', { error: String(error) })); });
  const desktopIpc = process.env.MY12306_TRANSPORT === 'ipc';
  let address: string | undefined;
  if (desktopIpc) {
    if (!parentPort || MULTI_USER || runtimeToken) throw new Error('桌面内部通信需要独立的单用户桌面进程');
    detachDesktop = await attachDesktopTransport(app, parentPort, SYSTEM_USER_ID);
  } else {
    address = await app.listen({ host: HOST, port: PORT });
  }
  startScheduler();
  startKeepalive();
  logger.info(desktopIpc ? 'my12306 桌面后台已启动（内部通信，无监听端口）' : `my12306 后端服务已启动: ${address}`);
  parentPort?.postMessage({ type: 'ready', transport: desktopIpc ? 'ipc' : 'http', listening: app.server.listening, url: address });
  const parentPid = Number(process.env.MY12306_PARENT_PID);
  if (parentPort && parentPid) setInterval(() => {
    try { process.kill(parentPid, 0); } catch { void shutdown(); }
  }, 5000).unref();

  // 启动后后台预热当年的节假日数据，首次打开首页日历即可命中本地缓存
  // （不 await、不阻塞启动；某年数据源未发布时只是降级，不影响服务可用）
  const y = new Date().getFullYear();
  void ensureYears([y]).then((ok) => {
    if (shuttingDown) return;
    logger.info(`节假日数据预热完成：${[...ok].join(', ') || '无'}`);
  });
}

void bootstrap().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
