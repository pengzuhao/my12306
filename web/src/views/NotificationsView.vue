<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { http, apiError, notificationApi, type NotificationChannel } from '../api';
import { fmtCn } from '../utils/time';
const types: Record<string, string> = { feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉', telegram: 'Telegram', webhook: '通用 Webhook' };
const events: Record<string, string> = { order_success: '购票成功 · 待付款', duplicate_order: '已购车票查重', session_invalid: '12306 登录失效', task_failed: '购票失败' };
const channels = ref<NotificationChannel[]>([]), loading = ref(false), saving = ref(false), testing = ref(''), visible = ref(false), error = ref('');
const blank = () => ({ id: undefined as string | undefined, name: '', type: 'feishu', enabled: true, events: Object.keys(events), config: { webhookUrl: '', secret: '', botToken: '', chatId: '', bearerToken: '' }, clearSecrets: [] as string[] });
const form = ref(blank()), configured = ref<Record<string, boolean>>({});
const saveError = ref('');
const fieldErrors = ref<Record<string, string>>({});
async function load() { loading.value = true; error.value = ''; try { channels.value = await notificationApi.list(); } catch(e) { error.value = apiError(e); } finally { loading.value = false; } }
function edit(c?: NotificationChannel) { saveError.value = ''; fieldErrors.value = {}; form.value = blank(); configured.value = c?.configured || {}; if (c) form.value = { ...form.value, id: c.id, name: c.name, type: c.type, enabled: c.enabled, events: [...c.events], config: { ...form.value.config, chatId: c.config.chatId || '' } }; visible.value = true; }
function changeType() { form.value.config = blank().config; configured.value = {}; form.value.clearSecrets = []; }
async function save() {
  if (saving.value) return;
  saveError.value = ''; fieldErrors.value = {};
  const value = form.value;
  value.name = value.name.trim();
  if (!value.name) fieldErrors.value.name = '请填写通道名称';
  if (!value.events.length) fieldErrors.value.events = '请至少选择一种接收事件';
  if (value.type !== 'telegram' && !value.config.webhookUrl.trim() && !configured.value.webhookUrl) fieldErrors.value.webhookUrl = '请填写飞书等平台提供的 Webhook 地址';
  if (Object.keys(fieldErrors.value).length) { saveError.value = Object.values(fieldErrors.value).join('；'); return; }
  saving.value = true;
  try {
    const { data } = await http.post<NotificationChannel>('/notifications', value);
    // Apply the saved response immediately; a list refresh failure cannot hide a successful save.
    channels.value = [...channels.value.filter(c => c.id !== data.id), data];
    visible.value = false;
    ElMessage.success('通知通道已保存');
  } catch(e) { saveError.value = apiError(e); }
  finally { saving.value = false; }
}
async function test(c: NotificationChannel) { testing.value = c.id; try { await http.post(`/notifications/${c.id}/test`); ElMessage.success('测试消息已发送，请查看接收端'); } catch(e) { ElMessage.error(apiError(e)); } finally { testing.value = ''; await load(); } }
async function remove(c: NotificationChannel) { try { await ElMessageBox.confirm(`删除“${c.name}”后，该通道将停止接收通知。`, '删除通知通道', { type: 'warning' }); await http.delete(`/notifications/${c.id}`); await load(); } catch(e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(apiError(e)); } }
onMounted(load);
</script>
<template><section>
  <div class="page-heading"><div><h1>通知通道</h1><p>为购票和账号状态选择接收方式，可同时启用多个通道。</p></div><el-button type="primary" @click="edit()">添加通道</el-button></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <el-card class="page-card" v-loading="loading">
    <el-empty v-if="!channels.length" description="还没有通知通道，添加后即可接收购票提醒" />
    <div v-for="c in channels" :key="c.id" class="channel-row">
      <div class="channel-symbol">{{ types[c.type]?.slice(0, 1) }}</div><div class="channel-info"><h3>{{ c.name }} <el-tag size="small" :type="c.enabled ? 'success' : 'info'">{{ c.enabled ? '已启用' : '已停用' }}</el-tag></h3><p>{{ types[c.type] }} · {{ c.events.map(e => events[e]).join(' / ') }}</p><small v-if="c.lastSentAt" :class="{ failed: c.lastStatus === 'failed' }">最近发送 {{ fmtCn(c.lastSentAt) }} · {{ c.lastStatus === 'success' ? '成功' : '失败，请检查配置和网络' }}</small><small v-else>尚未发送</small></div>
      <div class="row-actions"><el-button :disabled="!c.enabled || !!testing" :loading="testing === c.id" @click="test(c)">发送测试</el-button><el-button @click="edit(c)">编辑</el-button><el-button text type="danger" @click="remove(c)">删除</el-button></div>
    </div>
  </el-card>
  <el-dialog v-model="visible" :title="form.id ? '编辑通知通道' : '添加通知通道'" width="580px" top="4vh" class="plan-editor-dialog" append-to-body destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="通道名称" :error="fieldErrors.name" required><el-input v-model="form.name" maxlength="60" placeholder="例如：家庭出行提醒" /></el-form-item>
      <el-form-item label="通知平台"><el-select v-model="form.type" @change="changeType" :disabled="!!form.id" style="width: 100%"><el-option v-for="(label, value) in types" :key="value" :value="value" :label="label" /></el-select></el-form-item>
      <template v-if="form.type === 'telegram'"><el-form-item label="Bot Token"><el-input v-model="form.config.botToken" type="password" show-password autocomplete="off" :placeholder="configured.botToken ? '已配置，留空保留' : '从 BotFather 获取的 Token'" /></el-form-item><el-form-item label="Chat ID"><el-input v-model="form.config.chatId" placeholder="用户或群组 Chat ID" /></el-form-item></template>
      <template v-else><el-form-item label="Webhook 地址" :error="fieldErrors.webhookUrl" :required="!configured.webhookUrl"><el-input v-model="form.config.webhookUrl" type="password" show-password autocomplete="off" :placeholder="configured.webhookUrl ? '已配置，留空保留' : 'https://…'" /></el-form-item>
      <el-form-item v-if="['feishu', 'dingtalk'].includes(form.type)" label="签名密钥（可选）"><el-input v-model="form.config.secret" type="password" show-password autocomplete="off" :placeholder="configured.secret ? '已配置，留空保留' : '平台开启签名校验后填写'" /><el-checkbox v-if="configured.secret" v-model="form.clearSecrets" value="secret">清除已保存的签名密钥</el-checkbox></el-form-item>
      <el-form-item v-if="form.type === 'webhook'" label="Bearer Token（可选）"><el-input v-model="form.config.bearerToken" type="password" show-password :placeholder="configured.bearerToken ? '已配置，留空保留' : '接收端的访问令牌'" /><el-checkbox v-if="configured.bearerToken" v-model="form.clearSecrets" value="bearerToken">清除已保存的令牌</el-checkbox></el-form-item></template>
      <p class="form-hint">{{ form.type === 'telegram' ? '机器人须已加入群组，或接收人已向机器人发送 /start。' : form.type === 'webhook' ? '接收端须为公网 HTTPS 地址。发送 JSON：source、event、text、urgent、timestamp；HTTP 2xx 视为成功。' : '使用平台的自定义群机器人地址。若设置了关键词，请允许“12306”；签名密钥须与平台保持一致。' }}</p>
      <el-form-item label="接收事件" :error="fieldErrors.events" required><el-checkbox-group v-model="form.events"><el-checkbox v-for="(label, value) in events" :key="value" :value="value">{{ label }}</el-checkbox></el-checkbox-group></el-form-item>
      <el-form-item label="启用通道"><el-switch v-model="form.enabled" /></el-form-item>
    </el-form><template #footer><el-alert v-if="saveError" :title="saveError" type="error" show-icon :closable="false" style="margin-bottom: 12px; text-align: left" /><el-button :disabled="saving" @click="visible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">{{ saving ? '正在保存…' : '保存通道' }}</el-button></template>
  </el-dialog>
</section></template>
<style scoped>
.channel-row { display: flex; align-items: center; gap: 16px; padding: 22px 0; border-bottom: 1px solid #edf0f5; }.channel-row:last-child{ border: 0; }.channel-symbol { flex-shrink: 0; width: 46px; height: 46px; border-radius: 14px; background: #edf3fc; color: #3467ad; display: grid; place-items: center; font-size: 21px; }.channel-info{ flex: 1; min-width: 0; }h3{ margin: 0 0 8px; font-size: 16px; }p{ margin: 0 0 6px; color: #758196; font-size: 13px; }small{ color: #98a2b1; }.failed { color: #d45252; }.row-actions { display: flex; flex-wrap: wrap; gap: 6px; }.row-actions .el-button{ margin-left: 0; }@media(max-width:760px){.channel-row{ flex-wrap: wrap; }.row-actions{ width: 100%; padding-left: 62px; }}
</style>
