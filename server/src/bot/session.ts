/**
 * 12306 会话管理（需求 3）。
 *
 * - 不保存 12306 密码：采用「扫码登录」，全程不接触任何密码，也不需要手机号验证码。
 * - 二维码通过 WebSocket 实时推送给管理台，用户用 12306 APP 扫码确认。
 * - 登录成功后持久化浏览器会话（launchPersistentContext 的 user-data-dir 自动落盘），
 *   并由保活循环周期性验证；失活时通过飞书通知用户重新登录。
 */
import type { BrowserContext, Page } from 'playwright';
import { RailwayAccountRepo } from '../db/repo.js';
import { Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import { URLS, SELECTORS } from './constants.js';
import { createContextForUser, closeContext, saveStorageState } from './browser.js';
import { notifySessionInvalid } from '../notify/feishu.js';
import type { SessionState } from '../types.js';

const logger = new Logger('session');

/** userId → 活跃浏览器上下文 */
const contexts = new Map<string, BrowserContext>();

/** 二维码登录交互通道：userId → 取消函数（用户在管理台点"取消"时调用） */
interface QrChallenge {
  cancel: () => void;
}
const qrChallenges = new Map<string, QrChallenge>();

/** 通过 WS 把二维码推送给管理台 */
function pushQrToUser(userId: string, image: string, status: string): void {
  wsHub.broadcastToUser(userId, { type: 'qr_code', payload: { image, status } });
}

/** 用户在管理台取消扫码登录 */
export function cancelQrLogin(userId: string): void {
  const challenge = qrChallenges.get(userId);
  if (challenge) {
    qrChallenges.delete(userId);
    challenge.cancel();
  }
}

/** 获取/创建用户的浏览器上下文 */
export async function getContext(userId: string): Promise<BrowserContext> {
  let ctx = contexts.get(userId);
  if (ctx) return ctx;
  ctx = await createContextForUser({ userId });
  contexts.set(userId, ctx);
  return ctx;
}

/** 关闭用户会话 */
export async function closeSession(userId: string): Promise<void> {
  const ctx = contexts.get(userId);
  if (ctx) {
    await closeContext(ctx);
    contexts.delete(userId);
  }
  RailwayAccountRepo.updateStatus(userId, 'logged_out');
  wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });
}

/**
 * 检查是否已登录：POST checkUser 接口，解析 data.flag。
 *
 * 注意：checkUser 无论登录与否都返回 HTTP 200，区别在 data.flag（true=已登录）。
 * 旧实现用 GET 导航且只看 res.ok()，未登录时也会误判为已登录，导致保活形同虚设。
 */
export async function checkLoggedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    // 先做 UAM 预热：访问确认页触发 uamtk + uamauthclient 单点登录链。
    // 12306 的 checkUser 依赖 UAM 会话，不做预热会误报 flag:false（会话实际仍有效）。
    await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1500).catch(() => undefined);
    const raw = await page.evaluate(async (u: string) => {
      try {
        const res = await fetch(u, { method: 'POST', credentials: 'include' });
        return { ok: res.ok, status: res.status, body: await res.text() };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    }, URLS.CHECK_USER);
    if (!raw.ok) return false;
    const data = JSON.parse(raw.body) as { data?: { flag?: boolean }; messages?: string[] };
    return data?.data?.flag === true;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 会话状态快照 */
export function getSessionState(userId: string): SessionState {
  const acc = RailwayAccountRepo.get(userId);
  return {
    userId,
    status: acc?.status ?? 'none',
    loggedIn: acc?.status === 'active',
    userName: acc?.username ?? null,
    lastCheckAt: acc?.lastLoginAt ?? null,
    lastLoginAt: acc?.lastLoginAt ?? null,
    failReason: acc?.failReason ?? null,
  };
}

/** 正在登录中的用户（并发锁，防止重复发起） */
const loggingInUsers = new Set<string>();

/**
 * 交互式登录 12306（扫码登录，全程不保存密码、不需要手机号）。
 *
 * 流程：
 *   1. 打开 12306 登录页，切换到「扫码登录」页签；
 *   2. 读取二维码图片（data URI），通过 WebSocket 实时推送到管理台；
 *   3. 轮询登录状态，用户用 12306 APP 扫码确认后页面跳转，即登录成功；
 *   4. 二维码失效时自动点击「刷新」并重新推送；用户可在管理台取消。
 *
 * @param userId 系统用户 ID
 */
export async function loginInteractive(userId: string): Promise<SessionState> {
  if (loggingInUsers.has(userId)) {
    throw new Error('登录正在进行中，请稍候或在弹窗中扫码');
  }
  loggingInUsers.add(userId);
  RailwayAccountRepo.upsert(userId, null);
  RailwayAccountRepo.updateStatus(userId, 'logging_in');
  wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });

  const context = await getContext(userId);
  const page = await context.newPage();
  let cancelled = false;
  let lastQr = '';
  try {
    logger.info('开始扫码登录（不保存密码）');
    await page.goto(URLS.LOGIN, { waitUntil: 'domcontentloaded', timeout: 40000 });
    logger.info('登录页已打开', { url: page.url() });

    // 等页面 JS 渲染完登录表单
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    logger.info('登录页已就绪', { url: page.url() });

    // 切换到「扫码登录」页签
    await page.click(SELECTORS.qrLoginTab).catch(() => undefined);
    await page.waitForTimeout(1000);
    logger.info('已切换到扫码登录页签', { url: page.url() });

    // 注册取消通道
    qrChallenges.set(userId, {
      cancel: () => {
        cancelled = true;
      },
    });

    // 先等二维码元素出现（最多 20 秒），再进入轮询
    await page.waitForSelector(SELECTORS.qrImage, { timeout: 20000 }).catch(() => undefined);

    // 轮询：推二维码 + 检测登录成功/取消，最多 5 分钟
    const deadline = Date.now() + 5 * 60 * 1000;
    let pushedAt = 0;
    while (Date.now() < deadline && !cancelled) {
      // 读取二维码 data URI（页面里是 <img id="J-qrImg" src="data:image/jpg;base64,...">）
      const qr = await readQrImage(page);
      if (qr && qr !== lastQr) {
        lastQr = qr;
        pushedAt = Date.now();
        pushQrToUser(userId, qr, '请使用 12306 APP 扫码登录');
        logger.info('已推送登录二维码到管理台');
      }

      // 二维码约 1 分钟过期：超过 90 秒未更新则点「刷新」重新生成
      if (qr && Date.now() - pushedAt > 90_000) {
        await page.click(SELECTORS.qrRefresh).catch(() => undefined);
        await page.waitForTimeout(800);
        const fresh = await readQrImage(page);
        if (fresh && fresh !== lastQr) {
          lastQr = fresh;
          pushedAt = Date.now();
          pushQrToUser(userId, fresh, '二维码已刷新，请使用 12306 APP 扫码登录');
        }
      }

      // 检测登录成功：扫码确认后页面会跳转离开登录页
      const url = page.url();
      if (!url.includes('/login/') && !url.includes('login.html')) {
        const ok = await checkLoggedIn(context);
        if (ok) {
          // 读取 12306 登录用户名（仅展示用，不保存密码）
          const railwayUser = await readRailwayUserName(page).catch(() => null);
          if (railwayUser) RailwayAccountRepo.upsert(userId, railwayUser);
          RailwayAccountRepo.updateStatus(userId, 'active');
          // 主动落盘登录态，进程重启后可恢复
          await saveStorageState(context, userId);
          logger.info('扫码登录成功，会话已保存并开始保活', railwayUser ? { railwayUser } : undefined);
          wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });
          return getSessionState(userId);
        }
      }
      await page.waitForTimeout(1500);
    }

    if (cancelled) {
      RailwayAccountRepo.updateStatus(userId, 'invalid', '用户已取消登录');
      wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });
      throw new Error('用户已取消登录');
    }
    RailwayAccountRepo.updateStatus(userId, 'invalid', '扫码登录超时，请重试');
    wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });
    throw new Error('扫码登录超时，请重试');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    RailwayAccountRepo.updateStatus(userId, 'invalid', msg);
    logger.error('登录异常', e);
    wsHub.broadcastToUser(userId, { type: 'session', payload: getSessionState(userId) });
    throw e;
  } finally {
    qrChallenges.delete(userId);
    await page.close().catch(() => undefined);
    loggingInUsers.delete(userId);
  }
}

