import { userCanRun } from '../db/repo.js';
/**
 * 12306 会话管理（需求 3）。
 *
 * - 不保存 12306 密码：采用「扫码登录」，全程不接触任何密码，也不需要手机号验证码。
 * - 二维码通过 WebSocket 实时推送给管理台，用户用 12306 APP 扫码确认。
 * - 登录成功后持久化浏览器会话（launchPersistentContext 的 user-data-dir 自动落盘），
 *   并由保活循环周期性验证；失活时通过通过通知通道提醒用户重新登录。
 */
import type { BrowserContext, Page } from 'playwright';
import { RailwayAccountRepo } from '../db/repo.js';
import { Logger } from '../logger.js';
import { wsHub } from '../ws/hub.js';
import { URLS, SELECTORS } from './constants.js';
import { loginNameFromApiText } from './login-name.js';
import { warmOrderPage } from './orderApi.js';
import { createContextForUser, closeContext, saveStorageState } from './browser.js';
import { notifySessionInvalid } from '../notify/feishu.js';
import { QrAttempt, runQrLogin, type QrSnapshot } from './qr-login.js';
import type { SessionState } from '../types.js';

const logger = new Logger('session');

/** userId → 活跃浏览器上下文 */
const contexts = new Map<string, BrowserContext>();
const openingContexts = new Map<string, Promise<BrowserContext>>();

const qrChallenges = new Map<string, QrAttempt>();
const finishedQrAttempts = new WeakSet<QrAttempt>();

export function getQrLogin(userId: string, attemptId: string): QrSnapshot | null {
  const attempt = qrChallenges.get(userId);
  return attempt?.snapshot.attemptId === attemptId ? attempt.snapshot : null;
}
export function refreshQrLogin(userId: string, attemptId: string): boolean {
  const attempt = qrChallenges.get(userId);
  return !!attempt && attempt.snapshot.attemptId === attemptId && attempt.refresh();
}
export function setQrAutoRefresh(userId: string, attemptId: string, enabled: boolean): boolean {
  const attempt = qrChallenges.get(userId);
  if (!attempt || attempt.snapshot.attemptId !== attemptId || attempt.cancelled) return false;
  attempt.update({ autoRefresh: enabled });
  return true;
}
/** An attempt ID prevents an old tab/request from cancelling a newer login. */
export function cancelQrLogin(userId: string, attemptId?: string): void {
  const attempt = qrChallenges.get(userId);
  if (attempt && (!attemptId || attempt.snapshot.attemptId === attemptId)) attempt.cancel();
}

/** 获取/创建用户的浏览器上下文 */
export async function getContext(userId: string): Promise<BrowserContext> {
  if (!userCanRun(userId)) throw new Error('账号已停用或当前启动模式不允许访问');
  const current = contexts.get(userId);
  if (current) return current;
  const opening = openingContexts.get(userId);
  if (opening) return opening;
  const promise = createContextForUser({ userId }).then(async ctx => {
    if (!userCanRun(userId)) { await closeContext(ctx); throw new Error('账号已停用'); }
    contexts.set(userId, ctx);
    ctx.on('close', () => { if (contexts.get(userId) === ctx) contexts.delete(userId); });
    return ctx;
  });
  openingContexts.set(userId, promise);
  try {
    return await promise;
  } finally {
    openingContexts.delete(userId);
  }
}

/** 服务重启时保存并关闭浏览器，不把已登录账户改成退出状态。 */
export async function shutdownSessions(): Promise<void> {
  stopKeepalive();
  for (const userId of qrChallenges.keys()) cancelQrLogin(userId);
  await Promise.allSettled(openingContexts.values());
  await Promise.allSettled([...contexts.entries()].map(async ([userId, ctx]) => {
    await saveStorageState(ctx, userId);
    await closeContext(ctx);
  }));
  contexts.clear();
}

/** 关闭用户会话 */
export async function closeSession(userId: string): Promise<void> {
  cancelQrLogin(userId);
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
    lastCheckAt: acc?.lastCheckAt ?? null,
    lastLoginAt: acc?.lastLoginAt ?? null,
    failReason: acc?.failReason ?? null,
  };
}

/** Starts synchronously: cancellation and refresh are available even while Chromium is opening. */
export function startQrLogin(userId: string, attemptId: string, autoRefresh = true): QrSnapshot {
  const current = qrChallenges.get(userId);
  if (current && !finishedQrAttempts.has(current)) {
    if (current.snapshot.attemptId === attemptId) return current.snapshot;
    throw new Error('上一次登录正在处理，请稍候重试');
  }
  if (!userCanRun(userId)) throw new Error('账号已停用或当前启动模式不允许访问');
  const attempt = new QrAttempt(attemptId, autoRefresh, snapshot => wsHub.broadcastToUser(userId, { type: 'qr_code', payload: snapshot }));
  qrChallenges.set(userId, attempt);
  void executeQrLogin(userId, attempt);
  return attempt.snapshot;
}

