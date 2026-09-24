import { mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
// Only final user deliverables: never duplicate a DMG inside and outside its bundle.
const input = path.resolve(process.argv[2] || 'desktop/release');
const output = path.resolve(process.argv[3] || 'desktop/delivery');
const platform = process.argv[4] || process.platform;
const mode = process.argv[5] || process.env.DESKTOP_SIGNING || 'unsigned';
const pattern = platform === 'darwin'
  ? mode === 'unsigned' ? /-unsigned-bundle\.zip$/ : /-signed\.dmg$/
  : /\.exe$/;
const files = readdirSync(input).filter(file => pattern.test(file));
if (files.length !== 1) throw new Error(`Expected one ${platform}/${mode} installer, found ${files.length}`);
if (existsSync(output) && readdirSync(output).length) throw new Error('Delivery directory must be empty');
mkdirSync(output, { recursive: true });
for (const file of files) {
  copyFileSync(path.join(input,file), path.join(output,file));
  const digest=createHash('sha256').update(readFileSync(path.join(output,file))).digest('hex');
  writeFileSync(path.join(output,file+'.sha256'),`${digest}  ${file}\n`);
  console.log(`Deliver: ${file}`);
}
