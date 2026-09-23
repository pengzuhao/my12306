# my12306 桌面版与服务部署

同一份业务代码可以作为独立服务运行，也可以打包为 Windows / macOS 桌面应用。桌面安装包包含 Electron（Node 运行时）、前后端、SQLite 原生模块和 Playwright Chromium Headless Shell，使用者无需安装 Node 或浏览器。桌面只携带后台所需的无头浏览器及中英文界面资源，macOS DMG 使用 LZFSE 压缩。

## 使用桌面版

- macOS：打开 DMG，把 my12306 拖到「应用程序」后启动。
- Windows：运行 NSIS `.exe` 安装程序，默认安装到当前用户目录，无需管理员权限。
- 首次使用，在应用中扫码连接 12306。
- 顶栏「桌面设置」或托盘菜单可开启「登录电脑后自动启动」。默认关闭；开启后下次登录电脑时在后台启动。macOS 如果显示「需要批准」，到系统设置 → 通用 → 登录项允许。
- 关闭窗口会留在托盘，购票计划、会话保活、通知继续运行；托盘菜单「退出 my12306」会先保存会话，再停止后台服务。电脑休眠、关机或未登录期间，桌面版不能执行任务；需要全天在线请部署服务版。
- 桌面设置和托盘菜单都有「后台运行」入口。后台时隐藏主窗口及 macOS Dock / Windows 任务栏图标，保留菜单栏 / 托盘图标；点击即可恢复窗口。开机自启默认后台运行，无需额外配置；重复的后台启动请求不会弹窗，手动打开应用则恢复窗口。命令行也可通过 `--background` 启动到后台（开发模式：`npm run desktop:start -- --background`）。
- 多次打开只显示已有窗口。桌面界面与后台通过私有 IPC 通信，不监听 HTTP/WebSocket 端口；独立服务版继续使用 7788 端口。
- 个人桌面版默认单用户。管理员、多用户部署继续使用服务版启动选项。

### 数据和迁移

桌面设置可以打开数据目录。默认位置为 macOS `~/Library/Application Support/my12306/data`、Windows `%APPDATA%/my12306/data`；实际路径以设置页面为准。启动诊断日志 `desktop.log` 在其上一级目录，过程日志仍可在页面查询、导出。

桌面数据与仓库 `server/data` 分开，升级不会把个人数据写进安装包；Windows 卸载默认保留数据。需要把现有服务迁到桌面时，先停止服务并退出桌面应用、备份双方目录，再把服务的整个数据目录内容复制到桌面数据目录，重新启动后检查 12306 登录态。不要让两个运行实例共用一个数据库或浏览器 profile，也不要同时运行同一套自动购票计划。

## 本地开发和构建

构建机器需要 Node >=22.12（建议 24 LTS）、npm，服务依赖没有匹配的预编译模块时，还需原生构建工具（macOS Xcode Command Line Tools；Windows Visual Studio C++ Build Tools 和 Python）。

```sh
npm ci
npm run desktop:install
npm run desktop:prepare
npm run desktop:start
```

