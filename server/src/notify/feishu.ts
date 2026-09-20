/**
 * 飞书群机器人消息通道（需求 4）。
 *
 * 使用飞书自定义群机器人的 webhook 地址 + 签名校验（密钥）：
 *   POST <webhook_url>
 *   Header: Content-Type: application/json
 *   Body : { timestamp, sign, msg_type, content }
 *   sign = Base64(HMAC-SHA256(timestamp + "\n" + secret))
 *
 * 官方文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
import crypto from 'node:crypto';
import { FeishuRepo } from '../db/repo.js';
import { Logger } from '../logger.js';

const logger = new Logger('notify');

export interface FeishuMessage {
  /** @ 指定接收人（飞书用户 open_id / 手机号 / 邮箱，可空=群里所有人） */
  at?: string | string[];
  /** 加急：发送红色主题交互式卡片并 @所有人，强制手机端弹窗通知（飞书自定义机器人不支持加急消息类型） */
  urgent?: boolean;
}

function genSign(secret: string, timestamp: number): string {
  // 飞书官方算法：string_to_sign = timestamp + "\n" + secret，作为 HMAC key，消息为空
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', stringToSign);
  return hmac.digest('base64');
}

/**
 * 发送飞书文本消息。
 * @param userId 系统用户 ID（取其绑定的飞书配置）
 * @param text 消息内容
 * @param options.at 指定接收人
 */
export async function sendFeishu(
  userId: string,
  text: string,
  options: FeishuMessage = {},
): Promise<{ ok: boolean; error?: string }> {
  const cfg = FeishuRepo.get(userId);
  if (!cfg) return { ok: false, error: '尚未配置飞书 webhook' };
  if (!cfg.enabled) return { ok: false, error: '飞书通知已停用' };
  if (!cfg.webhookUrl?.startsWith('http')) return { ok: false, error: 'webhook 地址无效' };

  const timestamp = Math.floor(Date.now() / 1000);
  const at = options.at;
  const atList = at ? (Array.isArray(at) ? at : [at]).filter((x) => x.startsWith('+') || /^\d/.test(x)) : [];

  const body: Record<string, unknown> = {
    timestamp: String(timestamp),
  };
  if (cfg.secret) body.sign = genSign(cfg.secret, timestamp);

  if (options.urgent) {
    // 加急：红色主题交互式卡片 + @所有人，确保手机端一定能收到弹窗通知。
    // 飞书自定义群机器人不支持"加急"消息类型（仅支持 text/post/image/share_chat/interactive），
    // 卡片 lark_md 内嵌 <at id=all></at> 是 webhook 强制手机弹通知的唯一手段（需群开启"@所有人"）。
    const atAll = '<at id=all></at>\n';
    const atMd = atList.length ? atList.map((m) => `<at mobile=${m.replace(/^\+/, '')}></at>`).join(' ') + '\n' : '';
    body.msg_type = 'interactive';
    body.card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🎫 12306 购票提醒（加急）' },
        template: 'red',
      },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: atAll + atMd + text } }],
    };
  } else {
    body.msg_type = 'text';
    body.content = { text };
    if (atList.length) body.at = { atMobiles: atList, atUserIds: [] };
  }

  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { code?: number; msg?: string; StatusMessage?: string };
    // 飞书成功返回 { code: 0, msg: "success" }（旧版返回 { StatusMessage: "success" }）
    // 注意：HTTP 200 不代表成功——签名错误等也返回 200 + code:19021，
    // 不能用 res.ok 兜底，否则签名失败会被误判为"已发送"
    const ok = data.code === 0 || data.StatusMessage === 'success';
    if (!ok) {
      logger.warn('飞书消息发送失败', { status: res.status, code: data.code, msg: data.msg, user: userId });
      return { ok: false, error: `飞书返回 code=${data.code}：${data.msg ?? '未知错误'}（请检查 webhook 地址与签名密钥是否匹配）` };
    }
    logger.info('飞书消息已发送', { user: userId, urgent: Boolean(options.urgent) });
    return { ok: true };
  } catch (e) {
    logger.error('飞书消息发送异常', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  // 购票成功是关键消息，走加急（红色卡片）
  return sendFeishu(userId, lines.join('\n'), { urgent: true });
}

/** 会话失活告警（需求 3：发现失活通知用户） */
export function notifySessionInvalid(userId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  return sendFeishu(
    userId,
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
  return sendFeishu(userId, lines.join('\n'), { urgent: true });
}
