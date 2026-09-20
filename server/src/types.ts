/** 系统用户（管理台账号） */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  displayName: string;
}

export type UserRole = 'admin' | 'user';

export type RailwayAccountStatus = 'none' | 'logging_in' | 'active' | 'invalid' | 'logged_out';

export interface Passenger {
  id: string;
  userId: string;
  name: string;
  /** 证件类型代码：1=二代身份证，2=一代身份证，C=港澳通行证，G=台湾通行证，P=护照 */
  idTypeCode: string;
  idNo: string;
  phone: string | null;
  passengerType: string; // 成人 | 学生 | 儿童
  source: 'manual' | '12306';
  createdAt: string;
}

export interface FeishuConfig {
  id: string;
  userId: string;
  webhookUrl: string;
  secret: string | null;
  enabled: boolean;
  remark: string | null;
  createdAt: string;
}

/** 购票计划 */
export interface Plan {
  id: string;
  userId: string;
  name: string;
  status: 'active' | 'paused' | 'deleted';
  fromStation: string;
  toStation: string;
  dateMode: 'single' | 'recurring' | 'workweek';
  /** single 模式的具体乘车日期 YYYY-MM-DD */
  travelDate: string | null;
  /** recurring 模式：1=周一 .. 7=周日 */
  weekday: number | null;
  /** workweek 模式：start=工作周开始（首个工作日） / end=工作周结束（最后一个工作日），按工作日历推算 */
  weekEdge: 'start' | 'end' | null;
  /** 每隔几周（默认 1） */
  weekInterval: number;
  /** 相对推算日的偏移天数：负=提前（如 -1 提前一天，周日出发而非周一），正=延后 */
  offsetDays: number;
  validFrom: string;
  validUntil: string | null;
  /** 出发时间范围，如 08:00 / 09:00 */
  timeFrom: string | null;
  timeTo: string | null;
  /** 具体车次列表（可空 = 按时间范围自动匹配） */
  trainNumbers: string[] | null;
  /** 座位偏好 A/B/C/D/F（可空 = 不指定） */
  seatPositions: string[] | null;
  /**
   * 是否允许购买无座票（默认 false）。
   * 用户明确要求：除非计划里勾选了"允许无座"，否则不要买无座票——
   * 无座票虽然能成单，但站几小时不符合预期，让它失败告警比悄悄买下更好。
   */
  allowNoSeat: boolean;
  passengerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | 'pending' // 待查询起售时间
  | 'queried' // 已知起售时间，待到点触发
  | 'queued' // 已进入触发队列
  | 'running' // 机器人执行中
  | 'success' // 购票成功（未支付）
  | 'failed'
  | 'cancelled';

export interface Task {
  id: string;
  planId: string;
  planDateId: string | null;
  userId: string;
  travelDate: string;
  trainNumber: string | null;
  /** 起售时间（ISO，到点触发购买——不是按出发时间） */
  saleAt: string | null;
  status: TaskStatus;
  result: Record<string, unknown> | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 车站基础信息 */
export interface Station {
  code: string;
  name: string;
  pinyin: string;
  abbr: string;
}

/** 余票查询结果中的单个车次 */
export interface TrainInfo {
  trainCode: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  /** 各席别余票：key=席别代码（如 SWZ 一等座... 见 SEAT_CODES），value=余票数量字符串（'无'/'有'/'数字'） */
  seats: Record<string, string>;
  raw: string[];
}

/** 12306 会话状态快照 */
export interface SessionState {
  userId: string;
  status: RailwayAccountStatus;
  loggedIn: boolean;
  userName: string | null;
  lastCheckAt: string | null;
  lastLoginAt: string | null;
  failReason: string | null;
}
