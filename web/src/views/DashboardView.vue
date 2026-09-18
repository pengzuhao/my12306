<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sessionApi, feishuApi, taskApi } from '../api';

const state = ref<Record<string, unknown>>({});
const feishu = ref<Record<string, unknown>>({});
const stats = ref({ pending: 0, queried: 0, running: 0, success: 0, failed: 0 });
const loading = ref(false);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    state.value = await sessionApi.state();
    feishu.value = await feishuApi.get();
    const tasks = (await taskApi.list()) as Array<{ status: string }>;
    stats.value = {
      pending: tasks.filter((t) => t.status === 'pending').length,
      queried: tasks.filter((t) => t.status === 'queried').length,
      running: tasks.filter((t) => t.status === 'running').length,
      success: tasks.filter((t) => t.status === 'success').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<template>
  <div>
    <el-row :gutter="16" class="stat-row">
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">12306 会话</div>
          <div class="stat-value" :style="{ color: state.loggedIn ? '#67c23a' : '#f56c6c' }">
            {{ state.loggedIn ? '已登录' : '未登录' }}
          </div>
          <div class="stat-sub">{{ state.userName }}</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">飞书通知</div>
          <div class="stat-value" :style="{ color: feishu.enabled ? '#67c23a' : '#909399' }">
            {{ feishu.webhookUrl ? (feishu.enabled ? '已启用' : '已停用') : '未配置' }}
          </div>
          <div class="stat-sub">购票成功将提醒付款</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">待触发任务</div>
          <div class="stat-value" style="color: #409eff">{{ stats.queried }}</div>
          <div class="stat-sub">等待起售时刻到点抢票</div>
        </el-card>
      </el-col>
      <el-col :span="6" class="stat-col">
        <el-card class="page-card stat-card">
          <div class="stat-title">累计成功</div>
          <div class="stat-value" style="color: #67c23a">{{ stats.success }}</div>
          <div class="stat-sub">失败 {{ stats.failed }} 次</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="page-card">
      <template #header><b>系统说明</b></template>
      <ol style="line-height: 2; color: #606266">
        <li>在「12306 会话」扫码登录（<b>只需 12306 APP 扫码，全程不保存密码</b>），登录会话自动保存并保活。</li>
        <li>在「购票计划」创建计划：指定乘车人、日期规则（单次或按工作周期）、时间范围、车次与座位偏好。</li>
        <li>系统自动推算购票日期（节假日顺延并标注），并在<b>车票起售时刻</b>触发购买。</li>
        <li>购票成功后<b>不会自动付款</b>，飞书会提醒你登录 12306 完成支付。</li>
        <li>会话失活时通过飞书通知你重新登录。</li>
      </ol>
    </el-card>
  </div>
</template>

<style scoped>
.stat-row {
  margin-bottom: 16px;
}
/* 让每列成为 flex 容器，卡片撑满列高，4 张卡片底边对齐 */
.stat-col {
  display: flex;
}
.stat-card {
  width: 100%;
  margin-bottom: 0;
}
.stat-title {
  color: #909399;
  font-size: 13px;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  margin: 6px 0;
}
.stat-sub {
  color: #909399;
  font-size: 12px;
}
</style>
