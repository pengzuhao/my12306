/**
 * 视觉端到端验证：用无头 Chromium 打开管理台，截图验证关键流程。
 * 不占用用户本地浏览器（Playwright 自带 Chromium，独立 profile）。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/tmp/my12306-shots';
const BASE = 'http://127.0.0.1:7788';

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();

  const results: string[] = [];

  async function shot(name: string): Promise<void> {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    results.push(name);
    console.log(`📸 ${name}.png`);
  }

  // 1) 登录页
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('01-login');

  // 2) 登录
  await page.fill('input[placeholder="请输入用户名"]', 'admin');
  await page.fill('input[placeholder="请输入密码"]', 'admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await sleep(1500);
  await shot('02-dashboard');

  // 3) 购票计划页
  await page.goto(`${BASE}/#/plans`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('03-plans');

  // 4) 打开新建计划弹窗
  await page.getByRole('button', { name: '新建计划' }).click();
  await sleep(600);
  await shot('04-plan-new');

  // 5) 填写并推算日期预览
  await page.fill('input[placeholder="如：南京到上海 每周一"]', '南京到上海 每周一');
  await page.fill('input[placeholder="如：南京"]', '南京');
  await page.fill('input[placeholder="如：上海"]', '上海');
  await page.getByRole('button', { name: '推算日期预览' }).click();
  await sleep(1000);
  await shot('05-plan-preview');

  // 关闭弹窗
  await page.keyboard.press('Escape').catch(() => undefined);
  await sleep(300);

  // 6) 12306 会话页
  await page.goto(`${BASE}/#/session`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('06-session');

  // 7) 飞书通知页
  await page.goto(`${BASE}/#/feishu`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('07-feishu');

  // 8) 任务与日志页
  await page.goto(`${BASE}/#/tasks`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('08-tasks');

  // 9) 用户管理页（admin 可见）
  await page.goto(`${BASE}/#/users`, { waitUntil: 'networkidle' });
  await sleep(800);
  await shot('09-users');

  await browser.close();
  console.log(`\n✅ 视觉验证完成，共 ${results.length} 张截图：${OUT}/`);
}

void main().catch((e) => {
  console.error('❌ 视觉验证失败:', e);
  process.exit(1);
});
