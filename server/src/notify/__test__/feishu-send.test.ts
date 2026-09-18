/**
 * 飞书消息通道集成测试（真实发送）。
 * 凭据从 data/feishu-test.json 读取（该目录已 gitignore，不会泄露密钥）。
 * 运行：npm run test:feishu-send --workspace server
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../../config.js';

interface TestCfg {
  webhookUrl: string;
  secret: string | null;
}

function loadCfg(): TestCfg {
  const file = path.join(DATA_DIR, 'feishu-test.json');
  if (!fs.existsSync(file)) {
    console.error('未找到 data/feishu-test.json，请放入 webhookUrl 与 secret');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TestCfg;
}

async function send(cfg: TestCfg, body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const ok = res.ok && ((data as { code?: number }).code === 0 || (data as { StatusMessage?: string }).StatusMessage === 'success');
  return { ok, data };
}

function genSign(secret: string, timestamp: number): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).digest('base64');
}

async function main(): Promise<void> {
  const cfg = loadCfg();
  console.log('webhook:', cfg.webhookUrl.slice(0, 48) + '...');
  console.log('secret :', cfg.secret ? '已配置(' + cfg.secret.slice(0, 4) + '...)' : '无（明文模式）');

  const timestamp = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    timestamp: String(timestamp),
    msg_type: 'text',
    content: { text: '【my12306 集成测试】消息通道连通性验证 ✓（带签名校验）' },
  };
  if (cfg.secret) base.sign = genSign(cfg.secret, timestamp);

  const r = await send(cfg, base);
  console.log('发送结果：', r.ok ? '✅ 成功' : '❌ 失败', JSON.stringify(r.data));

  // 验证错误签名会被拒绝（证明签名校验确实生效）
  const badBase = { ...base, sign: genSign('wrong-secret', timestamp) };
  const r2 = await send(cfg, badBase);
  const signEnforced = !r2.ok;
  console.log('错误签名被拒绝：', signEnforced ? '✅ 签名校验生效' : '⚠️ 未拦截（群机器人可能未启用签名）');

  process.exit(r.ok ? 0 : 1);
}

void main();
