> Windows / macOS 独立桌面版、托盘、开机启动与安装包构建：[桌面版说明](desktop/README.md)。原有服务版继续可用。

# my12306

TypeScript / Fastify / Vue 3 实现的 12306 购票管理台。支持车票日历、余票查询、周期购票计划和多通道通知。自动购票成功后由用户在 12306 完成支付。

## 启动

```sh
npm install
npx playwright install chromium
./start.sh build
./start.sh
```

访问 `http://127.0.0.1:7788`。默认是本地单用户模式，无需管理台密码；点击顶栏「连接 12306」，使用 12306 APP 扫码。登录后点击账号菜单可检查连接、同步乘车人或断开账号。

`./start.sh -d` 后台启动，`./start.sh stop` 停止，`./start.sh restart` 后台重启。修改代码后执行 `./start.sh build` 再重启。需要与本机 `better-sqlite3` ABI 匹配的 Node.js，建议使用 Node 22 或更新版本。

## 可选管理员模式

首次启动前设置以下环境变量（密码至少 12 字符，最多 72 字节）：

```sh
export MY12306_ADMIN_USER=admin
# 安全地设置 MY12306_ADMIN_PASSWORD，不要将真实密码提交到仓库。
# 例如 Bash 中隐藏输入：
read -rs -p '初始管理员密码: ' MY12306_ADMIN_PASSWORD
export MY12306_ADMIN_PASSWORD
./start.sh --multi-user
```

也可设置 `MY12306_MULTI_USER=1` 后使用原有启动命令。**每次启动都需要此开关**；首次初始化后可移除密码环境变量，后续启动不会覆盖已有密码。没有默认管理台密码。

管理员可创建用户、调整显示名称和角色、重置密码、停用与启用账号；不能停用或降级自己。所有用户均可在顶栏管理台账号菜单修改自己的密码。停用、编辑权限或重置密码后原登录失效；停用用户不再执行后续任务。已提交给 12306 的订单仍需在 12306 处理。

计划、乘车人、车票查询、12306 会话、通知配置按用户隔离。管理员可以查询全部过程日志，但不冒用其他用户的 12306 登录。管理台使用服务端会话及 HttpOnly / SameSite=Strict Cookie，7 天过期；WebSocket 复用 Cookie 鉴权，URL 不携带令牌。

首次启用时保留本地用户的数据及 12306 登录态并归属初始管理员。两种模式之间切换**不会合并、删除其他用户的数据**。切回单用户后只执行内置用户的计划。

## 购票、日志和图片分享

- 在「购票计划」选择乘车人、车站、日期规则、车次、席别与时间范围。工作周规则根据节假日与调休推算，可先预览日期。
- 根据起售时间触发任务，暂停计划会阻止后续购票。购票成功后不会自动付款。
- 「过程日志」支持级别、分类、关键词、时间范围查询，管理员还可筛选用户。默认每页 30 条，可一键导出筛选结果 CSV（最多 5 万条，请按日期分批）。导出时间为北京时间。API `/api/logs/export?format=json` 也可下载 JSON。
- 记录、展示和导出时隐藏密钥、链接、手机号、证件字段。日志保存在 SQLite 中，无自动清理策略。
- 日历「分享日历」、已购车票「分享到微信」、车票详情均可生成 PNG 图片。图片在浏览器本地生成，默认隐藏乘车人和座位；订单号、证件号与手机号不进入图片。
- 保存 PNG 后在微信中选择发送，或在支持文件分享的浏览器中使用「系统分享」。是否出现微信由设备与浏览器决定；不依赖微信 JS SDK，也不会自动向微信发送消息。

## 五种通知通道

在「通知通道」中添加一个或多个通道，选择接收购票成功、已有车票查重、登录失效和购票失败事件。支持独立启停、编辑、删除与发送测试。旧飞书配置首次启动时自动迁移一次；新配置不会回显密钥，编辑时留空表示保留，可显式清除可选密钥。

| 通道 | 配置 |
| --- | --- |
| 飞书 | 自定义群机器人 Webhook，可选签名密钥 |
| 企业微信 | 群机器人 Webhook |
| 钉钉 | 自定义机器人 Webhook，可选加签密钥 |
| Telegram | Bot Token 和 Chat ID；用户先发送 `/start` 或将机器人加入群组 |
| 通用 Webhook | 公网 HTTPS 地址，可选 Bearer Token |

通用 Webhook 收到 `{ source: "my12306", event, text, urgent, timestamp }` JSON；HTTP 2xx 视为成功。其他平台还检查响应中的业务成功码。每通道独立发送，某通道失败不会阻止其他通道；页面和日志记录发送结果。不会自动重试通知，避免重复消息。

地址必须为标准 443 端口的 HTTPS，发送时固定解析到的公网 IPv4，不允许内网、本机地址和重定向。仅 IPv6 的 Webhook 暂不支持。平台若启用关键词，请允许 `12306`，签名密钥与平台配置保持一致。购票成功等紧急消息在飞书、企业微信和钉钉尝试群内 @所有人，实际提醒效果由平台和群权限决定。

设计参考 [AstrBot 的 Platform 抽象](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/platform.py) 中的通道分离思路。本项目独立实现 TypeScript 发送适配器，没有引入 AstrBot、模型、LLM 或插件运行时。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MY12306_PORT` / `PORT` | `7788` | 后端端口 |
| `MY12306_HOST` | `127.0.0.1` | 监听地址 |
| `MY12306_MULTI_USER` | `0` | 设置为 `1` 启用管理台鉴权与用户管理 |
| `MY12306_ADMIN_USER` | `admin` | 首次启用时管理员名，3–40 位字母、数字、点、下划线或短横线 |
| `MY12306_ADMIN_PASSWORD` | 无 | 首次启用的管理员密码 |
| `MY12306_SECURE_COOKIE` | `0` | HTTPS 反向代理部署时设 `1`，Cookie 只通过 HTTPS 发送 |
| `MY12306_DATA_DIR` | `server/data` | SQLite、浏览器 profile、会话与节假日缓存 |
| `MY12306_NO_OPEN` | `0` | 启动脚本不自动打开浏览器 |
| `MY12306_PRESALE_DAYS` | `14` | 起售查询的兜底预售期 |
| `MY12306_PRE_TRIGGER_MS` | `3000` | 调度提前量 |
| `MY12306_HEADLESS` | `true` | 无头浏览器开关 |

远程多用户部署应启用管理员模式并通过 HTTPS 反向代理访问，代理须保留原始 Host 并转发 WebSocket。设置 `MY12306_SECURE_COOKIE=1`。默认单用户模式用于本机访问。运行数据包含登录态和通知密钥，位于 gitignored 的数据目录，不应提交仓库或公开。

## 开发与验证

```sh
npm run dev:server
npm run dev:web
npm run build:server
npm run build:web
npm test
npm run test:regression
npm run test:features
# 独立 UI 测试服务：模拟车票，无调度器，无真实通知
node --import tsx server/src/__test__/ui-fixture.ts
```

日期引擎测试可能读取公开节假日源；新增回归与功能测试使用独立临时数据库和模拟通知响应。测试范围见 [TESTING.md](TESTING.md)。

请遵守 12306 的使用规则；自动化不会付款，支付与订单确认仍由用户在 12306 完成。
