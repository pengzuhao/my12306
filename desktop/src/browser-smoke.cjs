// Installation check only: starts the bundled browser without opening external sites.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.parentPort.on('message', ({ data }) => { if (data?.type === 'shutdown') process.exit(0); });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const version = browser.version();
  await browser.close();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'my12306-browser-check-'));
  try {
    const context = await chromium.launchPersistentContext(profile, { headless: true });
    await context.close();
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  process.parentPort.postMessage({ ok: true, version });
})().catch(error => { console.error(error); process.exit(1); });
