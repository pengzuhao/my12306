import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const electron = require('electron');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// Remove the variable entirely: an empty value still enables Node mode on Windows.
for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
const child = spawn(electron, [path.join(desktop, 'app'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
