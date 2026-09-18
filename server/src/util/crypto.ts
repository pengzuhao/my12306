import crypto from 'node:crypto';
import { MASTER_KEY } from '../config.js';

const ALGO = 'aes-256-gcm';

/** AES-256-GCM 对称加密（用于 12306 账号密码落库） */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(MASTER_KEY, 'hex');
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式：base64(iv) : base64(tag) : base64(data)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('密文格式非法');
  const [ivB64, tagB64, dataB64] = parts;
  const key = Buffer.from(MASTER_KEY, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}
