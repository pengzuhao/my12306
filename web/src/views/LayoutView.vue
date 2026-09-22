<script setup lang="ts">
import DesktopSettings from '../components/DesktopSettings.vue';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter, RouterView } from 'vue-router';
import { WsClient, http, apiError } from '../api';
import { multiUser, appUser, logoutApp, clearAppLogin } from '../store/auth';
import {
  sessionState,
  sessionLoading,
  sessionSyncing,
  loadSessionState,
  startLogin,
  checkNow,
  syncPassengers,
  doLogout,
  handleQrCode,
  handleSessionUpdate,
  qrVisible,
  qrImage,
  qrStatus,
  qrPhase,
  qrRefreshBusy,
  qrAutoRefresh,
  qrOptionsBusy,
  refreshQr,
  changeQrAutoRefresh,
  cancelLogin,
} from '../store/session';
import { ElMessage, ElNotification } from 'element-plus';

const router = useRouter();
function navigate(path: string): void { void router.push(path).catch(() => undefined); }

const ws = ref<WsClient | null>(null);
const realtimeConnected = ref(false);

const menuItems = computed(() => [
  { index: '/dashboard', title: '车票日历' },
  { index: '/orders', title: '已购车票' },
  { index: '/trains', title: '车次查询' },
  { index: '/plans', title: '购票计划' },
  { index: '/notifications', title: '通知通道' },
  { index: '/logs', title: '过程日志' },
  ...(multiUser.value && appUser.value?.role === 'admin' ? [{ index: '/admin', title: '用户管理' }] : []),
  // 「任务与日志」已合并进购票计划详情，旧书签自动跳转过去
]);
const passwordVisible = ref(false), oldPassword = ref(''), newPassword = ref(''), passwordBusy = ref(false);
async function changePassword() {
  passwordBusy.value = true;
  try { await http.post('/auth/password', { oldPassword: oldPassword.value, password: newPassword.value }); ElMessage.success('密码已更新，请重新登录'); clearAppLogin(); }
  catch(e) { ElMessage.error(apiError(e)); } finally { passwordBusy.value = false; }
}
function accountCommand(command: string) {
  if (command === 'check') void checkNow();
  if (command === 'sync') void syncPassengers();
  if (command === 'logout') void doLogout();
}
function appCommand(command: string) {
  if (command === 'logout') void logoutApp().catch(e => ElMessage.error(apiError(e)));
  if (command === 'password') { oldPassword.value = ''; newPassword.value = ''; passwordVisible.value = true; }
}

async function loadSession(): Promise<void> {
  await loadSessionState();
  // 无活跃 12306 会话时，引导用户登录（本次浏览器会话只提示一次）
  if (!sessionState.value.loggedIn && !sessionStorage.getItem('my12306_guide_dismissed')) {
    guideLogin12306();
  }
}

/**
 * 引导用户登录 12306：用右上角通知而不是模态弹窗——
 * 模态遮罩会拦截整页点击，导致菜单和其他按钮看起来"没响应"。
 * 通知不阻塞操作，点击它直接弹出扫码二维码。
 */
function guideLogin12306(): void {
  sessionStorage.setItem('my12306_guide_dismissed', '1');
  ElNotification({
    title: '需要登录 12306',
    message: '当前没有活跃的 12306 会话，自动购票需要先登录。点击本通知扫码登录（全程不保存密码）。',
    type: 'warning',
    duration: 8000,
    position: 'top-right',
    onClick: () => startLogin(),
  });
}

onMounted(async () => {
  await loadSession();
  ws.value = new WsClient();
  ws.value.connect({
    onConnection: (connected) => { realtimeConnected.value = connected; if (connected) void loadSessionState(); },
    onSession: handleSessionUpdate,
    onQrCode: handleQrCode,
  });
});
onBeforeUnmount(() => { ws.value?.close(); if (qrVisible.value) void cancelLogin(); });
</script>