/** 读取登录页二维码图片的 data URI */
async function readQrImage(page: Page): Promise<string | null> {
  try {
    return await page.$eval(SELECTORS.qrImage, (img) => {
      const src = (img as { src?: string }).src;
      return src && src.startsWith('data:') ? src : null;
    });
  } catch {
    return null;
  }
}

/** 登录成功后读取 12306 用户名（从首页或个人中心，仅展示用） */
async function readRailwayUserName(page: Page): Promise<string | null> {
  try {
    await page.goto(URLS.INDEX, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
    const name = await page
      .$eval('.welcome .username, .u_username, .user-name, [class*="userName"]', (el) => {
        const t = (el.textContent ?? '').trim();
        return t || null;
      })
      .catch(() => null);
    return name && name.length <= 40 ? name : null;
  } catch {
    return null;
  }
}

/** 尝试滑块验证（阿里 NoCaptcha）：模拟人类拖动 */
async function trySlider(page: Page): Promise<void> {
  const slider = await page.$(SELECTORS.slider).catch(() => null);
  if (!slider) return;
  const box = await slider.boundingBox();
  if (!box) return;
  logger.info('检测到滑块验证，模拟拖动');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // 分段拖动更像人类
  const steps = [0.3, 0.55, 0.75, 0.9, 1];
  for (const ratio of steps) {
    await page.mouse.move(box.x + box.width / 2 + 260 * ratio, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(120);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/** 保活检查器：周期性验证会话，失活时飞书告警（提醒用户重新登录） */
let keepaliveTimer: NodeJS.Timeout | null = null;

export function startKeepalive(intervalMs = 10 * 60 * 1000): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(async () => {
    // 遍历所有"活跃"账号检查（登录态保存在浏览器会话中，不保存密码）
    const { getDb } = await import('../db/index.js');
    const rows = getDb().prepare("SELECT user_id FROM railway_accounts WHERE status = 'active'").all() as Array<{ user_id: string }>;
    for (const { user_id } of rows) {
      const ctx = contexts.get(user_id);
      if (!ctx) continue;
      try {
        const ok = await checkLoggedIn(ctx);
        RailwayAccountRepo.touchCheck(user_id);
        if (ok) {
          // 检查通过说明登录态有效，顺手落盘保持新鲜
          await saveStorageState(ctx, user_id);
        } else {
          logger.warn('会话失活，飞书通知用户重新登录', { user: user_id });
          RailwayAccountRepo.updateStatus(user_id, 'invalid', '会话过期或被踢下线');
          wsHub.broadcastToUser(user_id, { type: 'session', payload: getSessionState(user_id) });
          await notifySessionInvalid(user_id, '会话过期或在其他设备登录，请重新输入账号密码登录');
        }
      } catch (e) {
        logger.warn('保活检查失败', { user: user_id, error: e });
      }
    }
  }, intervalMs);
  logger.info('会话保活已启动', { intervalMin: intervalMs / 60000 });
}

export function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}
