<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { sessionApi, WsClient } from '../api';
import { fmtCn } from '../utils/time';

const state = ref<Record<string, unknown>>({});
const loading = ref(false);
const syncing = ref(false);

// 扫码登录弹窗（本页面自建 WS 连接监听，确保发起登录的用户一定能收到二维码）
const qrVisible = ref(false);
const qrImage = ref('');
const qrStatus = ref('请使用 12306 APP 扫码登录');
let ws: WsClient | null = null;

async function load(): Promise<void> {
  try {
    state.value = await sessionApi.state();
  } catch {
    // ignore
  }
}

async function startLogin(): Promise<void> {
  loading.value = true;
  qrStatus.value = '正在打开 12306 登录页…';
  qrImage.value = '';
  qrVisible.value = true;
  try {
    // 登录接口已异步化：立即返回"已发起"，二维码由 WS 推送
    await sessionApi.login();
    ElMessage.info('正在生成二维码，请稍候');
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '登录发起失败');
    loading.value = false;
    qrVisible.value = false;
  }
}

/** 取消扫码登录 */
async function cancelLogin(): Promise<void> {
  ws?.sendQrCancel();
  await sessionApi.cancelLogin().catch(() => undefined);
  qrVisible.value = false;
  loading.value = false;
  ElMessage.info('已取消登录');
}

async function checkNow(): Promise<void> {
  loading.value = true;
  try {
    const res = await sessionApi.check();
    state.value = res.state;
    ElMessage.info(res.loggedIn ? '会话有效' : '会话已失活，请重新登录');
  } catch (e) {
    ElMessage.error('检查失败');
  } finally {
    loading.value = false;
  }
}

/** 登录结果由 WS session 消息驱动，收到后立即刷新页面状态并解除 loading */
function handleSessionUpdate(m: unknown): void {
  state.value = m as Record<string, unknown>;
  if (state.value.loggedIn) {
    loading.value = false;
    qrVisible.value = false;
    ElMessage.success('12306 登录成功，会话已保存并保活');
  } else if (state.value.failReason) {
    loading.value = false;
    qrVisible.value = false;
    ElMessage.error(String(state.value.failReason));
  }
}

async function syncPassengers(): Promise<void> {
  syncing.value = true;
  try {
    const res = await sessionApi.syncPassengers();
    ElMessage.success(`已同步 ${res.synced} 位常用联系人`);
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '同步失败');
  } finally {
    syncing.value = false;
  }
}

async function doLogout(): Promise<void> {
  await sessionApi.logout();
  await load();
  ElMessage.info('已退出 12306 登录');
}

onMounted(async () => {
  await load();
  // 本页面自建 WS：发起登录的用户必然能收到二维码与登录结果
  const token = localStorage.getItem('my12306_token');
  if (token) {
    ws = new WsClient(token);
    ws.connect({
      onQrCode: (m) => {
        if (m?.image) {
          qrImage.value = m.image;
          qrStatus.value = m.status ?? '请使用 12306 APP 扫码登录';
          qrVisible.value = true;
        }
      },
      onSession: handleSessionUpdate,
    });
  }
});

onUnmounted(() => {
  ws?.close();
  ws = null;
});
</script>

<template>
  <div>
    <el-card class="page-card">
      <template #header><b>12306 登录</b></template>
      <el-form style="max-width: 520px" @submit.prevent="startLogin">
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="startLogin">扫码登录 12306</el-button>
        </el-form-item>
      </el-form>
      <el-alert type="warning" :closable="false">
        本系统<b>不保存 12306 密码</b>，全程不接触密码：点击登录后显示二维码，你用 12306 APP 扫码确认即完成登录。登录成功后只保存浏览器会话并自动保活，失活时飞书通知重新登录。
      </el-alert>
    </el-card>

    <el-card class="page-card">
      <template #header><b>会话状态</b></template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="登录状态">
          <el-tag :type="state.loggedIn ? 'success' : 'danger'">
            {{ state.loggedIn ? '已登录' : '未登录' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="最后登录">{{ fmtCn(state.lastLoginAt as string) }}</el-descriptions-item>
        <el-descriptions-item label="最后检查">{{ fmtCn(state.lastCheckAt as string) }}</el-descriptions-item>
        <el-descriptions-item v-if="state.failReason" label="失败原因" :span="2">
          <span style="color: #f56c6c">{{ state.failReason }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <div style="margin-top: 16px; display: flex; gap: 12px; flex-wrap: wrap">
        <el-button :loading="loading" @click="checkNow">检查会话</el-button>
        <el-button :loading="syncing" @click="syncPassengers">同步常用联系人</el-button>
        <el-button type="danger" @click="doLogout">退出登录</el-button>
      </div>
    </el-card>

    <!-- 扫码登录弹窗（后端通过 WS 推送二维码） -->
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
  </div>
</template>
