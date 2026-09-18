<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../store/auth';

const router = useRouter();
const auth = useAuthStore();
const loading = ref(false);

const form = reactive({ username: 'admin', password: 'admin123' });

async function onSubmit(): Promise<void> {
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    ElMessage.success('登录成功');
    router.push({ name: 'dashboard' });
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '登录失败';
    ElMessage.error(msg);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <template #header>
        <div class="login-title">12306 自动购票管理台</div>
      </template>
      <el-form @submit.prevent="onSubmit">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="请输入用户名" clearable />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password />
        </el-form-item>
        <el-button type="primary" :loading="loading" style="width: 100%" @click="onSubmit">登录</el-button>
      </el-form>
      <div class="login-tip">默认账号 admin / admin123，登录后请尽快修改密码</div>
    </el-card>
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #001529 0%, #003a70 100%);
}
.login-card {
  width: 380px;
}
.login-title {
  font-size: 18px;
  font-weight: 600;
  text-align: center;
}
.login-tip {
  margin-top: 12px;
  color: #909399;
  font-size: 12px;
  text-align: center;
}
</style>
