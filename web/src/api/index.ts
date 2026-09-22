import axios from 'axios';

export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// ---- 乘车人 ----
export const passengerApi = {
  list: () => http.get('/passengers').then((r) => r.data),
  save: (data: Record<string, unknown>) => http.post('/passengers', data).then((r) => r.data),
  remove: (id: string) => http.delete(`/passengers/${id}`).then((r) => r.data),
};

// ---- 计划详情：推算日期 + 关联任务执行历史 ----
export interface TaskSnapshot {
  id: string;
  travelDate: string;
  trainNumber: string | null;
  /** 起售时刻（ISO） */
  saleAt: string | null;
  status: string;
  attempts: number;
  error: string | null;
  result: { trainCode?: string; seatInfo?: string; orderNo?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlanDateEntry {
  travelDate: string;
  originalDate: string;
  weekday: number;
  postponed: boolean;
  isWorkday: boolean;
  note?: string;
  /** 该年放假安排尚未公布，按自然周降级推算 */
  calendarPending?: boolean;
  estimatedSaleDate: string;
  /** 关联的购票任务（可能还没生成） */
  task: TaskSnapshot | null;
}

// ---- 计划 ----
export interface PlanForm {
  id?: string;
  name: string;
  fromStation: string;
  toStation: string;
  dateMode: 'single' | 'recurring' | 'workweek';
  travelDate: string | null;
  weekday: number | null;
  weekEdge: 'start' | 'end' | null;
  weekInterval: number;
  offsetDays: number;
  validFrom: string;
  validUntil: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  trainNumbers: string[] | null;
  seatPositions: string[] | null;
  /** 席别（必选多选）：订票时严格按所选席别匹配，不回退未选席别 */
  seatTypes: string[];
  /** 是否允许购买无座票（默认 false：不买站票，除非明确勾选） */
  allowNoSeat: boolean;
  passengerIds: string[];
}

export const planApi = {
  list: () => http.get('/plans').then((r) => r.data),
  save: (data: PlanForm) => http.post('/plans', data).then((r) => r.data),
  setStatus: (id: string, status: 'active' | 'paused' | 'deleted') =>
    http.post(`/plans/${id}/status`, { status }).then((r) => r.data),
  previewDates: (data: PlanForm) => http.post('/plans/preview-dates', data).then((r) => r.data),
  dates: (id: string) => http.get(`/plans/${id}/dates`).then((r) => r.data as PlanDateEntry[]),
  stations: (keyword: string) => http.get('/stations', { params: { keyword } }).then((r) => r.data),
};

// ---- 会话（扫码登录，不保存密码） ----
export const sessionApi = {
  state: () => http.get('/session').then((r) => r.data),
  login: () => http.post('/session/login').then((r) => r.data),
  cancelLogin: () => http.post('/session/cancel-login').then((r) => r.data),
  check: () => http.post('/session/check').then((r) => r.data),
  logout: () => http.post('/session/logout').then((r) => r.data),
  syncPassengers: () => http.post('/session/sync-passengers').then((r) => r.data),
};

// ---- 节假日日历（供两个日历标记节假日/调休补班） ----
export interface HolidayDay {
  date: string;
  isWorkday: boolean;
  holiday: string | null;
}

/** 节假日日历响应：days 为日期列表，calendarPending 表示该年放假安排尚未发布（按自然周兜底） */
export interface HolidayResponse {
  days: HolidayDay[];
  /** 该年放假安排尚未公布，工作日判定退回自然周；数据就绪后后端会自动重算 */
  calendarPending: boolean;
}

export const calendarApi = {
  /** 指定年月，返回该月每天的节假日信息 */
  holidays: (year: number, month: number) =>
    http.get('/calendar/holidays', { params: { year, month } }).then((r) => r.data as HolidayResponse),
  /** 指定自然年，返回全年 12 个月的节假日信息（供前端按年缓存，切月份时零延迟） */
  holidaysOfYear: (year: number) =>
    http.get('/calendar/holidays', { params: { year } }).then((r) => r.data as HolidayResponse),
};

// ---- 席别与车次（从 12306 透传，不在前端写死） ----
export interface SeatTypeOption {
  code: string;
  name: string;
}

export interface TrainOption {
  trainCode: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  /** 该车次余票里出现的席别代码列表 */
  seatTypes: string[];
  /** 各席别余票文本（席别中文名 → 余票数量/「有」「无」） */
  seats?: Record<string, string>;
}

export const metaApi = {
  seatTypes: () => http.get('/meta/seat-types').then((r) => r.data as SeatTypeOption[]),
  trains: (from: string, to: string, date: string) =>
    http.get('/trains/search', { params: { from, to, date } }).then((r) => r.data as { trains: TrainOption[] }),
};

// ---- 飞书 ----
export const feishuApi = {
  get: () => http.get('/feishu').then((r) => r.data),
  save: (data: { webhookUrl: string; secret: string | null; enabled: boolean; remark?: string | null }) =>
    http.post('/feishu', data).then((r) => r.data),
  test: () => http.post('/feishu/test').then((r) => r.data),
};

// ---- 任务与日志 ----
export const taskApi = {
  list: () => http.get('/tasks').then((r) => r.data),
};

// ---- 已购车票（已支付 + 待支付） ----
export interface OrderRow {
  orderNo: string;
  /** unpaid=待支付；paid=已支付/已出票/已出站；refunded=已退票 */
  status: 'unpaid' | 'paid' | 'refunded';
  statusText: string;
  /** 乘车日期+上车时间（北京时间 YYYY-MM-DD HH:mm） */
  travelDateTime: string;
  trainCode: string;
  fromStation: string;
  toStation: string;
  passengers: string[];
  seats: string[];
  totalPrice: number | null;
  /** 支付截止时间（北京时间字符串） */
  payLimitTime: string | null;
  /** 支付截止时间戳（毫秒），前端据此做「确定刷新节点」 */
  payLimitTs: number | null;
}

export interface OrdersResponse {
  orders: OrderRow[];
  fetchedAt: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

export const ordersApi = {
  list: () => http.get('/orders').then((r) => r.data as OrdersResponse),
};

export const logApi = {
  list: (limit = 100) => http.get('/logs', { params: { limit } }).then((r) => r.data),
};

/** WebSocket 实时通道（日志/会话/任务/扫码二维码） */
export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${location.host}/ws`;
  }

  connect(handlers: {
    onLog?: (m: unknown) => void;
    onSession?: (m: unknown) => void;
    onTask?: (m: unknown) => void;
    onQrCode?: (m: { image: string; status?: string }) => void;
  }): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; payload: unknown };
        if (msg.type === 'log') handlers.onLog?.(msg.payload);
        if (msg.type === 'session') handlers.onSession?.(msg.payload);
        if (msg.type === 'task') handlers.onTask?.(msg.payload);
        if (msg.type === 'qr_code') handlers.onQrCode?.(msg.payload as { image: string; status?: string });
      } catch {
        // ignore
      }
    };
    this.ws.onclose = () => {
      // 断线 3 秒后重连
      setTimeout(() => this.connect(handlers), 3000);
    };
  }

  sendQrCancel(): void {
    this.ws?.send(JSON.stringify({ type: 'qr_cancel', payload: null }));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
