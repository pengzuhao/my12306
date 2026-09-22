/** 通道适配层：统一事件 → 独立发送器，不依赖任何模型或机器人运行时。 */
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { Logger } from '../logger.js';
import { NotificationNetworkError, notificationNetworkOptions } from './network.js';
export { isPublicIPv4 } from './network.js';
export const CHANNEL_TYPES = ['feishu', 'wecom', 'dingtalk', 'telegram', 'webhook'] as const;
export const EVENTS = ['order_success', 'duplicate_order', 'session_invalid', 'task_failed'] as const;
export type ChannelType = typeof CHANNEL_TYPES[number];
export type NotifyEvent = typeof EVENTS[number] | 'test';
export type Channel = { id: string; userId: string; name: string; type: ChannelType; config: Record<string, string>; enabled: boolean; events: string[]; lastStatus?: string; lastSentAt?: string };
export function migrateNotifications(): void {
  const db = getDb();
  db.transaction(() => {
    if (db.prepare("SELECT name FROM app_migrations WHERE name = 'notification_channels_v1'").get()) return;
    const rows = db.prepare('SELECT * FROM feishu_configs').all() as Record<string, unknown>[];
    for (const r of rows) db.prepare('INSERT INTO notification_channels (id, user_id, name, type, config, enabled, events) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nanoid(), r.user_id, '飞书通知', 'feishu', JSON.stringify({ webhookUrl: r.webhook_url, secret: r.secret || '' }), r.enabled, JSON.stringify(EVENTS));
    db.prepare("INSERT INTO app_migrations VALUES ('notification_channels_v1')").run();
  })();
}
export function listChannels(userId: string): Channel[] {
  return (getDb().prepare('SELECT * FROM notification_channels WHERE user_id = ? ORDER BY created_at, id').all(userId) as Record<string, unknown>[]).map(r => ({ id: String(r.id), userId, name: String(r.name), type: r.type as ChannelType, config: JSON.parse(String(r.config)), enabled: !!r.enabled, events: JSON.parse(String(r.events)), lastStatus: r.last_status as string, lastSentAt: r.last_sent_at as string }));
}
export function publicChannel(c: Channel) {
  return { ...c, config: { chatId: c.config.chatId || '' }, configured: Object.fromEntries(Object.entries(c.config).map(([k,v]) => [k, !!v])) };
}
export function validateConfig(type: ChannelType, c: Record<string, string>): void {
  if (type === 'telegram') { if (!/^\d+:[A-Za-z0-9_-]+$/.test(c.botToken || '') || !c.chatId?.trim()) throw new Error('请填写有效的 Bot Token 和 Chat ID'); return; }
  let u: URL; try { u = new URL(c.webhookUrl); } catch { throw new Error('请输入有效的 HTTPS Webhook 地址'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) throw new Error('Webhook 须使用 HTTPS 标准端口且不含用户信息');
  const hosts: Partial<Record<ChannelType, string[]>> = { feishu: ['open.feishu.cn', 'open.larksuite.com'], wecom: ['qyapi.weixin.qq.com'], dingtalk: ['oapi.dingtalk.com'] };
  if (hosts[type] && !hosts[type]!.includes(u.hostname)) throw new Error('Webhook 域名与所选平台不匹配');
}
export type Outbound = { url: string; body: unknown; headers: Record<string, string> };
export function buildMessage(channel: Channel, text: string, event: NotifyEvent, now = Date.now(), urgent = false): Outbound {
  const c = channel.config, headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url = c.webhookUrl, body: unknown;
  switch (channel.type) {
    case 'feishu': { const timestamp = String(Math.floor(now / 1000)); const payload: Record<string, unknown> = { msg_type: 'text', content: { text }, timestamp }; if (c.secret) payload.sign = createHmac('sha256', `${timestamp}\n${c.secret}`).digest('base64'); if (urgent) { payload.msg_type = 'interactive'; delete payload.content; payload.card = { header: { title: { tag: 'plain_text', content: '12306 购票提醒' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '<at id=all></at>\n' + text } }] }; } body = payload; break; }
    case 'wecom': body = { msgtype: 'text', text: { content: text, ...(urgent ? { mentioned_list: ['@all'] } : {}) } }; break;
    case 'dingtalk': { const u = new URL(url); if (c.secret) { u.searchParams.set('timestamp', String(now)); u.searchParams.set('sign', createHmac('sha256', c.secret).update(`${now}\n${c.secret}`).digest('base64')); } url = u.toString(); body = { msgtype: 'text', text: { content: text }, at: { isAtAll: urgent } }; break; }
    case 'telegram': url = `https://api.telegram.org/bot${c.botToken}/sendMessage`; body = { chat_id: c.chatId, text }; break;
    case 'webhook': if (c.bearerToken) headers.Authorization = `Bearer ${c.bearerToken}`; body = { source: 'my12306', event, text, urgent, timestamp: new Date(now).toISOString() }; break;
  }
  return { url, body, headers };
}
export async function postMessage(out: Outbound): Promise<{ status: number; data: Record<string, unknown> }> {
  const u = new URL(out.url);
  const addresses = await lookup(u.hostname, { family: 4, all: true });
  const network = notificationNetworkOptions(u, addresses);
  return new Promise((resolve, reject) => {
    const req = https.request(u, { ...network, method: 'POST', headers: out.headers }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(new Error('响应过大')); });
      res.on('end', () => { let data = {}; try { data = JSON.parse(body); } catch { /* 通用 Webhook 可返回空响应 */ } resolve({ status: res.statusCode || 0, data }); });
      res.on('error', reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error('通知请求超时')), 10000);
    req.on('close', () => clearTimeout(deadline)); req.on('error', reject);
    req.end(JSON.stringify(out.body));
  });
}
export async function deliver(channel: Channel, text: string, event: NotifyEvent, urgent = false, transport = postMessage): Promise<{ ok: boolean; error?: string }> {
  const logger = new Logger('notify', channel.userId);
  try {
    validateConfig(channel.type, channel.config);
    const r = await transport(buildMessage(channel, text, event, Date.now(), urgent));
    const d = r.data;
    const accepted = channel.type === 'feishu' ? (d.code === 0 || d.StatusMessage === 'success') : channel.type === 'telegram' ? d.ok === true : ['wecom', 'dingtalk'].includes(channel.type) ? d.errcode === 0 : true;
    if (r.status < 200 || r.status >= 300 || !accepted) throw new Error(`平台拒绝消息（HTTP ${r.status}，代码 ${String(d.code ?? d.errcode ?? d.error_code ?? '未知')}）`);
    getDb().prepare("UPDATE notification_channels SET last_status = 'success', last_sent_at = datetime('now') WHERE id = ? AND user_id = ?").run(channel.id, channel.userId);
    logger.info('通知已发送', { channel: channel.name, type: channel.type, event });
    return { ok: true };
  } catch (e) {
    // 不回显网络异常，异常文本可能包含 Bot Token / Webhook。
    const message = e instanceof Error ? e.message : '';
    const error = e instanceof NotificationNetworkError || /^(平台拒绝消息|通知请求超时)/.test(message) ? message : '发送失败，请检查地址、密钥、平台安全设置和网络连接';
    getDb().prepare("UPDATE notification_channels SET last_status = 'failed', last_sent_at = datetime('now') WHERE id = ? AND user_id = ?").run(channel.id, channel.userId);
    logger.warn(error, { channel: channel.name, type: channel.type, event });
    return { ok: false, error };
  }
}
export async function dispatch(userId: string, event: NotifyEvent, text: string, options: { urgent?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const channels = listChannels(userId).filter(c => c.enabled && (event === 'test' || c.events.includes(event)));
  if (!channels.length) return { ok: false, error: '没有订阅此事件的通知通道' };
  const results = await Promise.all(channels.map(c => deliver(c, text, event, options.urgent)));
  const failed = results.filter(r => !r.ok).length;
  return { ok: failed === 0, ...(failed ? { error: `${failed}/${channels.length} 个通道发送失败，详见过程日志` } : {}) };
}
