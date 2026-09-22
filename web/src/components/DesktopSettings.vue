<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
interface DesktopStatus { version: string; autoStart: boolean; autoStartAvailable: boolean; loginStatus: string; dataDir: string; }
const bridge = (window as Window & { my12306Desktop?: {
  status(): Promise<DesktopStatus>; setAutoStart(enabled: boolean): Promise<DesktopStatus>;
  openDataFolder(): Promise<string>; quit(): Promise<boolean>; runInBackground?(): Promise<boolean>;
} }).my12306Desktop;
const visible = ref(false), busy = ref(false);
const state = ref<DesktopStatus>();
async function open() {
  try { state.value = await bridge!.status(); visible.value = true; }
  catch { ElMessage.error('无法读取桌面设置'); }
}
async function toggle(value: string | number | boolean) {
  busy.value = true;
  try { state.value = await bridge!.setAutoStart(Boolean(value)); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '设置失败'); state.value = await bridge!.status(); }
  finally { busy.value = false; }
}
async function openFolder() {
  try { const error = await bridge!.openDataFolder(); if (error) ElMessage.error(error); }
  catch { ElMessage.error('无法打开数据目录'); }
}
async function runInBackground() {
  try { await bridge!.runInBackground!(); visible.value = false; }
  catch { ElMessage.error('无法切换到后台，请重试'); }
}
</script>
<template>
  <el-button v-if="bridge" class="desktop-settings-button" text circle aria-label="桌面设置" title="桌面设置" @click="open"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8m-4-4v4M7 8h10"/></svg></el-button>
  <el-dialog v-model="visible" title="桌面设置" width="460px" append-to-body>
    <template v-if="state">
      <div class="desktop-option"><div><strong>开机自动启动</strong><p>重启电脑并登录后自动在后台运行，不弹出主窗口。点击托盘图标可打开。</p></div><el-switch :model-value="state.autoStart" :disabled="!state.autoStartAvailable || busy" :loading="busy" aria-label="开机自动启动" @change="toggle" /></div>
      <el-alert v-if="!state.autoStartAvailable" title="开发模式下不修改电脑的启动项；安装桌面版后可开启。" type="info" :closable="false" />
      <el-alert v-else-if="state.loginStatus === 'requires-approval'" title="请在系统设置 → 通用 → 登录项中允许 my12306。" type="warning" :closable="false" />
      <div class="desktop-option"><div><strong>关闭窗口后继续运行</strong><p>购票计划和通知继续执行。点击托盘图标可重新打开；选择「退出」才会停止。电脑休眠或关机期间无法执行任务。</p></div></div>
      <p class="desktop-path">数据保存在本机：<br>{{ state.dataDir }}</p>
      <el-button @click="openFolder">打开数据目录</el-button>
      <p class="desktop-version">my12306 {{ state.version }}</p>
    </template>
    <template #footer><el-button @click="visible = false">完成</el-button><el-button v-if="bridge?.runInBackground" type="primary" @click="runInBackground">后台运行</el-button><el-button type="danger" plain @click="bridge?.quit()">退出应用</el-button></template>
  </el-dialog>
</template>
<style scoped>
.desktop-option{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}.desktop-option p,.desktop-path{font-size:13px;color:#7c8998;line-height:1.7;margin:8px 0;overflow-wrap:anywhere}.desktop-version{font-size:12px;color:#98a2af;margin-top:24px}.desktop-settings-button{color:#667b93}
</style>
