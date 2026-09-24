import type { BrowserContext } from 'playwright';
import type { RawOrder, RawTicket } from './orderApi.js';
const ROOT = 'https://kyfw.12306.cn';
const STATUS: Record<string,string> = {a:'已支付',bb:'已出票',c:'已退票',d:'已改签',e:'已变更到站',f:'改签票',g:'变更到站票',h:'已实名认证',i:'已进站',j:'已出站',k:'车上补签',l:'已作废',m:'改签中',n:'变更到站中'};
export interface PersonalTicket {
 sequence_no?: string; start_date?: string; start_time?: string; train_date?: string;
 train_code?: string; board_train_code?: string; from_station_name?: string; to_station_name?: string;
 passenger_name?: string; coach_no?: string; seat_name?: string; seat_type_name?: string;
 ticket_price?: string | number; status_name?: string; arrive_time?: string;
}
const date = (value = '') => /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : value;
/** psr 票价单位是角，普通订单接口则是分；只映射展示字段，不引入退票凭据。 */
export function personalOrders(tickets: PersonalTicket[]): RawOrder[] {
 return tickets.filter(t=>!['d','e','l'].includes(t.status_name ?? '') && t.sequence_no && t.passenger_name && t.start_date && (t.board_train_code || t.train_code)).map(t=>({sequence_no:t.sequence_no,tickets:[{
  personalOnly:true,
  start_train_date_page:`${date(t.start_date)} ${t.start_time ?? ''}`.trim(),
  passenger_name:t.passenger_name,coach_name:t.coach_no,seat_name:t.seat_name,seat_type_name:t.seat_type_name,
  price:t.ticket_price != null && t.ticket_price !== '' && Number.isFinite(Number(t.ticket_price)) && Number(t.ticket_price)>=0 ? Number(t.ticket_price)/10 : undefined,
  ticket_status_name:STATUS[t.status_name ?? ''] ?? t.status_name ?? '已出票',
  stationTrainDTO:{station_train_code:t.board_train_code || t.train_code,from_station_name:t.from_station_name,to_station_name:t.to_station_name,arrive_time:t.arrive_time},
 }]}));
}
function identity(order: RawOrder,t: RawTicket): string {
 return JSON.stringify([order.sequence_no,t.start_train_date_page?.replace(/\D/g,'').slice(0,12),t.stationTrainDTO?.station_train_code,t.stationTrainDTO?.from_station_name,t.stationTrainDTO?.to_station_name,t.passenger_name || t.passengerDTO?.passenger_name, /退票|已改签|已变更到站|已作废/.test(t.ticket_status_name ?? '') ? t.ticket_status_name : 'valid']);
}
/** 自购订单优先，避免本人票重复加价；同一订单中的其他乘车人仍保留。 */
export function mergePersonalOrders(owned: RawOrder[],personal: RawOrder[]): RawOrder[] {
 const seen=new Set(owned.flatMap(o=>(o.tickets??[]).map(t=>identity(o,t))));
 const result=owned.map(o=>({...o,tickets:[...(o.tickets??[])]}));
 for(const o of personal) for(const t of o.tickets??[]) {
  const key=identity(o,t); if(seen.has(key))continue; seen.add(key);
  const existing=result.find(r=>r.sequence_no===o.sequence_no);
  if(existing) existing.tickets!.push(t); else result.push({...o,tickets:[t]});
 }
 return result;
}
export async function personalRequest(context: BrowserContext,path:string,form:Record<string,string|number>):Promise<any> {
 const response=await context.request.post(ROOT+path,{form,timeout:15000,headers:{Referer:ROOT+'/otn/view/personal_travel.html','X-Requested-With':'XMLHttpRequest'}});
 if(!response.ok())throw new Error('本人车票查询暂时不可用，请稍后重试');
 return response.json();
}
export async function fetchPersonalOrders(context: BrowserContext):Promise<RawOrder[]> {
 const day=(offset:number)=>new Date(Date.now()+8*3600000+offset*86400000).toISOString().slice(0,10).replace(/-/g,'');
 const all:PersonalTicket[]=[];
 for(let pageIndex=1;pageIndex<=100;pageIndex++) {
  const response=await personalRequest(context,'/otn/psr/query',{from_date:day(0),end_date:day(30),order_num:'',pageIndex,ticket_type:1});
  const psr=response.data?.psr;
  if(response.status!==true || response.messages?.length || !Array.isArray(psr?.results))throw new Error('本人车票尚未同步，请点击“核验本人车票”完成 12306 扫码核验后刷新');
  all.push(...psr.results);
  const total=Number(psr.total);
  if(!Number.isFinite(total)||total<0)throw new Error('本人车票分页信息异常，请稍后重试');
  if(all.length>=total)return personalOrders(all);
  if(!psr.results.length)throw new Error('本人车票返回不完整，请稍后重试');
 }
 throw new Error('本人车票过多，未能完整同步');
}
