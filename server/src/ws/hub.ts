import type { WebSocket } from 'ws';

type WsMessage =
  | { type: 'log'; payload: unknown }
  | { type: 'session'; payload: unknown }
  | { type: 'captcha'; payload: unknown }
  | { type: 'qr_code'; payload: unknown }
  | { type: 'task'; payload: unknown }
  | { type: 'status'; payload: unknown };

/**
 * WebSocket 中心：管理台连接池。
 * 用途：
 *  - 实时推送日志
 *  - 12306 会话状态变化
 *  - 扫码登录二维码透传（交互式登录）
 *  - 购票任务进度
 */
class WsHubImpl {
  private clients = new Set<WebSocket>();
  private subscribers = new Set<{ userId: string; send: (message: WsMessage) => void }>();

  subscribe(userId: string, send: (message: WsMessage) => void): () => void {
    const subscriber = { userId, send };
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  private publish(message: WsMessage, userId?: string): void {
    for (const subscriber of this.subscribers) {
      if (userId && subscriber.userId !== userId) continue;
      try { subscriber.send(message); } catch { this.subscribers.delete(subscriber); }
    }
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  disconnectUser(userId: string): void {
    for (const ws of this.clients) if ((ws as WebSocket & { userId?: string }).userId === userId) ws.close(1008, '请重新登录');
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  size(): number {
    return this.clients.size + this.subscribers.size;
  }

  broadcast(message: WsMessage): void {
    this.publish(message);
    if (!this.clients.size) return;
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  /** 仅推送给指定用户的管理台连接 */
  broadcastToUser(userId: string, message: WsMessage): void {
    this.publish(message, userId);
    if (!this.clients.size) return;
    const data = JSON.stringify({ ...message, _userId: userId });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN && (ws as WebSocket & { userId?: string }).userId === userId) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }
}

export const wsHub = new WsHubImpl();
export type WsHub = WsHubImpl;
