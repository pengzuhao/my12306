/**
 * 12306 相关常量：URL、选择器、席别映射。
 * 12306 页面/接口会不定期调整，集中在此处便于维护。
 */

export const URLS = {
  // 直连新版登录页：/otn/login/init 会按会话状态返回旧版页面（#username/#password），
  // /otn/resources/login.html 稳定返回新版页面（#J-userName/#J-qrImg），扫码登录依赖它
  LOGIN: 'https://kyfw.12306.cn/otn/resources/login.html',
  LOGIN_LEGACY: 'https://kyfw.12306.cn/otn/login/init',
  LOGIN_UAM: 'https://kyfw.12306.cn/otn/login/loginUAM',
  AUTHENTICATE: 'https://kyfw.12306.cn/passport/web/authenticate',
  CAPTCHA_IMAGE: 'https://kyfw.12306.cn/passport/captcha/captcha-image64',
  CAPTCHA_CHECK: 'https://kyfw.12306.cn/passport/captcha/captcha-check',
  INDEX: 'https://kyfw.12306.cn/otn/index/init',
  MY12306: 'https://kyfw.12306.cn/otn/profile/initMy12306Api',
  CHECK_USER: 'https://kyfw.12306.cn/otn/login/checkUser',
  LEFT_TICKET_INIT: 'https://kyfw.12306.cn/otn/leftTicket/init',
  LEFT_TICKET_QUERY: 'https://kyfw.12306.cn/otn/leftTicket/queryZ',
  QUERY_SALE_TIME: 'https://kyfw.12306.cn/otn/leftTicket/querySaleTime',
  CONFIRM_INIT_DC: 'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
  CHECK_ORDER_INFO: 'https://kyfw.12306.cn/otn/confirmPassenger/checkOrderInfo',
  GET_QUEUE_COUNT: 'https://kyfw.12306.cn/otn/confirmPassenger/getQueueCount',
  CONFIRM_SINGLE: 'https://kyfw.12306.cn/otn/confirmPassenger/confirmSingleForQueue',
  RESULT_ORDER: 'https://kyfw.12306.cn/otn/confirmPassenger/resultOrderForQueue',
  PASSENGERS: 'https://kyfw.12306.cn/otn/passengers/query',
  STATION_NAME_JS: 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js',
  /** 未完成订单（未支付/待出票），用于下单前查重 */
  MY_ORDER_NO_COMPLETE: 'https://kyfw.12306.cn/otn/queryOrder/queryMyOrderNoComplete',
  /** 已完成订单（已支付/已出票），用于对账确认"真正买到" */
  MY_ORDER_COMPLETE: 'https://kyfw.12306.cn/otn/queryOrder/queryMyOrder',
} as const;

export const SELECTORS = {
  /** ---- 以下为真实 12306 登录页（/otn/resources/login.html）实测选择器 ---- */
  /** 账号登录：用户名/邮箱/手机号输入框 */
  username: '#J-userName',
  /** 账号登录：密码输入框（扫码登录不使用） */
  password: '#J-password',
  /** 账号登录：登录按钮（"立即登录"） */
  loginButton: '#J-login',
  /** 图形验证码输入框（账号登录） */
  captchaInput: '#code',
  /** 错误提示 */
  loginError: '.login-error, #error_msg, .err-msg, .error_msg',
  /** ---- 扫码登录（推荐：全程无密码） ---- */
  /** "扫码登录"页签 */
  qrLoginTab: 'a:has-text("扫码登录")',
  /** "账号登录"页签 */
  accountLoginTab: 'a:has-text("账号登录")',
  /** 二维码图片（src 为 data:image/jpg;base64,... 数据 URI） */
  qrImage: '#J-qrImg',
  /** 二维码刷新按钮 */
  qrRefresh: 'a:has-text("刷新")',
  /** ---- 通用 ---- */
  /** 余票页"预订"按钮 */
  bookButton: '.btn72, [id^="book_"]',
  /** 滑动验证（阿里 NoCaptcha） */
  slider: '#nc_1_n1z, .nc_iconfont.btn_slide',
  sliderBar: '#nc_1__scale_text',
} as const;

/** leftTicket 结果字符串中各席别的字段下标（queryZ 通用格式，2026-09-18 实测） */
export const SEAT_INDEX: Record<string, number> = {
  QT: 17, // 其他
  SWZ: 20, // 商务座（一等包厢）
  TZ: 21, // 特等座
  ZY: 22, // 一等座
  ZE: 23, // 二等座
  GR: 24, // 高级软卧
  RW: 25, // 软卧
  YW: 26, // 硬卧
  RZ: 27, // 软座
  YZ: 28, // 硬座
  WZ: 29, // 无座
};

export const SEAT_NAMES: Record<string, string> = {
  SWZ: '商务座',
  TZ: '特等座',
  ZY: '一等座',
  ZE: '二等座',
  GR: '高级软卧',
  RW: '软卧',
  YW: '硬卧',
  RZ: '软座',
  YZ: '硬座',
  WZ: '无座',
  QT: '其他',
};

/** result 字段下标（2026-09-18 实测真实格式） */
export const FIELD_INDEX = {
  secretStr: 0,
  buttonText: 1, // "预订" / "候补" / "起售"
  trainNo: 2, // 车次内部 ID（如 48000K835441）
  trainCode: 3, // 车次号（如 K8351）
  fromStation: 5,
  toStation: 6,
  departTime: 8,
  arriveTime: 9,
  duration: 10,
  isCanBuy: 11, // Y/N
  ypEx: 34,
} as const;

/** 证件类型代码 → 名称 */
export const ID_TYPE_NAMES: Record<string, string> = {
  '1': '二代身份证',
  '2': '一代身份证',
  C: '港澳通行证',
  G: '台湾通行证',
  P: '护照',
};
