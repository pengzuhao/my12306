import { dispatch } from './channels.js';
/** 购票成功提醒（需求 5：不付款，提醒用户登录 12306 支付） */
export function notifyOrderSuccess(params: {
  userId: string;
  planName: string;
  trainNumber: string;
  travelDate: string;
  passengers: string[];
  seatInfo?: string;
  payDeadline?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { userId, planName, trainNumber, travelDate, passengers, seatInfo, payDeadline } = params;
  const lines = [
    '🎫 购票成功（未支付）',
    `计划：${planName}`,
    `车次：${trainNumber}  乘车日期：${travelDate}`,
    `乘车人：${passengers.join('、')}`,
    seatInfo ? `座位：${seatInfo}` : '',
    payDeadline ? `请尽快登录 12306 完成支付，订单保留至 ${payDeadline}` : '请尽快登录 12306 完成支付',
    '—— 本系统不会自动支付，请人工确认订单',
  ].filter(Boolean);
  // 购票成功是关键消息，走加急（@所有人弹窗，蓝色卡片）
  return dispatch(userId, 'order_success', lines.join('\n'), { urgent: true });
}

/** 查重命中提醒（已购车票中已含目标车次，本次未实际下单） */
export function notifyDuplicatedOrder(params: {
  userId: string;
  planName: string;
  trainNumber: string;
  travelDate: string;
  passengers: string[];
  orderNo?: string;
  paid: boolean;
  payDeadline?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { userId, planName, trainNumber, travelDate, passengers, orderNo, paid, payDeadline } = params;
  if (paid) {
    // 已支付：纯信息同步，不扰民
    const lines = [
      '✅ 已购车票（已支付），本次跳过下单',
      `计划：${planName}`,
      `车次：${trainNumber}  乘车日期：${travelDate}`,
      `乘车人：${passengers.join('、')}`,
      orderNo ? `订单号：${orderNo}` : '',
    ].filter(Boolean);
    return dispatch(userId, 'duplicate_order', lines.join('\n'));
  }
  // 未支付：和真实下单一样需要用户去付款，走加急
  const lines = [
    'ℹ️ 已购同车次（未支付），本次跳过下单',
    `计划：${planName}`,
    `车次：${trainNumber}  乘车日期：${travelDate}`,
    `乘车人：${passengers.join('、')}`,
    orderNo ? `订单号：${orderNo}` : '',
    payDeadline ? `请尽快登录 12306 完成支付，订单保留至 ${payDeadline}` : '请尽快登录 12306 完成支付',
    '—— 若订单到期失效，系统会自动重新购票',
  ].filter(Boolean);
  return dispatch(userId, 'duplicate_order', lines.join('\n'), { urgent: true });
}

/** 会话失活告警（需求 3：发现失活通知用户） */
export function notifySessionInvalid(userId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  return dispatch(
    userId, 'session_invalid',
    ['⚠️ 12306 会话已失活', `原因：${reason}`, '请登录管理台重新完成验证码登录，否则将影响自动购票。'].join('\n'),
    { urgent: true },
  );
}

/** 任务失败告警 */
export function notifyTaskFailed(params: {
  userId: string;
  planName: string;
  travelDate: string;
  error: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { userId, planName, travelDate, error } = params;
  // 未支付订单拦截：用户需要去 12306 处理，给可执行的指引而不是"看日志"
  const blocked = error.includes('未支付订单') || error.includes('未完成订单');
  const lines = ['❌ 自动购票失败', `计划：${planName}`, `乘车日期：${travelDate}`, `失败原因：${error}`];
  if (blocked) {
    lines.push('👉 请打开 12306 APP 完成支付（或取消订单），系统会在订单处理后自动重试购票');
  } else {
    lines.push('请登录管理台查看日志并重试。');
  }
  return dispatch(userId, 'task_failed', lines.join('\n'), { urgent: true });
}
