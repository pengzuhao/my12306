/**
 * 浏览器管理器（需求 3、6）。
 *
 * - 使用 Playwright 内置 Chromium + 独立 user-data-dir，绝不占用用户本地浏览器
 * - macOS：无头模式（等价于 xvfb 的效果：不弹窗、不抢占当前浏览器）
 * - Linux：优先尝试 xvfb 虚拟显示（需求 3 指定的方式），不可用时回退无头
 *
 * 每个系统用户一个独立 browser context（持久化 storageState），互不干扰。
 */
import { chromium, type BrowserContext } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_PROFILE_DIR, HEADLESS } from '../config.js';
import { Logger } from '../logger.js';

const logger = new Logger('bot');

let xvfbProc: ChildProcess | null = null;

/** Linux 下启动 Xvfb 虚拟显示 */
function ensureXvfb(): void {
  if (process.platform !== 'linux') return;
  if (process.env.DISPLAY) {
    logger.info('Linux 检测到已有 DISPLAY，直接使用', { display: process.env.DISPLAY });
    return;
  }
  try {
    const display = ':99';
    xvfbProc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac'], {
      stdio: 'ignore',
      detached: false,
    });
    process.env.DISPLAY = display;
    logger.info('已启动 Xvfb 虚拟显示', { display });
  } catch (e) {
    logger.warn('启动 Xvfb 失败，回退无头模式（需系统已安装 xvfb：apt install xvfb）', e);
  }
}

interface LaunchOptions {
  userId: string;
  /** 覆盖无头设置 */
  headless?: boolean;
}

/** storageState 备份文件路径（登录态主动落盘，避免进程被 kill 时 cookie 未 flush） */
export function storageStatePath(userId: string): string {
  return path.join(BROWSER_PROFILE_DIR, userId, 'storageState.json');
}

/** 将上下文当前的 cookie/localStorage 主动落盘 */
export async function saveStorageState(context: BrowserContext, userId: string): Promise<void> {
  try {
    await context.storageState({ path: storageStatePath(userId) });
    logger.info('会话存储已落盘', { user: userId });
  } catch (e) {
    logger.warn('会话存储落盘失败', { user: userId, error: e });
  }
}

/**
 * 为用户创建/复用一个持久化的浏览器上下文。
 * profile 目录按用户隔离：data/browser-profile/<userId>
 */
export async function createContextForUser(opts: LaunchOptions): Promise<BrowserContext> {
  const profileDir = `${BROWSER_PROFILE_DIR}/${opts.userId}`;
  fs.mkdirSync(profileDir, { recursive: true });

  const headless = opts.headless ?? HEADLESS;
  if (headless) {
    logger.info('启动无头 Chromium（不占用本地浏览器）', { user: opts.userId });
  } else {
    ensureXvfb();
    logger.info('启动有头 Chromium（Linux 走 Xvfb 虚拟显示）', { user: opts.userId });
  }

  // 先启动一次拿到真实 Chromium 版本，避免 UA 与实际版本不匹配被 12306 风控拦截
  const browser = await chromium.launch();
  const chromeVersion = browser.version();
  await browser.close();
  const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=zh-CN',
    ],
    userAgent: ua,
  });

  // 恢复此前主动备份的登录态（persistent context 的 cookie 在进程被 kill 时可能未 flush）
  try {
    const statePath = storageStatePath(opts.userId);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        cookies?: Array<{ name: string; expires: number }>;
      };
      const now = Math.floor(Date.now() / 1000);
      // expires === -1 是会话级 cookie，照常恢复；过期的丢弃
      const cookies = (state.cookies ?? []).filter((c) => c.expires === -1 || c.expires > now);
      if (cookies.length) {
        await context.addCookies(cookies as never);
        logger.info('已从备份恢复登录态', { user: opts.userId, cookies: cookies.length });
      }
    }
  } catch (e) {
    logger.warn('恢复登录态备份失败', { user: opts.userId, error: e });
  }

  // 反自动化检测：移除 webdriver 标记
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

/** 关闭用户的浏览器上下文 */
export async function closeContext(context: BrowserContext | null): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch {
    // 忽略已关闭
  }
}

/** 进程退出时清理 Xvfb */
export function cleanupBrowser(): void {
  if (xvfbProc) {
    try {
      xvfbProc.kill();
    } catch {
      // ignore
    }
  }
}
