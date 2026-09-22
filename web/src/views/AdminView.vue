<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { http, apiError } from '../api';
import { appUser, type AppUser } from '../store/auth';
const users = ref<AppUser[]>([]), loading = ref(false), visible = ref(false), saving = ref(false), error = ref('');
const blank = () => ({ id: '', username: '', displayName: '', role: 'user' as 'user' | 'admin', password: '' });
const form = ref(blank());
async function load() { loading.value = true; error.value = ''; try { users.value = (await http.get('/admin/users')).data; } catch(e) { error.value = apiError(e); } finally { loading.value = false; } }
function edit(user?: AppUser) { form.value = user ? { ...blank(), ...user } : blank(); visible.value = true; }
async function save() { saving.value = true; try { const f = form.value; if (f.id) await http.patch(`/admin/users/${f.id}`, { displayName: f.displayName, role: f.role, ...(f.password ? { password: f.password } : {}) }); else await http.post('/admin/users', f); visible.value = false; ElMessage.success('用户已保存'); if (f.id === appUser.value?.id) { location.hash = '#/login'; location.reload(); } else await load(); } catch(e) { ElMessage.error(apiError(e)); } finally { saving.value = false; } }
async function toggle(user: AppUser) { try { await ElMessageBox.confirm(user.disabled ? `启用“${user.displayName}”后，其活跃计划会恢复调度。` : `停用“${user.displayName}”将退出其登录并停止后续任务调度。`, user.disabled ? '启用用户' : '停用用户', { type: 'warning' }); await http.patch(`/admin/users/${user.id}`, { disabled: !user.disabled }); await load(); } catch(e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(apiError(e)); } }
onMounted(load);
</script>
<template><section><div class="page-heading"><div><h1>用户管理</h1><p>分配管理台账号；每个用户独立连接自己的 12306 账号和通知通道。</p></div><el-button type="primary" @click="edit()">创建用户</el-button></div>
<el-alert v-if="error" :title="error" type="error" :closable="false" /><el-card class="page-card"><el-table :data="users" v-loading="loading">
<el-table-column prop="username" label="账号" min-width="160" /><el-table-column prop="displayName" label="显示名称" min-width="160" /><el-table-column label="角色" width="110"><template #default="{ row }">{{ row.role === 'admin' ? '管理员' : '用户' }}</template></el-table-column><el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.disabled ? 'info' : 'success'">{{ row.disabled ? '已停用' : '正常' }}</el-tag></template></el-table-column><el-table-column label="操作" min-width="180"><template #default="{ row }"><el-button link type="primary" @click="edit(row)">编辑 / 重置密码</el-button><el-button v-if="row.id !== appUser?.id" link :type="row.disabled ? 'success' : 'danger'" @click="toggle(row)">{{ row.disabled ? '启用' : '停用' }}</el-button></template></el-table-column>
</el-table></el-card><el-dialog v-model="visible" :title="form.id ? '编辑用户' : '创建用户'" width="460px" :close-on-click-modal="false"><el-form label-position="top" @submit.prevent="save">
<el-form-item label="账号"><el-input v-model="form.username" :disabled="!!form.id" placeholder="3–40 位字母、数字、下划线或短横线" /></el-form-item><el-form-item label="显示名称"><el-input v-model="form.displayName" maxlength="60" /></el-form-item><el-form-item label="角色"><el-select v-model="form.role" :disabled="form.id === appUser?.id"><el-option label="用户" value="user" /><el-option label="管理员" value="admin" /></el-select></el-form-item><el-form-item :label="form.id ? '重置密码（留空不修改）' : '初始密码'"><el-input v-model="form.password" type="password" show-password autocomplete="new-password" placeholder="至少 12 字符，最多 72 字节" /></el-form-item><p class="form-hint" v-if="form.id">保存后该用户须重新登录。</p>
</el-form><template #footer><el-button @click="visible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template></el-dialog></section></template>
