<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRouter, RouterView } from 'vue-router';
import { useAuthStore } from '../store/auth';
import { sessionApi, taskApi, WsClient } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';

const router = useRouter();
const auth = useAuthStore();

const sessionState = ref<Record<string, unknown>>({ loggedIn: false });
const taskCount = ref(0);
const ws = ref<WsClient | null>(null);

const menuItems = computed(() => [
  { index: '/dashboard', title: '仪表盘' },
  { index: '/orders', title: '已购车票' },
  { index: '/plans', title: '购票计划' },
  { index: '/session', title: '12306 会话' },
  { index: '/feishu', title: '飞书通知' },
  { index: '/tasks', title: '任务与日志' },
  ...(auth.user?.role === 'admin' ? [{ index: '/users', title: '用户管理' }] : []),
]);

async function loadSession(): Promise<void> {
  try {
    sessionState.value = await sessionApi.state();
    // 无活跃 12306 会话时，引导用户登录（本次浏览器会话只提示一次，点过"稍后"就不再打扰）
    if (!sessionState.value.loggedIn && !sessionStorage.getItem('my12306_guide_dismissed')) {
      void guideLogin12306();
    }
  } catch {
    // 未绑定时忽略
  }
}

/** 引导用户登录 12306（扫码登录，不保存密码） */
async function guideLogin12306(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '当前没有活跃的 12306 会话，自动购票需要先登录 12306。\n是否现在登录？（只需 12306 APP 扫码，全程不保存密码）',
      '登录 12306',
      { confirmButtonText: '去登录', cancelButtonText: '稍后', type: 'warning' },
    );
    router.push('/session');
  } catch {
    // 用户选择稍后：本次浏览器会话不再提示
    sessionStorage.setItem('my12306_guide_dismissed', '1');
  }
}

async function loadTasks(): Promise<void> {
  try {
    const list = await taskApi.list();
    taskCount.value = (list as Array<{ status: string }>).filter(
      (t) => t.status === 'queried' || t.status === 'running' || t.status === 'pending',
    ).length;
  } catch {
    // ignore
  }
}

function logout(): void {
  auth.logout();
  ws.value?.close();
  router.push({ name: 'login' });
}

onMounted(async () => {
  await auth.loadMe();
  await loadSession();
  await loadTasks();
  ws.value = new WsClient(auth.token);
  ws.value.connect({
    onSession: (m) => {
      sessionState.value = m as Record<string, unknown>;
    },
    onQrCode: () => {
      // 后端推送登录二维码：跳到会话页，弹窗由 SessionView 的 WS 监听展示
      if (router.currentRoute.value.path !== '/session') {
        router.push('/session');
      }
    },
    onTask: () => loadTasks(),
  });
  ElMessage?.success?.('已连接实时通道');
});
</script>

<template>
  <el-container class="app-layout">
    <el-header class="app-header">
      <div class="logo">🚄 12306 自动购票管理台</div>
      <div style="display: flex; align-items: center; gap: 16px">
        <el-tag :type="sessionState.loggedIn ? 'success' : 'danger'" effect="dark">
          12306 会话：{{ sessionState.loggedIn ? '已登录' : '未登录' }}
        </el-tag>
        <el-tag type="info" effect="dark">待办任务 {{ taskCount }}</el-tag>
        <span>{{ auth.user?.displayName }}</span>
        <el-button type="text" style="color: #fff" @click="logout">退出</el-button>
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
</template>