async function executeQrLogin(userId: string, attempt: QrAttempt): Promise<void> {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  const sendSession = () => wsHub.broadcastToUser(userId, { type: 'session', payload: { ...getSessionState(userId), loginAttemptId: attempt.snapshot.attemptId } });
  attempt.onCancel = () => { void page?.close().catch(() => undefined); };
  const openQrPage = async () => {
    if (!page || attempt.cancelled) return;
    await page.goto(URLS.LOGIN, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (attempt.cancelled) return;
    await page.locator(SELECTORS.qrLoginTab).click({ timeout: 10000 });
    await page.waitForFunction("document.querySelector('#J-qrImg')?.src.startsWith('data:')", undefined, { timeout: 15000 });
  };
  try {
    RailwayAccountRepo.upsert(userId, null);
    RailwayAccountRepo.updateStatus(userId, 'logging_in');
    sendSession();
    await runQrLogin(attempt, {
      open: async () => {
        context = await getContext(userId);
        if (attempt.cancelled) return;
        page = await context.newPage();
        if (!attempt.cancelled) await openQrPage();
      },
      read: async () => {
        if (!page || !context || attempt.cancelled) return { image: null, expired: false, scanned: false, loggedIn: false };
        const url = page.url();
        if (!url.includes('/login/') && !url.includes('login.html') && await checkLoggedIn(context)) return { image: null, expired: false, scanned: false, loggedIn: true };
        return {
          image: await readQrImage(page),
          scanned: await page.locator('#J-login-code-success').isVisible(),
          expired: await page.locator('#J-code-error').isVisible(),
          loggedIn: false,
        };
      },
      refresh: async manual => {
        if (!page || attempt.cancelled) return;
        // Re-check immediately before changing the page: the phone may just have scanned it.
        if (await page.locator('#J-login-code-success').isVisible()) return;
        if (!manual && await page.locator('#J-code-error a').isVisible()) {
          await page.locator('#J-code-error a').click({ timeout: 2500 });
        } else {
          // Reload also clears the official page's previous QR polling timer.
          await openQrPage();
        }
      },
      complete: async () => {
        const railwayUser = await readRailwayUserName(page!).catch(() => null);
        if (attempt.cancelled) return;
        await saveStorageState(context!, userId);
        if (attempt.cancelled) return;
        if (railwayUser) RailwayAccountRepo.upsert(userId, railwayUser);
        RailwayAccountRepo.updateStatus(userId, 'active');
        sendSession();
        logger.info('扫码登录成功，会话已保存并开始保活', { user: userId });
      },
    });
    if (attempt.cancelled) { RailwayAccountRepo.updateStatus(userId, 'logged_out'); sendSession(); }
  } catch (error) {
    if (!attempt.cancelled && attempt.snapshot.phase !== 'error') {
      attempt.update({ phase: 'error', image: null, status: error instanceof Error ? error.message : '二维码获取失败，请重试' });
    }
    RailwayAccountRepo.updateStatus(userId, 'invalid', attempt.snapshot.status);
    sendSession();
    logger.warn('扫码登录失败', { user: userId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await (page as Page | null)?.close().catch(() => undefined);
    finishedQrAttempts.add(attempt);
    // Keep terminal state briefly for polling clients that missed the WebSocket event.
    const timer = setTimeout(() => {
      if (qrChallenges.get(userId) === attempt) qrChallenges.delete(userId);
    }, 30_000);
    timer.unref();
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

/** 登录账号在 /otn/login/conf 的 user_name。页面必须先完成 UAM 并停在 kyfw 订单页，首页会跳到 www，跨域读不到。 */
export async function readRailwayUserName(page: Page): Promise<string | null> {
  try {
    if (!page.url().includes('/otn/queryOrder/init')) await warmOrderPage(page);
    const raw = await page.evaluate(async (url: string) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: '_json_att=',
      });
      return res.ok ? await res.text() : '';
    }, URLS.LOGIN_CONF);
    return loginNameFromApiText(raw);
  } catch {
    return null;
  }
}

const nameLookupFailed = new Set<string>();

/** 已连接但库里没有登录名时补一次，供顶栏显示。失败后本进程不再反复打开浏览器。 */
export async function rememberRailwayUserName(userId: string): Promise<void> {
  const acc = RailwayAccountRepo.get(userId);
  if (!acc || acc.status !== 'active' || acc.username || nameLookupFailed.has(userId)) return;
  const ctx = contexts.get(userId) ?? await getContext(userId);
  const page = await ctx.newPage();
  try {
    const name = await readRailwayUserName(page);
    if (name) RailwayAccountRepo.upsert(userId, name);
    else nameLookupFailed.add(userId);
  } finally {
    await page.close().catch(() => undefined);
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
      if (!userCanRun(user_id)) continue;
      const ctx = contexts.get(user_id);
      if (!ctx) continue;
      try {
        const ok = await checkLoggedIn(ctx);
        RailwayAccountRepo.touchCheck(user_id);
        if (ok) {
          // 检查通过说明登录态有效，顺手落盘保持新鲜
          await saveStorageState(ctx, user_id);
        } else {
          logger.warn('会话失活，通过通知通道提醒用户重新登录', { user: user_id });
          RailwayAccountRepo.updateStatus(user_id, 'invalid', '会话过期或被踢下线');
          wsHub.broadcastToUser(user_id, { type: 'session', payload: getSessionState(user_id) });
          await notifySessionInvalid(user_id, '会话过期或在其他设备登录，请重新扫码登录');
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
