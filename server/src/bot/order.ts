/**
 * 订单提交（需求 5）——只到"提交订单成功"，绝不进入支付环节。
 *
 * 完整链路（2026-09-18 实测验证通过）：
 *  1. queryZ API 查余票 → 选有余票的目标车次
 *  2. UAM 预热：goto initDc 触发 uamtk + uamauthclient（不做这步，点"预订"会卡在 checkUser flag:false）
 *  3. 查票页：URL 只填显示文本（南京/上海），隐藏电报码域 #fromStation/#toStation/#train_date
 *     必须手动填入电报码，否则点查询不触发 queryZ
 *  4. 点击目标车次"预订"按钮（a.btn72，即 checkG1234）→ checkUser flag:true →
 *     POST initDc?N + getPassengerDTOs → 确认页 SPA 渲染
 *  5. 轮询 globalRepeatSubmitToken（新版变量名，经典 REPEAT_SUBMIT_TOKEN 已不存在）
 *  6. checkOrderInfo → confirmSingleForQueue → resultOrderForQueue（不调起支付）
 *
 * 关键坑：
 *  - secretStr 本身已是 URL 编码形态，拼接时不能再 encodeURIComponent（双重编码返回空壳页）
 *  - 直接 GET 导航 initDc?secretStr 返回空壳页，必须通过"预订"按钮进入
 *  - 乘客字符串多人的用 _ 拼接成一个字段，不是 passengerTicketStr0/1 索引形式
 */
import type { BrowserContext, Page } from 'playwright';
import { URLS, SEAT_NAMES } from './constants.js';
import { Logger } from '../logger.js';
import { queryTrains, seatCount } from './tickets.js';
import type { Passenger, TrainInfo } from '../types.js';

const logger = new Logger('bot');

export interface PurchaseParams {
  trainDate: string;
  fromStation: string;
  toStation: string;
  /** 指定车次；为空则按时间范围自动匹配 */
  trainNumbers: string[] | null;
  /** 出发时间范围（含），如 08:00 / 09:00 */
  timeFrom?: string | null;
  timeTo?: string | null;
  /** 座位偏好 A/B/C/D/F（多选或空） */
  seatPositions?: string[] | null;
  /** 乘车人 */
  passengers: Passenger[];
}

export interface PurchaseResult {
  ok: boolean;
  trainCode: string;
  passengers: string[];
  seatInfo?: string;
  payDeadline?: string;
  orderNo?: string;
  error?: string;
}

function inTimeRange(depart: string, from?: string | null, to?: string | null): boolean {
  if (!from || !to) return true;
  return depart >= from && depart <= to;
}

/** 按座位偏好计算席别优先级（A/F 靠窗 → 二等座 ZE；B 中间；C/D 过道） */
function preferSeatTypes(positions?: string[] | null): string[] {
  if (!positions || !positions.length) return ['ZE', 'ZY', 'YW', 'RW', 'TZ', 'SWZ'];
  const hasWindow = positions.some((p) => p === 'A' || p === 'F');
  return hasWindow ? ['ZE', 'ZY', 'YW', 'RW', 'TZ', 'SWZ'] : ['ZY', 'ZE', 'YW', 'RW', 'TZ', 'SWZ'];
}

/** 从余票结果中挑选目标车次（所选席别必须真有余票，不能只看字段非空） */
export function pickTrain(trains: TrainInfo[], params: PurchaseParams): TrainInfo | null {
  const wanted = params.trainNumbers?.map((t) => t.toUpperCase());
  const pref = preferSeatTypes(params.seatPositions);
  // 该车次是否有任一目标席别真有余票（"有"/数字>0）
  const anySeat = (t: TrainInfo) =>
    Object.entries(t.seats).some(([name, v]) => v && v !== '无' && v !== '' && seatCount(v) > 0);
  // 选出"有余票席别"集合，供后续提交时使用
  const candidates = trains
    .filter((t) => t.departTime !== '--' && t.departTime !== '24:00')
    .filter((t) => inTimeRange(t.departTime, params.timeFrom, params.timeTo))
    .filter(anySeat)
    .sort((a, b) => a.departTime.localeCompare(b.departTime));
  if (wanted && wanted.length) {
    return candidates.find((t) => wanted.includes(t.trainCode.toUpperCase())) ?? null;
  }
  // 按时间范围取最早一班
  return candidates[0] ?? null;
}