若 Electron 官方下载较慢，可按 [官方镜像说明](https://www.electronjs.org/docs/latest/tutorial/installation#mirror) 为构建命令设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 和 `ELECTRON_CUSTOM_DIR={{ version }}`，保留默认官方校验和验证。

`desktop:prepare` 构建前后端、下载当前平台 Chromium，桌面使用 SQLite 13 自带的 Node-API 原生模块，打包禁用工作区原生模块重建，保留服务版的独立 SQLite。

```sh
npm --prefix desktop run smoke
npm run desktop:pack
npm --prefix desktop run smoke -- --packaged
npm run desktop:dist:unsigned  # 不使用开发者证书，不提交公证
# npm run desktop:dist:signed  # 正式签名，macOS 同时要求公证凭据
```

### 选择签名模式

| 命令 | 行为 |
| --- | --- |
| `npm run desktop:dist:unsigned` | 强制跳过 macOS 开发者签名、公证和 Windows 签名，无需购买证书；产物名带 `-unsigned`。 |
| `npm run desktop:dist:signed` | 必须成功签名，缺少证书或签名失败会报错；macOS 还必须提供完整公证凭据；产物名带 `-signed`。 |
| `npm run desktop:dist` | 保留原来的自动模式，有配置时签名，无证书时可能输出未签名包。 |

未签名模式会从打包子进程移除继承的 `CSC_*`、`WIN_CSC_*`、`APPLE_*` 环境变量，关闭证书自动发现。macOS 设置 `identity: null`、`notarize: false`、`hardenedRuntime: false`；Windows 仅关闭签名，仍保留图标与版本信息。Electron/Chromium 自带二进制可能保留供应商原有签名，这不代表应用获得了你的开发者签名。

“免签名”不代表免系统提示。通过网络分发的 macOS 未签名、未公证应用可能被 Gatekeeper 拦截；Windows 可能显示未知发布者或 SmartScreen 提示。是否允许运行由用户和电脑的管理策略决定，构建脚本不会关闭系统防护。参见 [Apple 应用安全说明](https://support.apple.com/102445) 和 [electron-builder 签名模式](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。

输出在 `desktop/release/`。macOS 输出 DMG、ZIP；Windows 输出 NSIS 安装程序。每种平台/架构在对应机器上原生构建，Chromium、SQLite 和 Electron 架构必须一致，不要直接跨平台套用缓存目录。

### 安装包、隔离标记脚本与说明合并分发

macOS 未签名版本可以生成一个包含 DMG、中文使用说明、隔离标记移除/恢复脚本及 SHA-256 清单的压缩包。此合并打包步骤需要构建机安装 Python 3（测试用户无需安装）：

```sh
npm run desktop:prepare
npm --prefix desktop run dist:unsigned -- --mac dmg
npm --prefix desktop run test:quarantine
npm --prefix desktop run bundle:macos
```

输出为 `desktop/release/my12306-<版本>-mac-<架构>-unsigned-bundle.zip`，旁边另有整个压缩包的 `.sha256` 文件。也可以在 `bundle:macos -- <DMG绝对路径>` 中指定本次构建的安装包。

面向内测用户的入口是双击 `打不开时点这里.command`：先用 `macos-adhoc-sign.sh` 由内到外签名应用、Helper、框架和 Chromium，再用 `macos-quarantine.sh` 备份并移除本应用的隔离标记，成功后自动打开应用。未修改全局 Gatekeeper / SIP，不使用 sudo，不覆盖证书签名版本。`恢复隔离标记.command` 仅恢复原文件标记；Ad-hoc 签名和标记移除均不自动过期，恢复原始签名需从原 DMG 重新安装。脚本测试仅操作临时模拟应用或打包应用副本，不改变本机已安装应用的安全属性。

Smoke 测试使用一次性目录，验证桌面后台无 TCP 监听、私有 IPC、自定义协议页面、JSON / 无参数 POST（含同步乘车人接口）、日志导出、SQLite、内置 Chromium 启动及退出；不访问 12306、不发送通知、不注册启动项、不使用真实数据。开发版的开机启动开关禁用，避免注册 Electron 开发工具路径。

## 自动构建与分发

`.github/workflows/desktop.yml` 支持手动运行或 `desktop-v*` 标签触发，在 macOS arm64、macOS x64、Windows x64 上测试和构建，产物上传到 Actions artifacts。流程不会自动发布 GitHub Release。手动运行时可在 `signing` 下拉框选择 `unsigned`（默认）或 `signed`。标签构建默认 `unsigned`，可把仓库 Actions 变量 `DESKTOP_SIGNING` 设为 `signed` 改为正式签名构建；非法值直接报错。Artifacts 名称也带所选模式。

版本号同时维护根目录、`desktop/package.json` 和 `desktop/app/package.json`，然后刷新对应 lockfile。发布前需要在目标系统验收安装、扫码、托盘、退出、重启恢复和真实系统登录后的自动启动。

需要验证开发者身份并完成公证的 macOS 发布包使用 Developer ID 签名和 Apple 公证。工作流可配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；显式 `signed` 模式会要求签名成功并进行公证，不能静默降级成未签名包；也支持 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 的公证凭据组合。Windows 使用 Windows 签名证书的 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。未配置证书时可选择生成未签名包，不能把它描述为已签名正式发布版。参见 [Electron 登录项 API](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) 和 [electron-builder 代码签名](https://www.electron.build/code-signing.html)。

## 独立服务

原有命令保留：

```sh
./start.sh             # macOS/Linux 前台
./start.sh -d          # macOS/Linux 后台
./start.sh --multi-user -d
```

Windows 或其他平台可直接运行：

```sh
npm ci
npx playwright install chromium
npm run build:server
npm run build:web
npm run start:server
```

多用户启动环境变量见根 README。服务环境变量和个人桌面配置相互独立；桌面不会继承管理员密码。

Linux 开机服务模板在 `deploy/my12306.service`。替换运行用户、仓库位置、Node 绝对路径，创建可写的 `/var/lib/my12306`，以同一运行用户安装 Playwright Chromium；把配置放到权限受限的 `/etc/my12306.env`，再安装 unit 并执行 `systemctl enable --now my12306`。浏览器系统依赖可在部署时用 `npx playwright install --with-deps chromium` 安装。停止时先给后端保存会话，超时再由 systemd 清理整个进程组。
