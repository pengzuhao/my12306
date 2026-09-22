/**
 * 12306 会话共享状态与操作。
 *
 * 原来由独立的「12306 会话」页承载，现已融合进仪表盘；登录二维码弹窗由
 * LayoutView 渲染（WS 推送的二维码在任何页面都能弹出）。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { sessionApi, type QrSnapshot } from '../api';

export const sessionState = ref<Record<string, unknown>>({});
export const sessionLoading = ref(false);
export const sessionSyncing = ref(false);

export const qrVisible = ref(false);
export const qrImage = ref('');
export const qrStatus = ref('请使用 12306 APP 扫码登录');
export const qrPhase = ref<QrSnapshot['phase']>('loading');
export const qrAutoRefresh = ref(true);
export const qrOptionsBusy = ref(false);
const qrRequestBusy = ref(false);
export const qrRefreshBusy = computed(() => qrRequestBusy.value || ['loading', 'refreshing'].includes(qrPhase.value));
let attemptId: string | null = null;
let revision = -1;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let starting: Promise<QrSnapshot> | null = null;
function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function errMsg(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } }).response?.data?.error;
}
export async function loadSessionState(): Promise<void> {
  try { sessionState.value = await sessionApi.state(); } catch { /* retain last state during reconnect */ }
}
function setQrError(message: string) {
  qrPhase.value = 'error'; qrImage.value = ''; qrStatus.value = message; sessionLoading.value = false; stopPolling();
}
function pollQr(id: string) {
  stopPolling();
  if (id !== attemptId || !qrVisible.value || ['error', 'success', 'cancelled'].includes(qrPhase.value)) return;
  pollTimer = setTimeout(async () => {
    try { handleQrCode(await sessionApi.qr(id)); }
    catch (error) {
      if (id !== attemptId || !qrVisible.value) return;
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 404) setQrError('登录已结束，请刷新二维码重新开始');
      else qrStatus.value = '连接暂时中断，正在重新获取二维码状态…';
    }
    pollQr(id);
  }, 2000);
}
/** IDs plus revisions reject late HTTP/WS responses from a cancelled or older attempt. */
export async function startLogin(): Promise<void> {
  if (qrVisible.value && !['error', 'cancelled'].includes(qrPhase.value)) return;
  const id = globalThis.crypto?.randomUUID?.() ?? `qr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  attemptId = id; revision = -1; stopPolling();
  sessionLoading.value = true; qrPhase.value = 'loading'; qrImage.value = '';
  qrStatus.value = '正在打开 12306 登录页…'; qrVisible.value = true;
  qrRequestBusy.value = false; qrOptionsBusy.value = false;
  const request = sessionApi.login(id, qrAutoRefresh.value);
  starting = request;
  try { handleQrCode(await request); if (id === attemptId && qrVisible.value) pollQr(id); }
  catch (error) { if (id === attemptId && qrVisible.value) setQrError(errMsg(error) ?? '登录发起失败，请刷新二维码重试'); }
  finally { if (starting === request) starting = null; }
}
export async function refreshQr(): Promise<void> {
  if (!qrVisible.value || qrRefreshBusy.value || qrPhase.value === 'scanned') return;
  if (qrPhase.value === 'error') { await startLogin(); return; }
  const id = attemptId;
  if (!id) return;
  qrRequestBusy.value = true;
  try { handleQrCode(await sessionApi.refreshQr(id)); }
  catch (error) { if (id === attemptId && qrVisible.value) ElMessage.warning(errMsg(error) ?? '刷新请求失败，请重试'); }
  finally { if (id === attemptId) qrRequestBusy.value = false; }
}
export async function changeQrAutoRefresh(value: string | number | boolean): Promise<void> {
  const enabled = Boolean(value), id = attemptId;
  if (!id || qrOptionsBusy.value) return;
  if (qrPhase.value === 'error') { qrAutoRefresh.value = enabled; return; }
  qrOptionsBusy.value = true;
  try { handleQrCode(await sessionApi.qrOptions(id, enabled)); }
  catch (error) { if (id === attemptId && qrVisible.value) ElMessage.warning(errMsg(error) ?? '设置失败，请重试'); }
  finally { if (id === attemptId) qrOptionsBusy.value = false; }
}
/** Hide immediately. If start is still in flight, cancel again after it is registered server-side. */
export async function cancelLogin(): Promise<void> {
  const id = attemptId, pending = starting;
  attemptId = null; qrVisible.value = false; qrImage.value = ''; qrPhase.value = 'cancelled';
  sessionLoading.value = false; qrRequestBusy.value = false; qrOptionsBusy.value = false; stopPolling();
  if (!id) return;
  await pending?.catch(() => undefined);
  await sessionApi.cancelLogin(id).catch(() => undefined);
}

/** 立即检查会话是否仍然有效 */
export async function checkNow(): Promise<void> {
  sessionLoading.value = true;
  try {
    const res = await sessionApi.check();
    sessionState.value = res.state;
    ElMessage.info(res.loggedIn ? '会话有效' : '会话已失活，请重新登录');
  } catch {
    ElMessage.error('检查失败');
  } finally {
    sessionLoading.value = false;
  }
}

/** 同步 12306 常用联系人到本地 */
export async function syncPassengers(): Promise<void> {
  sessionSyncing.value = true;
  try {
    const res = await sessionApi.syncPassengers();
    ElMessage.success(`已同步 ${res.synced} 位常用联系人`);
  } catch (e) {
    ElMessage.error(errMsg(e) ?? '同步失败');
  } finally {
    sessionSyncing.value = false;
  }
}

/** 退出 12306 登录（不影响本系统登录） */
export async function doLogout(): Promise<void> {
  await sessionApi.logout();
  await loadSessionState();
  ElMessage.info('已退出 12306 登录');
}

/** Polling backs up WebSocket delivery; images never reopen a dismissed dialog. */
export function handleQrCode(snapshot: QrSnapshot): void {
  if (!qrVisible.value || snapshot.attemptId !== attemptId || snapshot.revision < revision) return;
  revision = snapshot.revision;
  qrImage.value = snapshot.image ?? ''; qrStatus.value = snapshot.status;
  qrPhase.value = snapshot.phase; qrAutoRefresh.value = snapshot.autoRefresh;
  if (['error', 'cancelled', 'success'].includes(snapshot.phase)) { sessionLoading.value = false; stopPolling(); }
  if (snapshot.phase === 'success') { qrVisible.value = false; attemptId = null; void loadSessionState(); }
}
export function handleSessionUpdate(m: unknown): void {
  const state = m as Record<string, unknown>;
  if (state.loginAttemptId && state.loginAttemptId !== attemptId && !state.loggedIn) return;
  sessionState.value = state;
  if (state.loggedIn) {
    const wasLoggingIn = qrVisible.value;
    sessionLoading.value = false; qrVisible.value = false; qrImage.value = ''; attemptId = null; stopPolling();
    if (wasLoggingIn) ElMessage.success('12306 登录成功，会话已保存并保活');
  } else if (state.failReason && qrVisible.value && state.loginAttemptId === attemptId) {
    setQrError(String(state.failReason));
  }
}
