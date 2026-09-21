<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter, RouterView } from 'vue-router';
import { WsClient } from '../api';
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
  cancelLogin,
} from '../store/session';
import { ElMessage, ElNotification } from 'element-plus';

const router = useRouter();

const ws = ref<WsClient | null>(null);

const menuItems = [
  { index: '/dashboard', title: '车票日历' },
  { index: '/orders', title: '已购车票' },
  { index: '/plans', title: '购票计划' },
  { index: '/feishu', title: '飞书通知' },
  // 「任务与日志」已合并进购票计划详情，旧书签自动跳转过去
];

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
    onSession: handleSessionUpdate,
    onQrCode: handleQrCode,
  });
  ElMessage?.success?.('已连接实时通道');
});
</script>

<template>
  <el-container class="app-layout">
    <el-header class="app-header">
      <div class="logo">🚄 12306 自动购票管理台</div>
      <!-- 12306 账号状态与操作（单用户模式：无系统登录，只需扫码登录 12306） -->
      <div class="account-box">
        <el-tag :type="sessionState.loggedIn ? 'success' : 'danger'" effect="dark" size="small">
          12306 账号：{{ sessionState.loggedIn ? '已连接' : '未连接' }}
        </el-tag>
        <span v-if="sessionState.userName" class="account-name">{{ sessionState.userName }}</span>
        <el-button v-if="!sessionState.loggedIn" type="primary" size="small" :loading="sessionLoading" @click="startLogin">
          扫码登录
        </el-button>
        <template v-else>
          <el-button size="small" :loading="sessionLoading" @click="checkNow">检查</el-button>
          <el-button size="small" :loading="sessionSyncing" @click="syncPassengers">同步联系人</el-button>
          <el-button size="small" type="danger" @click="doLogout">退出</el-button>
        </template>
      </div>
    </el-header>
    <el-container>
      <el-aside class="app-aside" width="180px">
        <el-menu :default-active="$route.path" @select="(i: string) => router.push(i)">
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

  <!-- 扫码登录弹窗（后端通过 WS 推送二维码，任何页面都可弹出） -->
  <el-dialog v-model="qrVisible" title="扫码登录 12306" width="420px" :close-on-click-modal="false">
    <div style="text-align: center">
      <div style="margin-bottom: 12px; color: #e6a23c; font-weight: 600">{{ qrStatus }}</div>
      <img
        v-if="qrImage"
        :src="qrImage"
        alt="12306 登录二维码"
        style="width: 260px; height: 260px; border: 1px solid #ebeef5; border-radius: 8px"
      />
      <div v-else style="width: 260px; height: 260px; margin: 0 auto; line-height: 260px; color: #909399">
        二维码生成中…
      </div>
      <div style="margin-top: 8px; color: #909399; font-size: 12px">
        请打开 12306 APP → 首页右上角「+」→ 扫一扫，扫描二维码确认登录。
      </div>
    </div>
    <template #footer>
      <el-button @click="cancelLogin">取消登录</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.account-box {
  display: flex;
  align-items: center;
  gap: 10px;
}
.account-name {
  font-size: 13px;
  color: #c0c4cc;
}
</style>
