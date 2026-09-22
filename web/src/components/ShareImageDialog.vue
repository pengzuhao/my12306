<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { renderShareImage, type ShareContent } from '../utils/share-image';
const props = defineProps<{ content: ShareContent | null }>();
const emit = defineEmits<{ close: [] }>();
const personal = ref(false), loading = ref(false), error = ref(''), url = ref(''), file = ref<File | null>(null);
let generation = 0;
const canShare = computed(() => !!file.value && !!navigator.canShare?.({ files: [file.value] }));
function clearUrl() { if (url.value) URL.revokeObjectURL(url.value); url.value = ''; }
async function generate() {
  const g=++generation; file.value=null; clearUrl(); error.value='';
  if(!props.content) return;
  loading.value=true;
  try { const blob=await renderShareImage(props.content,personal.value); if (g!==generation) return; file.value=new File([blob], props.content.kind === 'calendar' ? `车票日历-${props.content.year}-${props.content.month}.png` : `车票-${props.content.ticket.trainCode}.png`, { type: 'image/png' }); url.value=URL.createObjectURL(blob); }
  catch(e) { if(g===generation) error.value=(e as Error).message; }
  finally { if(g===generation) loading.value=false; }
}
watch(() => props.content, () => { personal.value=false; void generate(); });
watch(personal,generate);
async function share() { if(!file.value) return; try { await navigator.share({ files: [file.value], title: '我的出行' }); } catch(e) { if((e as Error).name!=='AbortError') ElMessage.info('暂时无法调用系统分享，请保存图片后发到微信'); } }
onBeforeUnmount(() => { generation++; clearUrl(); });
</script>
<template><el-dialog :model-value="!!content" title="分享到微信" width="580px" top="5vh" @close="emit('close')">
  <p class="share-instruction">保存下方图片，在微信聊天中发送；手机上也可长按图片保存。</p>
  <el-checkbox v-model="personal">在图片中显示乘车人及座位信息</el-checkbox>
  <div class="share-preview" v-loading="loading"><el-alert v-if="error" :title="error" type="error" :closable="false" /><img v-if="url" :src="url" alt="车票分享图片预览" /><p v-else-if="!error">正在生成图片…</p></div>
  <template #footer><el-button @click="emit('close')">关闭</el-button><el-button v-if="canShare" :disabled="loading || !file" @click="share">系统分享</el-button><a v-if="file && !loading" class="el-button el-button--primary save-image" :href="url" :download="file.name">保存图片</a><el-button v-else type="primary" disabled>保存图片</el-button></template>
</el-dialog></template>
<style scoped>.save-image { text-decoration: none; margin-left: 12px; }.share-instruction{ margin: 0 0 8px; color: #77859a; font-size: 13px; line-height: 1.8; }.share-preview{ margin-top: 12px; background: #f0f4fa; border-radius: 12px; padding: 16px; max-height: 58vh; overflow: auto; min-height: 160px; }.share-preview img{ display: block; width: 100%; height: auto; box-shadow: 0 6px 18px #1e365014; border-radius: 8px; }</style>
