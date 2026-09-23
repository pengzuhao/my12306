import type { OrderRow } from '../api';
export type ShareContent = { kind: 'ticket'; ticket: OrderRow } | { kind: 'calendar'; year: number; month: number; tickets: OrderRow[] };
const status = (o: OrderRow) => ({ paid: '已支付', unpaid: '待支付', refunded: '已退票' }[o.status]);
/** 仅用白名单字段绘制，订单号、证件、手机号永不进入分享图片。 */
export async function renderShareImage(content: ShareContent, personal: boolean): Promise<Blob> {
  await document.fonts.ready;
  const canvas = document.createElement('canvas'); canvas.width = 1080;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前浏览器不支持图片生成');
  const font = (size: number, weight = 400) => `${weight} ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  const lines = (text: string, width: number, size = 24) => { ctx.font = font(size); const result: string[] = []; let row = ''; for (const char of text) { if (char === '\n' || ctx.measureText(row + char).width > width) { result.push(row); row = char === '\n' ? '' : char; } else row += char; } result.push(row); return result; };
  const details = content.kind === 'ticket' ? [content.ticket] : content.tickets.filter(t => t.travelDateTime.startsWith(`${content.year}-${String(content.month).padStart(2, '0')}`)).sort((a,b) => a.travelDateTime.localeCompare(b.travelDateTime));
  const cards = details.map(t => ({ ticket: t, route: lines(`${t.fromStation}  →  ${t.toStation}`, 790, 30), personal: personal ? lines(`${t.passengers.join('、') || '未提供乘车人'} · ${t.seats.join('、') || '未提供座位'}`, 880, 22) : [] }));
  const offset = content.kind === 'calendar' ? (new Date(content.year, content.month - 1, 1).getDay() + 6) % 7 : 0;
  const days = content.kind === 'calendar' ? new Date(content.year, content.month, 0).getDate() : 0;
  const gridRows = Math.ceil((offset + days) / 7);
  const gridHeight = content.kind === 'calendar' ? gridRows * 142 + 110 : 0;
  const heights = cards.map(c => 195 + c.route.length * 40 + c.personal.length * 30);
  canvas.height = 290 + gridHeight + heights.reduce((a,b) => a+b+20, 0) + (cards.length ? 0 : 90) + 130;
  if (canvas.height > 30000) throw new Error('当前月车票过多，请按乘车人筛选后分享');
  ctx.fillStyle = '#edf3fa'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const text = (value: string, x: number, y: number, size = 24, color = '#284563', weight = 400) => { ctx.font = font(size,weight); ctx.fillStyle = color; ctx.fillText(value, x,y); };
  const box = (x: number,y: number,w: number,h: number,color = '#fff', radius = 16) => { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x,y,w,h,radius); ctx.fill(); };
  box(0,0,1080,232,'#173f67',0);
  text('my12306  /  我的出行',64,68,25,'#aac8e3');
  text(content.kind === 'ticket' ? '下一站，出发' : `${content.year} 年 ${content.month} 月 · 车票日历`,64,138,44,'#fff',600);
  text(content.kind === 'ticket' ? `${content.ticket.trainCode}  ·  ${status(content.ticket)}` : `${details.length} 张车票 · 已支付行程`,64,192,25,'#c0d5e8');
  let y = 276;
  if (content.kind === 'calendar') {
    const colW = 136;
    ['一','二','三','四','五','六','日'].forEach((d,i) => text(d,86+i*colW,y+24,22,'#8395a8'));
    y += 48;
    for (let d=1; d<=days; d++) {
      const idx=offset+d-1, x=64+(idx%7)*colW, top=y+Math.floor(idx/7)*142;
      const date=`${content.year}-${String(content.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const tickets=details.filter(t => t.travelDateTime.startsWith(date));
      box(x,top,128,132,tickets.length ? '#dae9f8' : '#f8fbfe',12);
      text(String(d),x+14,top+32,24,tickets.length ? '#24578b' : '#8a9aaa',600);
      tickets.slice(0,2).forEach((t,i) => text(t.trainCode,x+12,top+65+i*25,19,'#24578b',500));
      if(tickets.length>2) text(`+${tickets.length-2} 张`,x+12,top+117,16,'#477cae');
    }
    y += gridRows*142+40;
  }
  cards.forEach((c,i) => {
    const t=c.ticket,h=heights[i]; box(64,y,952,h);
    text(t.trainCode,92,y+44,31,'#245f9a',600);
    text(status(t),315,y+42,23,'#7a8ba1');
    c.route.forEach((line,j) => text(line,92,y+91+j*40,30,'#284563',600));
    text(`出发  ${t.travelDateTime}`,92,y+101+c.route.length*40,24,'#284563');
    text(`到达  ${t.arrivalDateTime || '待确认'}`,92,y+141+c.route.length*40,26,'#245f9a',600);
    c.personal.forEach((line,j) => text(line,92,y+181+c.route.length*40+j*30,22,'#78899d'));
    y += h+20;
  });
  if (!cards.length) { text('这个月暂无已支付车票',64,y+35,27,'#7a8ba1'); y+=90; }
  text('行程分享 · 非乘车凭证，请以 12306 实际订单为准',64,y+40,21,'#8192a6');
  text(`生成于 ${new Date().toLocaleString('zh-CN',{ timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`,64,y+77,18,'#98a7b6');
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png'));
}
