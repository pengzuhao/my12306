import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginNameFromApiText } from '../bot/login-name.js';

test('login name prefers the account id over the passenger name', () => {
  const raw = JSON.stringify({ data: { userDTO: { name: '测试甲', loginUserDTO: { user_name: 'traveler01', name: '测试甲' } } } });
  assert.equal(loginNameFromApiText(raw), 'traveler01');
  assert.equal(loginNameFromApiText(JSON.stringify({ data: { user_name: 'traveler01', name: '测试甲' } })), 'traveler01');
  assert.equal(loginNameFromApiText(JSON.stringify({ data: { name: '测试甲' } })), '测试甲');
  assert.equal(loginNameFromApiText(''), null);
  assert.equal(loginNameFromApiText('<html>'), null);
});
