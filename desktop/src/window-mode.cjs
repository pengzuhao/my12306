function isBackgroundLaunch(args, login = {}) {
  return args.includes('--autostart') || args.includes('--background') || login.wasOpenedAtLogin === true;
}

// Keep startup activation events from showing a window before the launch mode is known.
function createWindowMode({ app, getWindow, platform }) {
  let ready = false, openRequested = false;
  function show() {
    openRequested = true;
    const window = getWindow();
    if (!ready || !window || window.isDestroyed()) return;
    if (platform === 'darwin') void app.dock.show();
    if (platform === 'win32') window.setSkipTaskbar(false);
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  function hide() {
    openRequested = false;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.hide();
      if (platform === 'win32') window.setSkipTaskbar(true);
    }
    if (platform === 'darwin') app.dock.hide();
  }
  return {
    show, hide,
    activate() { if (ready) show(); },
    secondInstance(args) { if (!isBackgroundLaunch(args)) show(); },
    loaded(background) { ready = true; if (openRequested || !background) show(); else hide(); },
  };
}
module.exports = { isBackgroundLaunch, createWindowMode };
