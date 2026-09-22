const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWindowMode, isBackgroundLaunch } = require('../src/window-mode.cjs');

function fixture(platform = 'darwin') {
  const state = { visible: false, dock: true, taskbar: true, minimized: false, focused: false };
  const window = {
    isDestroyed: () => false, isMinimized: () => state.minimized,
    restore: () => { state.minimized = false; },
    show: () => { state.visible = true; }, hide: () => { state.visible = false; },
    focus: () => { state.focused = true; }, setSkipTaskbar: skip => { state.taskbar = !skip; },
  };
  const app = { dock: { show: async () => { state.dock = true; }, hide: () => { state.dock = false; } } };
  return { state, mode: createWindowMode({ app, getWindow: () => window, platform }) };
}

test('Windows autostart, macOS login and explicit background launches stay hidden', () => {
  assert.equal(isBackgroundLaunch(['app', '--autostart']), true);
  assert.equal(isBackgroundLaunch(['app'], { wasOpenedAtLogin: true }), true);
  assert.equal(isBackgroundLaunch(['app', '--background']), true);
  assert.equal(isBackgroundLaunch(['app'], { openAtLogin: true }), false, 'enabling autostart must not hide later manual launches');
});
test('initial macOS activation does not override background startup', () => {
  const { mode, state } = fixture();
  mode.hide(); mode.activate(); mode.loaded(true);
  assert.equal(state.visible, false); assert.equal(state.dock, false);
  mode.show(); assert.equal(state.visible, true); assert.equal(state.dock, true);
});
test('repeated background launch cannot bring an existing instance forward', () => {
  const { mode, state } = fixture(); mode.loaded(true);
  mode.secondInstance(['app', '--autostart']); mode.secondInstance(['app', '--background']);
  assert.equal(state.visible, false);
  mode.secondInstance(['app']); assert.equal(state.visible, true);
});
test('manual open while loading is remembered, even during background startup', () => {
  const { mode, state } = fixture(); mode.secondInstance(['app']);
  assert.equal(state.visible, false); mode.loaded(true);
  assert.equal(state.visible, true); assert.equal(state.focused, true);
});
test('manual startup shows the window and close-to-background can be restored', () => {
  const { mode, state } = fixture(); mode.loaded(false); assert.equal(state.visible, true);
  mode.hide(); assert.equal(state.visible, false); assert.equal(state.dock, false);
  mode.activate(); assert.equal(state.visible, true); assert.equal(state.dock, true);
});
test('Windows hides taskbar entry in background and restores minimized window', () => {
  const { mode, state } = fixture('win32'); mode.loaded(true);
  assert.equal(state.visible, false); assert.equal(state.taskbar, false);
  state.minimized = true; mode.show();
  assert.equal(state.taskbar, true); assert.equal(state.minimized, false); assert.equal(state.visible, true);
  mode.hide(); assert.equal(state.visible, false); assert.equal(state.taskbar, false);
});
