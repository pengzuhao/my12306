const ORIGIN = 'my12306://app';
function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'my12306:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function createBackendClient(child, onEvent = () => {}, timeoutMs = 120000) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  child.on('message', message => {
    if (message?.type === 'event') { onEvent(message.message); return; }
    if (message?.type !== 'response') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message);
  });
  child.on('exit', () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('后台已停止')); }
    pending.clear();
  });
  return function request({ method = 'GET', url, headers = {}, body }) {
    if (closed) return Promise.reject(new Error('后台已停止'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('后台响应超时')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { child.postMessage({ type: 'request', id, method, url, headers, body }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  };
}

function createProtocolHandler(requestBackend) {
  return async function handle(request) {
    if (!isAppUrl(request.url)) return new Response('Forbidden', { status: 403 });
    const origin = request.headers.get('origin');
    if (origin && origin !== ORIGIN) return new Response('Forbidden', { status: 403 });
    try {
      const url = new URL(request.url);
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
      if (body?.byteLength > 4 * 1024 * 1024) return new Response('Payload too large', { status: 413 });
      const response = await requestBackend({ method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), body });
      const headers = { ...response.headers, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'" };
      return new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : new Uint8Array(response.body), { status: response.status, headers });
    } catch { return new Response('{"error":"后台暂时不可用，请重新打开应用"}', { status: 503, headers: { 'content-type': 'application/json' } }); }
  };
}
module.exports = { ORIGIN, isAppUrl, createBackendClient, createProtocolHandler };
