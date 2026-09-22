import type { FastifyPluginCallback } from 'fastify';
import { currentUser } from '../routes/auth.routes.js';
import { cancelQrLogin } from '../bot/session.js';
import { cnTime } from '../utils/cn-time.js';
import { wsHub } from './hub.js';
/** root onRequest 已验证 Cookie；这里只绑定经过验证的用户。 */
export const socketRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const userId = currentUser(request).id;
    (socket as unknown as { userId: string }).userId = userId;
    if (request.authExpires) {
      const timer = setTimeout(() => socket.close(1008, '登录已过期'), request.authExpires - Date.now());
      socket.on('close', () => clearTimeout(timer));
    }
    wsHub.add(socket);
    socket.send(JSON.stringify({ type: 'status', payload: { connected: true, time: cnTime() } }));
    socket.on('message', raw => {
      try { const msg = JSON.parse(raw.toString()); if (msg.type === 'qr_cancel' && typeof msg.payload?.attemptId === 'string') cancelQrLogin(userId, msg.payload.attemptId); }
      catch { /* 忽略非法消息 */ }
    });
  });
  done();
};
