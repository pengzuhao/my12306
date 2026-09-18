/**
 * 飞书签名算法离线验证（不发送真实消息，只校验签名可复现）。
 * 运行：npm run test:feishu --workspace server
 */
import crypto from 'node:crypto';

function genSign(secret: string, timestamp: number): string {
  // 飞书官方算法：string_to_sign = timestamp + "\n" + secret，作为 HMAC key，消息为空
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', stringToSign);
  return hmac.digest('base64');
}

function main(): void {
  const secret = 'test-secret-for-sign';
  const timestamp = 1710000000;
  const sign = genSign(secret, timestamp);

  // 复算一次，确认确定性
  const sign2 = genSign(secret, timestamp);
  const determinstic = sign === sign2;

  // 签名应为合法 base64，长度 44（HMAC-SHA256 -> 32 bytes -> base64 44 字符）
  const buf = Buffer.from(sign, 'base64');
  const validLength = buf.length === 32;

  // 不同时间戳应产生不同签名
  const sign3 = genSign(secret, timestamp + 1);
  const differs = sign !== sign3;

  console.log('sign        =', sign);
  console.log('确定性       :', determinstic);
  console.log('HMAC 32字节 :', validLength);
  console.log('时间戳敏感   :', differs);

  const ok = determinstic && validLength && differs;
  console.log(ok ? '\n✅ 飞书签名验证通过' : '\n❌ 签名验证失败');
  process.exit(ok ? 0 : 1);
}

main();