<template>
  <el-container class="app-layout">
    <el-header class="app-header">
      <div class="brand"><span class="brand-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path d="M4 11h16M8 7h8M8 19l-2 3m10-3 2 3"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/></svg></span><span class="brand-name">my12306<small>让每次出发，都有安排</small></span></div>
      <div class="account-box">
        <DesktopSettings />
        <el-tooltip :content="realtimeConnected ? '实时消息通道已连接' : '实时消息通道重连中'" placement="bottom"><span class="connection-indicator" role="status" :aria-label="realtimeConnected ? '实时通道已连接' : '实时通道连接中'" :class="{ online: realtimeConnected }"><i></i><span>{{ realtimeConnected ? '实时在线' : '连接中' }}</span></span></el-tooltip>
        <span class="header-divider"></span>
        <el-button v-if="!sessionState.loggedIn" class="connect-button" type="primary" round :loading="sessionLoading" @click="startLogin">连接 12306</el-button>
        <el-dropdown v-else trigger="click" @command="accountCommand">
          <button class="account-trigger" :disabled="sessionLoading || sessionSyncing" aria-label="12306 账号操作"><span class="avatar">{{ String(sessionState.userName || '旅').slice(0, 1) }}</span><span class="account-label"><strong>{{ sessionState.userName || '12306 账号' }}</strong><small><i></i>{{ sessionLoading ? '正在检查…' : sessionSyncing ? '正在同步…' : '12306 已连接' }}</small></span><svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="check">检查 12306 连接</el-dropdown-item><el-dropdown-item command="sync">同步乘车人</el-dropdown-item><el-dropdown-item command="logout" divided class="danger-menu">断开 12306 账号</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <el-dropdown v-if="multiUser" trigger="click" @command="appCommand"><button class="app-account-trigger" aria-label="管理台账号操作">{{ appUser?.displayName }} <span>⌄</span></button><template #dropdown><el-dropdown-menu><el-dropdown-item disabled>{{ appUser?.role === 'admin' ? '管理员' : '用户' }} · {{ appUser?.username }}</el-dropdown-item><el-dropdown-item command="password">修改管理台密码</el-dropdown-item><el-dropdown-item command="logout" divided>退出管理台</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
      </div>
    </el-header>
    <el-container>
      <el-aside class="app-aside" width="180px">
        <el-menu :default-active="$route.path" @select="navigate">
          <el-menu-item v-for="item in menuItems" :key="item.index" :index="item.index">
            {{ item.title }}
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-main class="app-main">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="passwordVisible" title="修改管理台密码" width="420px" :close-on-click-modal="false"><el-form label-position="top"><el-form-item label="原密码"><el-input v-model="oldPassword" type="password" show-password autocomplete="current-password" /></el-form-item><el-form-item label="新密码"><el-input v-model="newPassword" type="password" show-password autocomplete="new-password" placeholder="至少 12 字符，最多 72 字节" /></el-form-item></el-form><template #footer><el-button @click="passwordVisible = false">取消</el-button><el-button type="primary" :loading="passwordBusy" @click="changePassword">更新密码</el-button></template></el-dialog>
  <!-- 扫码登录弹窗（后端通过 WS 推送二维码，任何页面都可弹出） -->
  <el-dialog v-model="qrVisible" title="扫码登录 12306" width="420px" :close-on-click-modal="false" :before-close="() => { void cancelLogin(); }">
    <div style="text-align: center">
      <div style="margin-bottom: 12px; color: #e6a23c; font-weight: 600">{{ qrStatus }}</div>
      <img
        v-if="qrImage"
        :src="qrImage"
        alt="12306 登录二维码"
        style="width: 260px; max-width: 100%; height: 260px; border: 1px solid #ebeef5; border-radius: 8px"
      />
      <div v-else style="width: 260px; max-width: 100%; height: 260px; margin: 0 auto; line-height: 260px; color: #909399">
        {{ qrPhase === 'error' || qrPhase === 'expired' ? '请刷新二维码' : qrPhase === 'scanned' ? '请在手机上确认' : '二维码生成中…' }}
      </div>
      <div style="margin-top: 8px; color: #909399; font-size: 12px">
        请打开 12306 APP → 首页右上角「+」→ 扫一扫，扫描二维码确认登录。
      </div>
    </div>
    <div class="qr-refresh-options"><el-switch :model-value="qrAutoRefresh" :disabled="qrOptionsBusy" :loading="qrOptionsBusy" aria-label="二维码过期自动刷新" @change="changeQrAutoRefresh" /><span>过期自动刷新</span><small>扫码后暂停刷新，本次登录最多等待 5 分钟</small></div>
    <template #footer>
      <el-button @click="cancelLogin">取消登录</el-button>
      <el-button type="primary" :loading="qrRefreshBusy" :disabled="qrPhase === 'scanned'" @click="refreshQr">刷新二维码</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.qr-refresh-options { display: flex; justify-content: center; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; color: #606266; font-size: 13px; }
.qr-refresh-options small { flex-basis: 100%; text-align: center; color: #909399; font-size: 12px; }
.brand { display: flex; align-items: center; gap: 11px; flex-shrink: 0; }.brand-mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px; background: #e6efff; color: #3264b2; }.brand-mark svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }.brand-name { color: #19324f; font-size: 19px; font-weight: 700; letter-spacing: -.4px; }.brand-name small { display: block; color: #8b98a9; font-size: 10px; font-weight: 400; letter-spacing: 1px; margin-top: 3px; }.account-box { display: flex; align-items: center; gap: 18px; }.connection-indicator { display: inline-flex; align-items: center; gap: 7px; color: #a78143; font-size: 12px; }.connection-indicator i,.account-label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }.connection-indicator.online { color: #7e8c9b; }.connection-indicator.online i { background: #49a58e; box-shadow: 0 0 0 3px #49a58e10; }.header-divider{ height: 24px; width: 1px; background: #e9edf3; }.account-trigger { display: flex; align-items: center; gap: 10px; padding: 5px 8px 5px 5px; border: 1px solid transparent; border-radius: 12px; background: transparent; cursor: pointer; text-align: left; font: inherit; color: #354a64; transition: background .15s; }.account-trigger:hover,.account-trigger:focus-visible { background: #f2f6fc; border-color: #e3eaf4; outline: none; }.account-trigger:disabled{ opacity: .65; cursor: wait; }.avatar{ width: 34px; height: 34px; border-radius: 50%; background: #eaf1f9; color: #47719f; display: grid; place-items: center; font-size: 14px; }.account-label strong{ display: block; font-size: 13px; font-weight: 600; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.account-label small { display: block; font-size: 10px; color: #7f8e9e; margin-top: 4px; }.account-label i { color: #48a286; width: 5px; height: 5px; margin-right: 3px; }.chevron { width: 16px; height: 16px; fill: none; stroke: #8b99aa; stroke-width: 1.5; }.connect-button { padding: 10px 18px; height: 36px; }.app-account-trigger{ border: 0; background: #f1f4f9; padding: 8px 12px; border-radius: 8px; color: #54667c; cursor: pointer; }.danger-menu{ color: #c55e5e; }
@media(max-width:760px){.account-box{ gap: 10px; }.connection-indicator span,.header-divider{ display: none; }.brand-name small{ display: none; }.brand-name{ font-size: 17px; }.brand-mark{ width: 30px; height: 30px; }.account-label strong{ max-width: 80px; }.account-label small{ font-size: 9px; }.avatar{ display: none; }}
</style>
