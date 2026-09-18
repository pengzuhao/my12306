<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { feishuApi } from '../api';

const form = reactive({
  webhookUrl: '',
  secret: '',
  enabled: true,
  remark: '',
});
const loading = ref(false);

async function load(): Promise<void> {
  const cfg = await feishuApi.get();
  form.webhookUrl = cfg.webhookUrl ?? '';
  form.secret = cfg.secret ?? '';
  form.enabled = cfg.enabled ?? true;
  form.remark = cfg.remark ?? '';
}

async function save(): Promise<void> {
  if (!form.webhookUrl.startsWith('http')) {
    ElMessage.warning('请填写合法的 webhook 地址');
    return;
  }
  loading.value = true;
  try {
    await feishuApi.save({
      webhookUrl: form.webhookUrl,
      secret: form.secret || null,
      enabled: form.enabled,
      remark: form.remark || null,
    });
    ElMessage.success('飞书配置已保存');
  } catch (e) {
    ElMessage.error('保存失败');
  } finally {
    loading.value = false;
  }
}

async function test(): Promise<void> {
  loading.value = true;
  try {
    await feishuApi.test();
    ElMessage.success('测试消息已发送，请检查飞书群');
  } catch (e) {
    ElMessage.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? '发送失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <el-card class="page-card">
    <template #header><b>飞书群机器人通知</b></template>
    <el-form label-width="160px" style="max-width: 620px">
      <el-form-item label="Webhook 地址">
        <el-input v-model="form.webhookUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx" />
      </el-form-item>
      <el-form-item label="签名校验密钥">
        <el-input v-model="form.secret" type="password" show-password placeholder="飞书机器人安全设置中的签名密钥" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" placeholder="如：抢票通知群" />
      </el-form-item>
      <el-form-item label="启用">
        <el-switch v-model="form.enabled" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="save">保存配置</el-button>
        <el-button :loading="loading" @click="test">发送测试消息</el-button>
      </el-form-item>
    </el-form>
    <el-alert type="info" :closable="false" style="margin-top: 8px">
      飞书机器人开启「签名校验」后，本系统按官方算法（HMAC-SHA256(timestamp + "\n" + secret)）签名发送。
      通知场景：会话失活告警、购票成功提醒付款、任务失败告警。
    </el-alert>
  </el-card>
</template>
