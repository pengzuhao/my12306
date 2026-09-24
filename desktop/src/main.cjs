const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, utilityProcess, session, shell, protocol, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ORIGIN, isAppUrl, createBackendClient, createProtocolHandler } = require('./transport.cjs');
const { isBackgroundLaunch, createWindowMode } = require('./window-mode.cjs');

app.setName('my12306');
protocol.registerSchemesAsPrivileged([{ scheme: 'my12306', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
// Allows an isolated smoke run without touching real desktop data or login items.
if (process.env.MY12306_DESKTOP_TEST_DIR) app.setPath('userData', path.resolve(process.env.MY12306_DESKTOP_TEST_DIR));
const locked = app.requestSingleInstanceLock();
if (!locked) { app.quit(); }
else {
  let window, tray, backend, origin, quitting = false, exited = false;
  const windowMode = createWindowMode({ app, getWindow: () => window, platform: process.platform });
  let requestBackend;
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const logPath = path.join(userData, 'desktop.log');
  const iconPath = path.join(__dirname, 'icon.png');
  let logStream;
  function appendLog(chunk) { logStream?.write(chunk); }
  function loginSettings() {
    return app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--autostart'] } : {});
  }
  function status() {
    const login = loginSettings();
    return { version: app.getVersion(), platform: process.platform, autoStart: login.openAtLogin, autoStartAvailable: app.isPackaged && !process.env.MY12306_DESKTOP_TEST_DIR, loginStatus: login.status || '', dataDir, background: true };
  }
  function setAutoStart(enabled) {
    if (typeof enabled !== 'boolean' || !status().autoStartAvailable) throw new Error('请安装正式桌面应用后设置开机启动');
    app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { path: process.execPath, args: ['--autostart'] } : {}) });
    refreshMenu();
    return status();
  }
  const show = windowMode.show;
  function refreshMenu() {
    const items = [
      { label: '打开 my12306', click: show },
      { label: '后台运行', click: windowMode.hide },
      { label: '登录电脑后自动启动', type: 'checkbox', checked: status().autoStart, enabled: status().autoStartAvailable, click: item => { try { setAutoStart(item.checked); } catch (e) { dialog.showErrorBox('开机启动设置失败', e.message); } } },
      { type: 'separator' },
      { label: '打开数据目录', click: () => shell.openPath(dataDir) },
      { label: '退出 my12306', click: () => app.quit() },
    ];
    tray?.setContextMenu(Menu.buildFromTemplate(items));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'my12306', submenu: items },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'minimize' }, { role: 'close' }] },
    ]));
  }
  function trusted(event) { return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url); }
  function handle(channel, callback) { ipcMain.handle(channel, (event, ...args) => { if (!trusted(event)) throw new Error('不允许的调用来源'); return callback(...args); }); }
  async function startBackend() {
    const browsers = app.isPackaged ? path.join(process.resourcesPath, 'browsers') : path.resolve(__dirname, '../../.cache/browsers');
    const env = { ...process.env, MY12306_TRANSPORT: 'ipc', MY12306_DATA_DIR: dataDir, MY12306_PARENT_PID: String(process.pid), MY12306_MULTI_USER: '0', MY12306_HEADLESS: 'true', PLAYWRIGHT_BROWSERS_PATH: browsers };
    // Desktop owns its personal backend; service administrator options stay in service mode.
    delete env.MY12306_ADMIN_PASSWORD; delete env.MY12306_ADMIN_USER;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MY12306_RUNTIME_TOKEN;
    delete env.MY12306_HOST; delete env.MY12306_PORT; delete env.PORT;
    backend = utilityProcess.fork(path.join(__dirname, '../server/dist/index.js'), [], { env, stdio: 'pipe', serviceName: 'my12306 backend', cwd: userData });
    backend.stdout.on('data', appendLog); backend.stderr.on('data', appendLog);
    requestBackend = createBackendClient(backend, message => {
      if (window && !window.isDestroyed() && isAppUrl(window.webContents.getURL())) window.webContents.send('desktop:event', message);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后端启动超时，请查看 desktop.log')), 45000);
      backend.on('message', message => {
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        if (message.transport !== 'ipc' || message.listening !== false) reject(new Error('桌面后台未启用无端口通信'));
        else resolve(ORIGIN);
      });
      backend.on('exit', code => {
        exited = true; clearTimeout(timer);
        if (!origin) reject(new Error(`后端启动失败（${code}），请查看 ${logPath}`));
        else if (!quitting && process.env.MY12306_DESKTOP_SMOKE !== '1') { dialog.showErrorBox('后台服务已停止', `请退出后重新打开应用。日志：${logPath}`); app.quit(); }
      });
    });
  }
  app.on('second-instance', (_event, argv) => windowMode.secondInstance(argv));
  app.on('activate', windowMode.activate);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting || !backend || exited) return;
    event.preventDefault(); quitting = true;
    window?.hide();
    const force = setTimeout(() => { backend.kill(); app.exit(1); }, 15000);
    backend.once('exit', () => { clearTimeout(force); logStream?.end(); app.quit(); });
    backend.postMessage({ type: 'shutdown' });
  });
  app.whenReady().then(async () => {
    const backgroundLaunch = isBackgroundLaunch(process.argv, loginSettings());
    if (backgroundLaunch) windowMode.hide();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, logPath + '.old');
    logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    origin = await startBackend();
    powerMonitor.on('suspend', () => appendLog('电脑休眠，后台定时检查将暂停\n'));
    powerMonitor.on('resume', () => {
      appendLog('电脑唤醒，立即重新检查 12306 会话\n');
      if (backend && !exited && !quitting) backend.postMessage({ type: 'resume' });
    });
    const webSession = session.fromPartition('persist:my12306');
    webSession.protocol.handle('my12306', createProtocolHandler(requestBackend));
    if (process.env.MY12306_DESKTOP_SMOKE === '1') {
      if (!process.env.MY12306_DESKTOP_TEST_DIR) throw new Error('Smoke test requires an isolated data directory');
      const browsers = app.isPackaged ? path.join(process.resourcesPath, 'browsers') : path.resolve(__dirname, '../../.cache/browsers');
      await require('./smoke.cjs')({ origin, requestBackend, webSession, browsers, backendPid: backend.pid });
      app.quit();
      return;
    }
    webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    webSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ width: 1220, height: 860, minWidth: 480, minHeight: 540, show: false, title: 'my12306', backgroundColor: '#f5f7fa', icon: iconPath,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: webSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
    window.on('close', event => { if (!quitting) { event.preventDefault(); windowMode.hide(); } });
    window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    handle('desktop:status', status); handle('desktop:auto-start', setAutoStart);
    handle('desktop:background', () => { windowMode.hide(); return true; });
    handle('desktop:open-data', () => shell.openPath(dataDir));
    handle('desktop:quit', () => { app.quit(); return true; });
    const trayImage = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    tray = new Tray(trayImage); tray.setToolTip('my12306 · 后台运行中'); tray.on('click', show);
    refreshMenu();
    await window.loadURL(origin);
    windowMode.loaded(backgroundLaunch);
  }).catch(error => { if (quitting) return; appendLog(String(error) + '\n'); if (process.env.MY12306_DESKTOP_SMOKE === '1') { console.error(error); process.exitCode = 1; } else dialog.showErrorBox('my12306 无法启动', error.message); app.quit(); });
}
