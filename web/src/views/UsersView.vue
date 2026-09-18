<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { authApi } from '../api';

const users = ref<Array<Record<string, unknown>>>([]);
const dialogVisible = ref(false);
const form = reactive({ username: '', password: '', role: 'user', displayName: '' });

async function load(): Promise<void> {
  users.value = (await authApi.listUsers()) as Array<Record<string, unknown>>;
}

async function create(): Promise<void> {
  try {
    await authApi.createUser({ ...form });
    ElMessage.success('用户已创建');
    dialogVisible.value = false;
    form.username = '';
    form.password = '';
    form.displayName = '';
    await load();
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '创建失败');
  }
}

async function remove(id: string): Promise<void> {
  await ElMessageBox.confirm('确认删除该用户？其计划与任务将一并删除', '提示', { type: 'warning' });
  await authApi.deleteUser(id);
  await load();
}

onMounted(load);
</script>

<template>
  <el-card class="page-card">
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <b>用户管理</b>
        <el-button type="primary" @click="dialogVisible = true">新建用户</el-button>
      </div>
    </template>
    <el-table :data="users" border>
      <el-table-column prop="username" label="用户名" />
      <el-table-column prop="displayName" label="显示名" />
      <el-table-column label="角色" width="100">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'danger' : 'info'">{{ row.role === 'admin' ? '管理员' : '普通用户' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" type="danger" :disabled="row.role === 'admin'" @click="remove(row.id)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-alert style="margin-top: 12px" type="info" :closable="false">
      每个用户各自绑定 12306 账号、飞书 webhook 与购票计划，互不影响。
    </el-alert>
  </el-card>

  <el-dialog v-model="dialogVisible" title="新建用户" width="420px">
    <el-form label-width="80px">
      <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
      <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password /></el-form-item>
      <el-form-item label="角色">
        <el-select v-model="form.role">
          <el-option label="普通用户" value="user" />
          <el-option label="管理员" value="admin" />
        </el-select>
      </el-form-item>
      <el-form-item label="显示名"><el-input v-model="form.displayName" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" @click="create">创建</el-button>
    </template>
  </el-dialog>
</template>
