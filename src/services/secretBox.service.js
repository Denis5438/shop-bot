const crypto = require('crypto');
const { ORDER_TOKEN_ENCRYPTION_KEY } = require('../config');

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';

const getKey = () => {
  if (!ORDER_TOKEN_ENCRYPTION_KEY) throw new Error('ORDER_TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED');
  return crypto.createHash('sha256').update(String(ORDER_TOKEN_ENCRYPTION_KEY), 'utf8').digest();
};

const encryptSecret = (value) => {
  if (value == null) return value;
  const text = String(value);
  if (text.startsWith(PREFIX)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptSecret = (value) => {
  if (value == null) return value;
  const text = String(value);
  // Backward compatibility for records written before encryption. The
  // migration command converts these values in place.
  if (!text.startsWith(PREFIX)) return text;

  const [ivHex, tagHex, dataHex] = text.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('INVALID_ENCRYPTED_TOKEN');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
};

module.exports = { PREFIX, encryptSecret, decryptSecret };
