<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import { http } from '../api';
const emit = defineEmits<{ verified: [] }>();
const open=ref(false),image=ref(''),message=ref(''),loading=ref(false);
let timer:ReturnType<typeof setTimeout>|undefined, generation=0;
function close(){generation++;clearTimeout(timer);open.value=false;loading.value=false;}
async function start(){
 const run=++generation;clearTimeout(timer);open.value=true;image.value='';loading.value=true;message.value='';
 try{
  const {data}=await http.post('/orders/personal-verification');
  if(run!==generation)return;
  image.value=data.image;message.value='请使用 12306 APP 扫码，授权查询本人车票';
  const poll=async()=>{
   try{
    const {data}=await http.get('/orders/personal-verification');if(run!==generation)return;
    if(data.status==='verified'){close();emit('verified');return;}
    if(data.status==='expired'){message.value='二维码已失效，请刷新';return;}
    if(data.status==='scanned')message.value='已扫描，请在 12306 APP 确认';
    timer=setTimeout(poll,3000);
   }catch{if(run===generation)message.value='核验失败，请刷新重试';}
  };
  timer=setTimeout(poll,3000);
 }catch{if(run===generation)message.value='无法生成二维码，请确认 12306 已登录后重试';}
 finally{if(run===generation)loading.value=false;}
}
onBeforeUnmount(close);
</script>
<template>
 <el-button plain size="small" @click="start">核验本人车票</el-button>
 <el-dialog v-model="open" title="核验本人车票" width="360px" append-to-body @close="close">
  <div v-loading="loading" style="text-align:center;min-height:240px">
   <img v-if="image" :src="image" alt="12306 本人车票核验二维码" width="220" height="220" />
   <p>{{ message }}</p>
  </div>
  <template #footer><el-button @click="close">关闭</el-button><el-button type="primary" :loading="loading" @click="start">刷新二维码</el-button></template>
 </el-dialog>
</template>
