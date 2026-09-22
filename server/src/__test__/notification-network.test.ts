import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServerIdentity } from 'node:tls';
import { notificationNetworkOptions, isPublicIPv4 } from '../notify/network.js';

const address = (ip: string) => [{ address: ip, family: 4 }];
const feishu = new URL('https://open.feishu.cn/open-apis/bot/v2/hook/TEST-ONLY');
test('official notification endpoints accept proxy Fake-IP with strict TLS and pinned DNS', async () => {
  for (const url of [feishu, new URL('https://open.larksuite.com/open-apis/bot/v2/hook/TEST'), new URL('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TEST'), new URL('https://oapi.dingtalk.com/robot/send?access_token=TEST'), new URL('https://api.telegram.org/bot123:TEST/sendMessage')]) {
    for (const ip of ['198.18.0.91', '198.19.255.254']) {
      const options = notificationNetworkOptions(url, address(ip));
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.checkServerIdentity, checkServerIdentity);
      assert.equal(options.servername, url.hostname);
      assert.equal(options.agent, false);
      await new Promise<void>((resolve, reject) => {
        options.lookup!(url.hostname, {}, (error, resolved, family) => {
          try { assert.equal(error, null); assert.equal(resolved, ip); assert.equal(family, 4); resolve(); } catch (e) { reject(e); }
        });
      });
    }
  }
});
test('Fake-IP compatibility cannot be used for arbitrary hosts, paths, IP literals or HTTP', () => {
  for (const url of ['https://example.com/hook', 'https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/TEST', 'https://open.feishu.cn/redirect', 'https://198.18.0.91/open-apis/bot/v2/hook/TEST', 'http://open.feishu.cn/open-apis/bot/v2/hook/TEST', 'https://open.feishu.cn:8443/open-apis/bot/v2/hook/TEST', 'https://user@open.feishu.cn/open-apis/bot/v2/hook/TEST']) {
    assert.throws(() => notificationNetworkOptions(new URL(url), address('198.18.0.91')));
  }
});
test('official hosts still reject local, private, mixed private/public and malformed answers', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '198.51.100.1', '203.0.113.1', '198.18..1']) {
    assert.throws(() => notificationNetworkOptions(feishu, address(ip)));
  }
  assert.throws(() => notificationNetworkOptions(feishu, [...address('8.8.8.8'), ...address('127.0.0.1')]));
  assert.throws(() => notificationNetworkOptions(feishu, []));
  assert.throws(() => notificationNetworkOptions(feishu, [{ address: '::1', family: 6 }]));
});
test('generic public webhooks remain supported and documentation networks are classified precisely', () => {
  assert.doesNotThrow(() => notificationNetworkOptions(new URL('https://example.com/hook'), address('8.8.8.8')));
  assert.equal(isPublicIPv4('198.51.99.1'), true);
  assert.equal(isPublicIPv4('203.0.112.1'), true);
  assert.equal(isPublicIPv4('198.51.100.1'), false);
  assert.equal(isPublicIPv4('203.0.113.1'), false);
});
