import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
// npm's JS entry works on Windows without shell quoting or .cmd execution.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请使用 npm run desktop:prepare');
for (const workspace of ['server', 'web']) run(process.execPath, [npm, 'run', 'build', '--workspace', workspace]);
for (const name of ['main', 'server', 'web']) rmSync(path.join(desktop, 'app', name), { recursive: true, force: true });
cpSync(path.join(desktop, 'src'), path.join(desktop, 'app', 'main'), { recursive: true });
cpSync(path.join(desktop, 'assets', 'icon.png'), path.join(desktop, 'app', 'main', 'icon.png'));
for (const name of ['server', 'web']) cpSync(path.join(root, name, 'dist'), path.join(desktop, 'app', name, 'dist'), { recursive: true });
writeFileSync(path.join(desktop, 'app', 'server', 'package.json'), '{"type":"module"}\n');
mkdirSync(path.join(desktop, '.cache', 'browsers'), { recursive: true });
run(process.execPath, [path.join(desktop, 'app/node_modules/playwright/cli.js'), 'install', '--only-shell', 'chromium'], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(desktop, '.cache', 'browsers') },
});
// Electron 44 installs its binary explicitly (no package postinstall hook).
run(process.execPath, [path.join(desktop, 'node_modules/electron/install.js')]);
