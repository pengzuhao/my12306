<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api';
import { appUser } from '../store/auth';
const router = useRouter(), username = ref(''), password = ref(''), busy = ref(false), error = ref('');
async function login() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { appUser.value = (await http.post('/auth/login', { username: username.value, password: password.value })).data; password.value = ''; await router.replace('/dashboard'); }
  catch (e) { error.value = (e as { response?: { data?: { error?: string } } }).response?.data?.error || '登录失败，请检查服务是否在线'; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="login-page"><section class="login-panel">
    <div class="login-mark">🚄</div><h1>欢迎回来</h1><p>登录你的 my12306 管理台</p>
    <el-form label-position="top" @submit.prevent="login">
      <el-form-item label="管理台账号"><el-input v-model="username" autocomplete="username" size="large" placeholder="请输入管理员分配的账号" /></el-form-item>
      <el-form-item label="密码"><el-input v-model="password" type="password" show-password autocomplete="current-password" size="large" /></el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 16px" />
      <el-button native-type="submit" type="primary" size="large" :loading="busy" style="width: 100%">登录管理台</el-button>
    </el-form>
    <p class="login-note">12306 账号将在登录后单独扫码连接</p>
  </section></main>
</template>
<style scoped>
.login-page { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(ellipse at top left, #e3ecfb, #f8fafc 65%); padding: 24px; box-sizing: border-box; }
.login-panel { width: 360px; max-width: 100%; padding: 36px; border-radius: 20px; background: white; box-shadow: 0 20px 70px #203e7210; }
.login-mark { font-size: 32px; } h1 { margin-bottom: 8px; font-size: 26px; color: #17304f; } p { color: #7a8798; margin-bottom: 30px; }.login-note { margin: 24px 0 0; font-size: 12px; text-align: center; }
</style>
