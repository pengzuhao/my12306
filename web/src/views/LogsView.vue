<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { http, apiError } from '../api';
import { fmtCn } from '../utils/time';
import { appUser, multiUser } from '../store/auth';
const rows = ref<Record<string, any>[]>([]), total = ref(0), loading = ref(false), exporting = ref(false), error = ref('');
const page = ref(1), pageSize = ref(30), keyword = ref(''), level = ref(''), category = ref(''), userId = ref(''), dates = ref<Date[]>([]), users = ref<{ id: string; displayName: string }[]>([]);
const detail = ref(''), detailVisible = ref(false);
const params = () => ({ page: page.value, pageSize: pageSize.value, keyword: keyword.value || undefined, level: level.value || undefined, category: category.value || undefined, userId: userId.value || undefined, from: dates.value?.[0]?.toISOString(), to: dates.value?.[1]?.toISOString() });
let generation = 0;
async function load(reset = false) { if (reset) page.value = 1; const mine = ++generation; loading.value = true; error.value = ''; try { const { data } = await http.get('/logs', { params: params() }); if (mine === generation) { rows.value = data.items; total.value = data.total; } } catch(e) { if (mine === generation) error.value = apiError(e); } finally { if (mine === generation) loading.value = false; } }
async function exportLogs() { exporting.value = true; try { const { data } = await http.get('/logs/export', { params: params(), responseType: 'blob' }); const url = URL.createObjectURL(data); const a = document.createElement('a'); a.href = url; a.download = `my12306-logs-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch(e) { const blob = (e as { response?: { data?: Blob } }).response?.data; try { ElMessage.error(JSON.parse(await blob!.text()).error); } catch { ElMessage.error('导出失败，请缩小筛选范围或稍后重试'); } } finally { exporting.value = false; } }
function showDetail(row: Record<string, any>) { detail.value = JSON.stringify(row.detail, null, 2); detailVisible.value = true; }
function reset() { keyword.value = ''; level.value = ''; category.value = ''; userId.value = ''; dates.value = []; void load(true); }
onMounted(async () => { void load(); if (multiUser.value && appUser.value?.role === 'admin') try { users.value = (await http.get('/admin/users')).data; } catch { /* 日志查询不依赖用户选项 */ } });
</script>
<template><section>
  <div class="page-heading"><div><h1>过程日志</h1><p>查询执行过程与通知结果，按当前筛选一键导出 CSV。</p></div><el-button :loading="exporting" @click="exportLogs">导出筛选结果</el-button></div>
  <el-card class="page-card"><el-form inline class="log-filters" @submit.prevent="load(true)">
    <el-form-item><el-input v-model="keyword" placeholder="搜索内容或任务 ID" clearable style="width: 220px" /></el-form-item>
    <el-form-item><el-select v-model="level" clearable placeholder="全部级别" style="width: 120px"><el-option v-for="v in ['debug', 'info', 'warn', 'error']" :key="v" :value="v" :label="v.toUpperCase()" /></el-select></el-form-item>
    <el-form-item><el-input v-model="category" clearable placeholder="分类，如 bot / notify" style="width: 170px" /></el-form-item>
    <el-form-item><el-date-picker v-model="dates" type="datetimerange" start-placeholder="开始时间" end-placeholder="结束时间" style="max-width: 100%" /></el-form-item>
    <el-form-item v-if="multiUser && appUser?.role === 'admin'"><el-select v-model="userId" clearable placeholder="全部用户及系统" style="width: 170px"><el-option v-for="u in users" :key="u.id" :value="u.id" :label="u.displayName" /></el-select></el-form-item>
    <el-form-item><el-button type="primary" native-type="submit" :loading="loading">查询</el-button><el-button @click="reset">重置</el-button></el-form-item>
  </el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 12px" />
    <el-table :data="rows" v-loading="loading" empty-text="没有符合条件的日志">
      <el-table-column label="时间（北京时间）" width="180"><template #default="{ row }">{{ fmtCn(row.created_at) }}</template></el-table-column>
      <el-table-column label="级别" width="90"><template #default="{ row }"><el-tag :type="row.level === 'error' ? 'danger' : row.level === 'warn' ? 'warning' : 'info'" size="small">{{ row.level.toUpperCase() }}</el-tag></template></el-table-column>
      <el-table-column prop="category" label="分类" width="110" /><el-table-column prop="message" label="内容" min-width="260" />
      <el-table-column label="详情" width="80"><template #default="{ row }"><el-button v-if="row.detail" link type="primary" @click="showDetail(row)">查看</el-button><span v-else>—</span></template></el-table-column>
    </el-table>
    <div class="pagination-wrap"><span>共 {{ total }} 条 · 导出最多 5 万条 · 敏感字段已隐藏</span><el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="load()" /></div>
  </el-card><el-dialog v-model="detailVisible" title="日志详情" width="720px"><pre class="log-detail">{{ detail }}</pre></el-dialog>
</section></template>
<style scoped>
.log-filters .el-form-item{ margin-right: 12px; }.pagination-wrap{ display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-top: 20px; font-size: 12px; color: #8792a3; }.log-detail{ white-space: pre-wrap; word-break: break-word; max-height: 60vh; overflow: auto; line-height: 1.7; background: #f6f8fb; padding: 16px; border-radius: 8px; }@media(max-width:760px){.log-filters .el-form-item{ max-width: 100%; margin-right: 0; }}
</style>
