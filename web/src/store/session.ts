/**
 * 12306 会话共享状态与操作。
 *
 * 原来由独立的「12306 会话」页承载，现已融合进仪表盘；登录二维码弹窗由
 * LayoutView 渲染（WS 推送的二维码在任何页面都能弹出）。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { sessionApi } from '../api';

export const sessionState = ref<Record<string, unknown>>({});
export const sessionLoading = ref(false);
export const sessionSyncing = ref(false);

export const qrVisible = ref(false);
export const qrImage = ref('');
export const qrStatus = ref('请使用 12306 APP 扫码登录');

function errMsg(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } }).response?.data?.error;
}

export async function loadSessionState(): Promise<void> {
  try {
    sessionState.value = await sessionApi.state();
  } catch {
    // 后端未绑定 12306 等情况，忽略
  }
}

/** 发起扫码登录：接口立即返回，二维码由 WS 推送到 qrImage */
export async function startLogin(): Promise<void> {
  sessionLoading.value = true;
  qrStatus.value = '正在打开 12306 登录页…';
  qrImage.value = '';
  qrVisible.value = true;
  try {
    await sessionApi.login();
    ElMessage.info('正在生成二维码，请稍候');
  } catch (e) {
    ElMessage.error(errMsg(e) ?? '登录发起失败');
    sessionLoading.value = false;
    qrVisible.value = false;
  }
}

/** 取消扫码登录 */
export async function cancelLogin(): Promise<void> {
  await sessionApi.cancelLogin().catch(() => undefined);
  qrVisible.value = false;
  sessionLoading.value = false;
  ElMessage.info('已取消登录');
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

/** WS 推送二维码时调用 */
export function handleQrCode(m: { image?: string; status?: string }): void {
  if (m?.image) {
    qrImage.value = m.image;
    qrStatus.value = m.status ?? '请使用 12306 APP 扫码登录';
    qrVisible.value = true;
  }
}

/** 登录结果由 WS session 消息驱动：收到后刷新状态并解除 loading */
export function handleSessionUpdate(m: unknown): void {
  sessionState.value = m as Record<string, unknown>;
  if (sessionState.value.loggedIn) {
    sessionLoading.value = false;
    qrVisible.value = false;
    ElMessage.success('12306 登录成功，会话已保存并保活');
  } else if (sessionState.value.failReason) {
    sessionLoading.value = false;
    qrVisible.value = false;
    ElMessage.error(String(sessionState.value.failReason));
  }
}
