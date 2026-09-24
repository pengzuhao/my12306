const { signingMode } = require('./scripts/signing.cjs');
const mode = signingMode(process.env.MY12306_SIGNING || 'auto');
const unsigned = mode === 'unsigned';

module.exports = {
  forceCodeSigning: mode === 'signed',
  appId: 'cn.my12306.desktop', productName: 'my12306',
  electronDist: 'node_modules/electron/dist',
  directories: { app: 'app', output: 'release', buildResources: 'assets' },
  files: ['main/**', 'server/**', 'web/**', 'package.json', '!**/*.map', '!**/__test__/**'],
  asar: true,
  electronLanguages: ['en', 'en-US', 'zh-CN', 'zh-TW', 'zh_CN', 'zh_TW'],
  npmRebuild: false, // SQLite 13 ships stable Node-API binaries; never rebuild the service workspace.
  asarUnpack: ['**/*.node', 'node_modules/playwright*/**'],
  // Desktop always runs headless; never ship the second, unused full Chrome binary.
  extraResources: [{ from: '.cache/browsers', to: 'browsers', filter: ['chromium_headless_shell-*/**', 'ffmpeg-*/**'] }],
  artifactName: '${productName}-${version}-${os}-${arch}' + (mode === 'auto' ? '' : `-${mode}`) + '.${ext}',
  mac: { category: 'public.app-category.utilities', target: ['dmg', 'zip'], icon: 'assets/icon.icns', hardenedRuntime: !unsigned, ...(unsigned ? { identity: null, notarize: false } : mode === 'signed' ? { notarize: true } : {}), entitlements: 'assets/entitlements.mac.plist', entitlementsInherit: 'assets/entitlements.mac.plist' },
  win: { ...(unsigned ? { signExecutable: false } : {}), target: ['nsis'], icon: 'assets/icon.ico' },
  linux: { target: ['AppImage', 'tar.gz'], category: 'Utility', icon: 'assets/icon.png' },
  dmg: { format: 'ULFO' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false },
};
