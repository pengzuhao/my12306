import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'my12306-desktop-test-'));
const packaged = process.argv.includes('--packaged');
const executable = packaged ? (process.platform === 'darwin'
  ? path.join(desktop, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'my12306.app/Contents/MacOS/my12306')
  : path.join(desktop, 'release', 'win-unpacked', 'my12306.exe')) : require('electron');
const child = spawn(executable, packaged ? [] : [path.join(desktop, 'app')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '', MY12306_DESKTOP_SMOKE: '1', MY12306_DESKTOP_TEST_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => process.stderr.write(chunk));
const timer = setTimeout(() => child.kill(), 90000);
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  const passed = code === 0 && output.includes('PASS desktop:');
  if (!passed) { try { console.error(readFileSync(path.join(dir, 'desktop.log'), 'utf8')); } catch {} }
  else console.log('PASS graceful backend shutdown');
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
});
