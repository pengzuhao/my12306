const modes = ['auto', 'unsigned', 'signed'];
function signingMode(value = 'auto') {
  if (!modes.includes(value)) throw new Error(`无效签名模式：${value}；请选择 ${modes.join(' / ')}`);
  return value;
}
function buildEnvironment(mode, source = process.env) {
  signingMode(mode);
  const env = { ...source, MY12306_SIGNING: mode };
  if (mode === 'unsigned') {
    // Do not import a certificate or send a notarization request even on a release machine.
    for (const key of Object.keys(env)) {
      if (/^(CSC_|WIN_CSC_|APPLE_)/.test(key)) delete env[key];
    }
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  return env;
}
function validateSigning(mode, platform, env) {
  if (mode === 'signed' && platform === 'darwin') {
    const appleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    const apiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
    if (!appleId && !apiKey) throw new Error('macOS 正式签名包需要 Apple 公证凭据：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，或完整的 Apple API Key 配置。');
  }
}
module.exports = { signingMode, buildEnvironment, validateSigning };