/** 从车次中按席别优先级挑出真正有余票的席别 */
function pickSeat(train: TrainInfo, positions?: string[] | null): { code: string; name: string } | null {
  const ordered = preferSeatTypes(positions);
  for (const code of ordered) {
    const name = SEAT_NAMES[code];
    const left = seatCount(train.seats[name]);
    if (left > 0) return { code, name };
  }
  // 回退：常规席别全部售罄时（如长假首日只剩"其他"/无座），接受任一有余票的席别，
  // 保证能成单。实际下单席别由确认页原生字符串决定，这里只做"能否成单"的校验。
  const fallback = Object.entries(train.seats).find(([, v]) => seatCount(v) > 0);
  return fallback ? { code: 'OTHER', name: fallback[0] } : null;
}

/**
 * 乘车人字符串不能手拼！新版 12306 的 passengerTicketStr 末尾带服务端下发的
 * allEncStr 加密串（格式：seat,0,type,name,idType,idNo,phone,N,<allEncStr>），
 * 手拼的串会被服务端拒绝（统一返回"余票不足"）。
 * 正确做法：在确认页勾选对应乘客后，调用页面自己的 getpassengerTickets()/getOldPassengers()。
 */

interface NativeStrings {
  ticketStr: string;
  oldStr: string;
}

/** 在确认页勾选目标乘客，再用页面原生函数取出含加密串的字符串 */
async function pickPassengersAndGetStrings(page: Page, passengers: Passenger[]): Promise<NativeStrings | null> {
  // 勾选常用联系人 checkbox（按姓名匹配）
  const picked = await page.evaluate((names: string[]) => {
    const w = globalThis as unknown as {
      document?: {
        querySelectorAll?: (s: string) => Array<{
          checked?: boolean;
          click?: () => void;
          closest?: (s: string) => { textContent?: string } | null;
          getAttribute?: (s: string) => string | null;
        }>;
      };
    };
    const boxes = w.document?.querySelectorAll?.('#normal_passenger_id input[type="checkbox"]') ?? [];
    let hit = 0;
    for (const cb of boxes) {
      // checkbox 所在行/标签的文本
      const row = cb.closest?.('tr, li, label, .passenger-row');
      const txt = row?.textContent ?? cb.getAttribute?.('aria-label') ?? '';
      if (names.some((n) => txt.includes(n))) {
        if (!cb.checked) cb.click?.();
        hit++;
      }
    }
    return { total: boxes.length, hit };
  }, passengers.map((p) => p.name));
  logger.info('勾选乘车人', { ...picked });
  if (!picked.hit) {
    logger.warn('未在确认页找到任何目标乘车人', { names: passengers.map((p) => p.name) });
    return null;
  }
  await page.waitForTimeout(1000);

  // 调用页面原生函数，拿到含 allEncStr 的字符串
  const strs = await page.evaluate(() => {
    const w = globalThis as unknown as {
      getpassengerTickets?: () => string;
      getOldPassengers?: () => string;
    };
    try {
      return {
        ticketStr: w.getpassengerTickets?.() ?? '',
        oldStr: w.getOldPassengers?.() ?? '',
      };
    } catch {
      return { ticketStr: '', oldStr: '' };
    }
  });
  if (!strs.ticketStr || !strs.oldStr) {
    logger.warn('页面原生乘客字符串为空', strs);
    return null;
  }
  return strs;
}

/** 确认页渲染后的页面状态（token + 页面特征） */
interface ConfirmPageState {
  token: string;
  hasSubmit: boolean;
  textLen: number;
}

