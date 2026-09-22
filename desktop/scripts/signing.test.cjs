const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { signingMode, buildEnvironment, validateSigning } = require('./signing.cjs');
test('unsigned removes inherited signing/notary credentials without mutating caller', () => {
  const source = { PATH: '/example', CSC_LINK: 'secret', WIN_CSC_LINK: 'secret', CSC_NAME: 'identity', APPLE_ID: 'id', APPLE_API_KEY: 'secret', CSC_IDENTITY_AUTO_DISCOVERY: 'true' };
  const env = buildEnvironment('unsigned', source);
  assert.deepEqual(env, { PATH: '/example', MY12306_SIGNING: 'unsigned', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.equal(source.CSC_LINK, 'secret');
});
test('signed preserves credentials and mac requires complete notarization credentials', () => {
  const env = buildEnvironment('signed', { CSC_LINK: 'cert' });
  assert.equal(env.CSC_LINK, 'cert');
  assert.throws(() => validateSigning('signed', 'darwin', env), /公证/);
  assert.doesNotThrow(() => validateSigning('signed', 'darwin', {APPLE_ID:'id', APPLE_APP_SPECIFIC_PASSWORD:'pw', APPLE_TEAM_ID:'team'}));
  assert.doesNotThrow(() => validateSigning('signed', 'darwin', {APPLE_API_KEY:'file', APPLE_API_KEY_ID:'id', APPLE_API_ISSUER:'issuer'}));
  assert.doesNotThrow(() => validateSigning('signed', 'win32', env));
});
test('invalid modes fail instead of silently selecting unsigned', () => {
  assert.throws(() => signingMode('singed'), /无效/);
});
for (const mode of ['auto', 'signed', 'unsigned']) test(`${mode} selects correct builder signing policy and artifact label`, () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./electron-builder.cjs")))'], {cwd:path.resolve(__dirname,'..'), env:buildEnvironment(mode), encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.forceCodeSigning, mode === 'signed');
  if (mode === 'unsigned') {
    assert.equal(config.mac.identity, null); assert.equal(config.mac.notarize, false);
    assert.equal(config.mac.hardenedRuntime, false); assert.equal(config.win.signExecutable, false);
    assert.match(config.artifactName, /-unsigned/);
  } else if (mode === 'signed') { assert.equal(config.mac.notarize, true); assert.match(config.artifactName, /-signed/); }
  else assert.doesNotMatch(config.artifactName, /unsigned|signed/);
});
