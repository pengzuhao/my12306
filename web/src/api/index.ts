import axios from 'axios';

export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('my12306_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('my12306_token');
      if (location.hash !== '#/login') location.hash = '#/login';
    }
    return Promise.reject(err);
  },
);

// ---- 认证 ----
export const authApi = {
  login: (username: string, password: string) =>
    http.post('/auth/login', { username, password }).then((r) => r.data),
  me: () => http.get('/auth/me').then((r) => r.data),
  changePassword: (oldPassword: string, newPassword: string) =>
    http.post('/auth/change-password', { oldPassword, newPassword }).then((r) => r.data),
  listUsers: () => http.get('/users').then((r) => r.data),
  createUser: (data: { username: string; password: string; role: string; displayName?: string }) =>
    http.post('/users', data).then((r) => r.data),
  deleteUser: (id: string) => http.delete(`/users/${id}`).then((r) => r.data),
};

// ---- 乘车人 ----
export const passengerApi = {
  list: () => http.get('/passengers').then((r) => r.data),
  save: (data: Record<string, unknown>) => http.post('/passengers', data).then((r) => r.data),
  remove: (id: string) => http.delete(`/passengers/${id}`).then((r) => r.data),
};

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
  dates: (id: string) => http.get(`/plans/${id}/dates`).then((r) => r.data),
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

  constructor(token: string) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${location.host}/ws?token=${token}`;
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