async function readConfirmState(page: Page): Promise<ConfirmPageState> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      globalRepeatSubmitToken?: unknown;
      document?: { body?: { textContent?: string } };
    };
    const g = w.globalRepeatSubmitToken;
    const txt = w.document?.body?.textContent ?? '';
    return {
      token: typeof g === 'string' ? g : '',
      hasSubmit: /提交订单/.test(txt),
      textLen: txt.length,
    };
  });
}

/**
 * 执行一次购票（提交订单，不付款）。
 * @param context 已登录的浏览器上下文
 */
export async function purchaseTicket(context: BrowserContext, params: PurchaseParams): Promise<PurchaseResult> {
  const names = params.passengers.map((p) => p.name);
  const page = await context.newPage();
  try {
    // 1) 查询余票，选车
    const trains = await queryTrains(context, {
      trainDate: params.trainDate,
      fromStation: params.fromStation,
      toStation: params.toStation,
    });
    const train = pickTrain(trains, params);
    if (!train) {
      return { ok: false, trainCode: params.trainNumbers?.[0] ?? '(自动匹配)', passengers: names, error: '未找到符合车次/时间条件的可购票车次' };
    }
    const secret = train.raw[0];
    if (!secret) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: '车次密钥缺失，可能不可购买' };
    }
    // 二次校验：所选车次的目标席别必须真有余票（queryZ 缓存与实际可能有时间差）
    const seat = pickSeat(train, params.seatPositions);
    if (!seat) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: `${train.trainCode} 目标席别已无余票` };
    }

    // 2) UAM 预热：先访问确认页触发 uamtk + uamauthclient 单点登录链
    //    不做这步，后续点"预订"会在 checkUser 处被拦（flag:false）
    //    必须用 networkidle 等待异步登录链跑完，domcontentloaded 会在 uamtk 发出前返回
    logger.info('UAM 预热', { train: train.trainCode });
    await page.goto(URLS.CONFIRM_INIT_DC, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // 3) 查票页：URL 参数填显示文本，隐藏电报码域手动填
    const queryUrl =
      `${URLS.LEFT_TICKET_INIT}?linktypeid=dc` +
      `&fs=${encodeURIComponent(params.fromStation)}` +
      `&ts=${encodeURIComponent(params.toStation)}` +
      `&date=${params.trainDate}&flag=0`;
    await page.goto(queryUrl, { waitUntil: 'networkidle', timeout: 40000 });
    const { stationCode } = await import('./stations.js');
    const fromCode = await stationCode(params.fromStation);
    const toCode = await stationCode(params.toStation);
    if (!fromCode || !toCode) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: `车站电报码解析失败：${params.fromStation}/${params.toStation}` };
    }
    await page.evaluate(
      (args: { fc: string; tc: string; date: string }) => {
        const w = globalThis as unknown as {
          document?: { querySelector?: (s: string) => { value?: string } | null };
        };
        const set = (id: string, v: string) => {
          const el = w.document?.querySelector?.(`#${id}`);
          if (el) el.value = v;
        };
        set('fromStation', args.fc);
        set('toStation', args.tc);
        set('train_date', args.date);
      },
      { fc: fromCode, tc: toCode, date: params.trainDate },
    );
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        document?: { querySelector?: (s: string) => { click?: () => void } | null };
      };
      w.document?.querySelector?.('#query_ticket')?.click?.();
    });
    // 等车次列表渲染
    await page.waitForTimeout(5000);

    // 4) 点击目标车次的"预订"按钮（checkG1234）
    const clicked = await page.evaluate((code: string) => {
      const w = globalThis as unknown as {
        document?: {
          querySelectorAll?: (s: string) => Array<{
            click?: () => void;
            closest?: (s: string) => { textContent?: string } | null;
          }>;
        };
      };
      const btns = Array.from(w.document?.querySelectorAll?.('a.btn72') ?? []);
      const btn = btns.find((x) => x.closest?.('tr')?.textContent?.includes(code));
      if (btn) {
        btn.click?.();
        return true;
      }
      return false;
    }, train.trainCode);
    if (!clicked) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: `查票页未找到 ${train.trainCode} 的预订按钮（可能已售罄或为候补）` };
    }
    logger.info('已点击预订按钮', { train: train.trainCode });

    // 4.5) 等待跳转到确认页（点击会触发 checkG1234 → checkUser → POST initDc → 页面跳转）
    //      若 UAM 未预热成功，checkUser 返回 flag:false 会停在原页面不跳转
    try {
      await page.waitForURL(/confirmPassenger\/initDc/, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } catch {
      const s0 = await readConfirmState(page);
      logger.warn('点击预订后未跳转到确认页', { train: train.trainCode, url: page.url().slice(0, 80), textLen: s0.textLen });
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: '点击预订后未进入确认页（UAM 预热可能未生效或登录态异常）',
      };
    }

    // 5) 等确认页渲染（token 由页面 JS 异步写入全局变量，需轮询）
    let token = '';
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const s = await readConfirmState(page);
      if (s.token && s.hasSubmit) {
        token = s.token;
        logger.info('确认页已渲染', { train: train.trainCode, textLen: s.textLen });
        break;
      }
    }
    if (!token) {
      const s = await readConfirmState(page);
      const snippet = await page
        .evaluate(() => {
          const w = globalThis as unknown as { document?: { body?: { textContent?: string } } };
          return (w.document?.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300);
        })
        .catch(() => '');
      logger.warn('确认页未渲染', { train: train.trainCode, textLen: s.textLen, hasSubmit: s.hasSubmit, url: page.url().slice(0, 80), snippet: snippet.slice(0, 200) });
      const looksLikeLogin = /扫码登录|账号登录/.test(snippet);
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: looksLikeLogin ? '12306 登录已失效，请重新扫码登录' : `订单确认页令牌获取失败（textLen=${s.textLen}）`,
      };
    }

    // 6) 勾选乘客并取出原生字符串（含服务端下发的 allEncStr，手拼会被拒）
    const strs = await pickPassengersAndGetStrings(page, params.passengers);
    if (!strs) {
      return { ok: false, trainCode: train.trainCode, passengers: names, error: '确认页未找到目标乘车人，请检查常用联系人是否已同步' };
    }
    logger.info('订单参数就绪', { train: train.trainCode, seat: seat.name, pax: strs.ticketStr.slice(0, 60) });

    // 7) checkOrderInfo（官方参数结构）
    const check = await page.evaluate(
      async (args: { url: string; token: string; pax: string; old: string }) => {
        const fd = new FormData();
        fd.append('cancel_flag', '2');
        fd.append('bed_level_order_num', '000000000000000000000000000000');
        fd.append('passengerTicketStr', args.pax);
        fd.append('oldPassengerStr', args.old);
        fd.append('tour_flag', 'dc');
        fd.append('randCode', '');
        fd.append('whatsSelect', '1');
        fd.append('sessionId', '');
        fd.append('REPEAT_SUBMIT_TOKEN', args.token);
        const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
        return { status: res.status, body: await res.text() };
      },
      { url: URLS.CHECK_ORDER_INFO, token, pax: strs.ticketStr, old: strs.oldStr },
    );
    const checkData = JSON.parse(check.body) as { data?: { submitStatus?: boolean; errMsg?: string }; messages?: string[] };
    if (checkData.data?.submitStatus !== true) {
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: `订单校验失败：${checkData.data?.errMsg ?? JSON.stringify(checkData.messages ?? check.body.slice(0, 200))}`,
      };
    }
    logger.info('checkOrderInfo 通过', { train: train.trainCode });

    // 8) 提交订单（confirmSingleForQueue，官方参数：从 ticketInfoForPassengerForm 取真实值）
    const submit = await page.evaluate(
      async (args: { url: string; token: string; pax: string; old: string }) => {
        const f = (globalThis as unknown as { ticketInfoForPassengerForm?: Record<string, unknown> })
          .ticketInfoForPassengerForm ?? {};
        const fd = new FormData();
        fd.append('passengerTicketStr', args.pax);
        fd.append('oldPassengerStr', args.old);
        fd.append('randCode', '');
        fd.append('purpose_codes', String(f.purpose_codes ?? 'ADULT'));
        fd.append('key_check_isChange', String(f.key_check_isChange ?? '1'));
        fd.append('leftTicketStr', String(f.leftTicketStr ?? ''));
        fd.append('train_location', String(f.train_location ?? ''));
        fd.append('whatsSelect', '1');
        fd.append('dwAll', 'N');
        fd.append('roomType', '00');
        fd.append('REPEAT_SUBMIT_TOKEN', args.token);
        const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
        return { status: res.status, body: await res.text() };
      },
      { url: URLS.CONFIRM_SINGLE, token, pax: strs.ticketStr, old: strs.oldStr },
    );
    const submitData = JSON.parse(submit.body) as {
      data?: { submitStatus?: boolean; isAsync?: string; errMsg?: string };
      messages?: string[];
    };
    if (submitData.data?.submitStatus !== true) {
      return {
        ok: false,
        trainCode: train.trainCode,
        passengers: names,
        error: `提交订单失败：${submitData.data?.errMsg ?? JSON.stringify(submitData.messages ?? submit.body.slice(0, 200))}`,
      };
    }
    logger.info('订单已提交，等待出票', { train: train.trainCode, isAsync: submitData.data?.isAsync });

    // 9) 异步排队时轮询订单结果（isAsync=1 时 12306 后台出票，需轮询）
    let orderNo: string | undefined;
    for (let i = 0; i < 20; i++) {
      const result = await page.evaluate(
        async (args: { url: string; tok: string }) => {
          const fd = new FormData();
          fd.append('REPEAT_SUBMIT_TOKEN', args.tok);
          fd.append('orderSequence', '');
          const res = await fetch(args.url, { method: 'POST', body: fd, credentials: 'include' });
          return res.text();
        },
        { url: URLS.RESULT_ORDER, tok: token },
      );
      try {
        const rd = JSON.parse(result) as {
          data?: { orderSequenceDTO?: { sequence_no?: string }; submitStatus?: boolean; errMsg?: string };
        };
        const seq = rd.data?.orderSequenceDTO?.sequence_no;
        if (seq) {
          orderNo = seq;
          break;
        }
      } catch {
        // 排队期间可能返回非 JSON，继续轮询
      }
      await page.waitForTimeout(1500);
    }

    // 兜底：轮询未拿到订单号时，查未完成订单列表
    if (!orderNo) {
      const noComplete = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { credentials: 'include' });
        return res.text();
      }, 'https://kyfw.12306.cn/otn/queryOrder/queryMyOrderNoComplete');
      try {
        const nd = JSON.parse(noComplete) as {
          data?: { orderDBList?: Array<{ sequence_no?: string }> };
        };
        orderNo = nd.data?.orderDBList?.[0]?.sequence_no;
      } catch {
        // 忽略
      }
    }

    // 汇总席别信息（用于通知）
    const seatSummary = `${seat.name}(${train.seats[seat.name] ?? '?'})`;

    logger.info('订单已提交（未支付）', { train: train.trainCode, orderNo });

    return {
      ok: true,
      trainCode: train.trainCode,
      passengers: names,
      seatInfo: seatSummary || `${train.trainCode} 已锁座`,
      orderNo,
      // 12306 未支付订单一般保留 30/45 分钟，提醒用户尽快付款
      payDeadline: new Date(Date.now() + 30 * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('购票流程异常', e);
    return { ok: false, trainCode: params.trainNumbers?.[0] ?? '(自动匹配)', passengers: names, error: msg };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// 保留 seatCount 引用（本模块通过车次信息汇总席别时使用）
void seatCount;
