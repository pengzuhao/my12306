const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../distribution/macos-quarantine.sh');
const attr = 'com.apple.quarantine';
const macTest = process.platform === 'darwin' ? test : test.skip;
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-quarantine-test-'));
  const app = path.join(root, 'my12306.app');
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.my12306.desktop</string></dict></plist>');
  const run = (...args) => spawnSync('/bin/bash', [script, ...args, app], { encoding: 'utf8', env: { ...process.env, MY12306_QUARANTINE_BACKUP_DIR: path.join(root, 'backups') } });
  const xattr = (...args) => spawnSync('/usr/bin/xattr', args, { encoding: 'utf8' });
  try { fn({ root, app, run, xattr }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
macTest('remove and restore original attributes, preserving other metadata and external symlink targets', () => fixture(({ root, app, run, xattr }) => {
  const child = path.join(app, 'Contents/Resources/空格 and\n换行.txt');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(child, 'test'); fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(app, 'Contents/Resources/link'));
  const original = '0081;5f000001;TestOnly;00000000-0000-0000-0000-000000000000';
  for (const file of [app, child, outside]) assert.equal(xattr('-w', attr, original, file).status, 0);
  assert.equal(xattr('-w', 'user.my12306.test', 'keep-me', child).status, 0);
  const apply = run(); assert.equal(apply.status, 0, apply.stderr);
  for (const file of [app, child]) assert.notEqual(xattr('-p', attr, file).status, 0);
  assert.equal(xattr('-p', attr, outside).stdout.trim(), original);
  assert.equal(xattr('-p', 'user.my12306.test', child).stdout.trim(), 'keep-me');
  assert.equal(run().status, 0, 'repeated helper launch succeeds when already unquarantined');
  xattr('-w', attr, '0081;new-download', app);
  assert.notEqual(run().status, 0, 'existing backup cannot be overwritten by a new quarantine value');
  xattr('-d', attr, app);
  const restore = run('--restore'); assert.equal(restore.status, 0, restore.stderr);
  for (const file of [app, child]) assert.equal(xattr('-p', attr, file).stdout.trim(), original);
  assert.equal(run().status, 0, 'can back up again after restoration');
}));
macTest('unquarantined app is a successful no-op', () => fixture(({ run }) => {
  const result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /无需处理/);
}));
macTest('reject a different application identity without changing its attributes', () => fixture(({ app, run, xattr }) => {
  const plist = path.join(app, 'Contents/Info.plist');
  fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('cn.my12306.desktop', 'com.other.app'));
  xattr('-w', attr, '0081;test', app);
  assert.notEqual(run().status, 0); assert.equal(xattr('-p', attr, app).stdout.trim(), '0081;test');
}));
macTest('restore never follows a directory replaced by a symlink outside the app', () => fixture(({ root, app, run, xattr }) => {
  const resources = path.join(app, 'Contents/Resources');
  fs.writeFileSync(path.join(resources, 'test.txt'), 'test');
  xattr('-w', attr, '0081;test', path.join(resources, 'test.txt'));
  assert.equal(run().status, 0);
  fs.renameSync(resources, path.join(root, 'moved'));
  fs.symlinkSync(path.join(root, 'moved'), resources);
  assert.notEqual(run('--restore').status, 0);
  assert.notEqual(xattr('-p', attr, path.join(root, 'moved/test.txt')).status, 0);
}));
