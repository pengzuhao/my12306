/** Login attempt state, independent of browser/HTTP so refresh races can be tested offline. */
export type QrPhase = 'loading' | 'ready' | 'scanned' | 'expired' | 'refreshing' | 'error' | 'cancelled' | 'success';
export interface QrSnapshot {
  attemptId: string; phase: QrPhase; image: string | null; status: string;
  autoRefresh: boolean; revision: number;
}
export class QrAttempt {
  snapshot: QrSnapshot;
  cancelled = false;
  refreshRequested = false;
  onCancel: () => void = () => {};
  constructor(id: string, autoRefresh: boolean, private publish: (snapshot: QrSnapshot) => void) {
    this.snapshot = { attemptId: id, phase: 'loading', image: null, status: '正在生成登录二维码…', autoRefresh, revision: 0 };
  }
  update(patch: Partial<QrSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 };
    this.publish(this.snapshot);
  }
  refresh(): boolean {
    if (this.cancelled || this.refreshRequested || !['ready', 'expired'].includes(this.snapshot.phase)) return false;
    this.refreshRequested = true;
    this.update({ phase: 'refreshing', status: '正在刷新二维码…', image: null });
    return true;
  }
  cancel(): void {
    if (this.cancelled || ['success', 'error'].includes(this.snapshot.phase)) return;
    this.cancelled = true;
    this.update({ phase: 'cancelled', image: null, status: '已取消登录' });
    this.onCancel();
  }
}
export interface QrDriver {
  open(): Promise<void>;
  read(): Promise<{ image: string | null; expired: boolean; scanned: boolean; loggedIn: boolean }>;
  refresh(manual: boolean): Promise<void>;
  complete(): Promise<void>;
}
export async function runQrLogin(attempt: QrAttempt, driver: QrDriver, options: {
  now?: () => number; sleep?: (ms: number) => Promise<void>; durationMs?: number; pollMs?: number; staleMs?: number;
} = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.durationMs ?? 5 * 60_000);
  let lastImage = '', issuedAt = now(), refreshingAt: number | null = null;
  try {
    await driver.open();
    issuedAt = now();
    while (!attempt.cancelled && now() < deadline) {
      const state = await driver.read();
      if (attempt.cancelled) return;
      if (state.loggedIn) {
        await driver.complete();
        if (!attempt.cancelled) attempt.update({ phase: 'success', image: null, status: '登录成功' });
        return;
      }
      // Never replace a code after the phone has scanned it, including a queued manual refresh.
      if (state.scanned) {
        attempt.refreshRequested = false;
        refreshingAt = null;
        attempt.update({ phase: 'scanned', image: null, status: '扫码成功，请在 12306 APP 上确认登录' });
      } else {
        if (state.image && state.image !== lastImage && !state.expired) {
          lastImage = state.image; issuedAt = now(); refreshingAt = null;
          attempt.update({ image: state.image, phase: 'ready', status: '请使用 12306 APP 扫码登录' });
        }
        const expired = state.expired || (!!lastImage && now() - issuedAt >= (options.staleMs ?? 90_000));
        if (refreshingAt !== null && now() - refreshingAt >= 20_000) throw new Error('未能获取新的二维码，请点击「刷新二维码」重试');
        if (!lastImage && now() - issuedAt >= 20_000) throw new Error('二维码生成失败，请点击「刷新二维码」重试');
        if (expired && refreshingAt === null && !attempt.refreshRequested) attempt.update({ phase: 'expired', image: null, status: '二维码已过期' });
        if (refreshingAt === null && (attempt.refreshRequested || (expired && attempt.snapshot.autoRefresh))) {
          const manual = attempt.refreshRequested;
          attempt.refreshRequested = false;
          refreshingAt = now();
          attempt.update({ phase: 'refreshing', image: null, status: manual ? '正在刷新二维码…' : '二维码已过期，正在自动刷新…' });
          await driver.refresh(manual);
          if (attempt.cancelled) return;
        }
      }
      await sleep(options.pollMs ?? 1000);
    }
    if (!attempt.cancelled) throw new Error('本次扫码登录已超时，请点击「刷新二维码」重新开始');
  } catch (error) {
    if (attempt.cancelled) return;
    attempt.update({ phase: 'error', image: null, status: error instanceof Error ? error.message : '二维码获取失败，请重试' });
    throw error;
  }
}
