import type { FastifyInstance } from 'fastify';
import { wsHub } from './ws/hub.js';

export interface DesktopPort {
  on(event: 'message', cb: (event: { data: any }) => void): void;
  postMessage(value: unknown): void;
}

/** Private inherited process channel; no network socket is opened. */
export async function attachDesktopTransport(app: FastifyInstance, port: DesktopPort, userId: string): Promise<() => void> {
  await app.ready();
  const unsubscribe = wsHub.subscribe(userId, message => port.postMessage({ type: 'event', message }));
  port.on('message', ({ data }) => {
    if (data?.type !== 'request' || !Number.isSafeInteger(data.id)) return;
    void (async () => {
      try {
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(data.method)
          || typeof data.url !== 'string' || !data.url.startsWith('/') || data.url.startsWith('//')
          || data.url.includes('\\') || data.url.length > 16384) throw new Error('请求无效');
        const bytes = data.body ? Buffer.from(data.body) : undefined;
        const payload = bytes?.byteLength ? bytes : undefined;
        const requestHeaders = { ...data.headers, host: 'app' };
        // Fetch forwards a zero-length byte array for bodyless desktop actions.
        // Do not ask Fastify to parse an absent body as form data or empty JSON.
        if (!payload) {
          for (const name of Object.keys(requestHeaders)) {
            if (['content-type', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) delete requestHeaders[name];
          }
        }
        if (payload && payload.byteLength > 4 * 1024 * 1024) {
          port.postMessage({ type: 'response', id: data.id, status: 413, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"请求内容过大"}') });
          return;
        }
        const response = await app.inject({ method: data.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS', url: data.url, headers: requestHeaders, payload });
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value != null && !['connection', 'transfer-encoding', 'content-length'].includes(name)) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        port.postMessage({ type: 'response', id: data.id, status: response.statusCode, headers, body: response.rawPayload });
      } catch {
        port.postMessage({ type: 'response', id: data.id, status: 500, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"应用内部请求失败"}') });
      }
    })();
  });
  return unsubscribe;
}
