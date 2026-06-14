const crypto = require('crypto');
const config = require('./config');

function getKey() {
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to store or read watcher secrets.');
  }

  const trimmed = config.encryptionKey.trim();
  let source;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    source = Buffer.from(trimmed, 'hex');
  } else {
    source = Buffer.from(trimmed, 'base64');
  }

  if (source.length < 32) {
    source = crypto.createHash('sha256').update(trimmed).digest();
  }

  return source.subarray(0, 32);
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSecret(value) {
  if (!value) return '';
  const payload = Buffer.from(value, 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
