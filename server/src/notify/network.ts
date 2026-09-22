import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { RequestOptions } from 'node:https';

export class NotificationNetworkError extends Error {}

export function isPublicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function isFakeIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

/** Limit proxy compatibility to fixed official API hosts and endpoint shapes. */
function isOfficialEndpoint(url: URL): boolean {
  if (['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)) return /^\/open-apis\/bot\/v2\/hook\/[\w-]+$/.test(url.pathname);
  if (url.hostname === 'qyapi.weixin.qq.com') return url.pathname === '/cgi-bin/webhook/send' && !!url.searchParams.get('key');
  if (url.hostname === 'oapi.dingtalk.com') return url.pathname === '/robot/send' && !!url.searchParams.get('access_token');
  if (url.hostname === 'api.telegram.org') return /^\/bot\d+:[\w-]+\/sendMessage$/.test(url.pathname);
  return false;
}

/** Pin DNS while retaining the original hostname for SNI and certificate checks. Never follow redirects. */
export function notificationNetworkOptions(url: URL, addresses: Array<{ address: string; family: number }>): RequestOptions {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
    throw new NotificationNetworkError('通知地址须使用有效的 HTTPS 地址');
  }
  const official = isOfficialEndpoint(url);
  if (!addresses.length || addresses.some(a => a.family !== 4 || (!isPublicIPv4(a.address) && !(official && isFakeIPv4(a.address))))) {
    if (!official && addresses.some(a => isFakeIPv4(a.address))) {
      throw new NotificationNetworkError('Webhook 被代理解析为虚拟地址，请将该域名加入代理 DNS 的真实解析名单后重试');
    }
    throw new NotificationNetworkError('Webhook 必须指向公网地址，不支持本机或内网地址');
  }
  return {
    family: 4, agent: false, servername: url.hostname,
    rejectUnauthorized: true, checkServerIdentity,
    lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4),
  };
}
