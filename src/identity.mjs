import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]); // multicodec 0xed01 (ed25519-pub)

export function base58Encode(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length === 0) return '';

  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros++;

  const digits = [0];
  for (let i = zeros; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let str = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}

export function base58Decode(str) {
  if (typeof str !== 'string') throw new TypeError('Expected string for base58Decode');
  if (str.length === 0) return Buffer.alloc(0);

  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const char = str[i];
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`Invalid base58 character: ${char}`);

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const prefix = Buffer.alloc(zeros, 0);
  const body = Buffer.from(bytes.reverse());
  return Buffer.concat([prefix, body]);
}

export function deriveDidKeyFromRaw(rawPublicKey) {
  if (!Buffer.isBuffer(rawPublicKey)) rawPublicKey = Buffer.from(rawPublicKey);
  if (rawPublicKey.length !== 32) {
    throw new Error(`Ed25519 raw public key must be 32 bytes, got ${rawPublicKey.length}`);
  }
  const multikey = Buffer.concat([ED25519_MULTICODEC_PREFIX, rawPublicKey]);
  return `did:key:z${base58Encode(multikey)}`;
}

export function decodeDidKeyToRaw(didKey) {
  if (typeof didKey !== 'string' || !didKey.startsWith('did:key:z')) {
    throw new Error(`Invalid did:key format: ${didKey}`);
  }
  const encoded = didKey.slice('did:key:z'.length);
  const multikey = base58Decode(encoded);
  if (multikey.length !== 34 || multikey[0] !== 0xed || multikey[1] !== 0x01) {
    throw new Error('Unsupported or malformed multikey in did:key');
  }
  return multikey.subarray(2);
}

export function rawPublicKeyToSpki(rawPublicKey) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([spkiPrefix, rawPublicKey]);
  const b64 = der.toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export function generateIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  
  // Extract 32-byte raw public key from SPKI DER
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicKey = spkiDer.subarray(spkiDer.length - 32);
  const did = deriveDidKeyFromRaw(rawPublicKey);

  return {
    did,
    publicKeyPem,
    privateKeyPem,
    rawPublicKeyHex: rawPublicKey.toString('hex')
  };
}

export function signMessage(message, privateKeyPem) {
  const data = Buffer.isBuffer(message) ? message : Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, data, privateKey);
  return signature.toString('base64');
}

export function verifyMessage(message, signatureBase64, didOrPublicKeyPem) {
  const data = Buffer.isBuffer(message) ? message : Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const signature = Buffer.from(signatureBase64, 'base64');

  let publicKeyPem;
  if (didOrPublicKeyPem.startsWith('did:key:')) {
    const raw = decodeDidKeyToRaw(didOrPublicKeyPem);
    publicKeyPem = rawPublicKeyToSpki(raw);
  } else {
    publicKeyPem = didOrPublicKeyPem;
  }

  const publicKey = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(null, data, publicKey, signature);
}

export function loadOrCreateIdentity(storagePath) {
  if (process.env.SCOUT_IDENTITY_JSON) {
    try {
      const parsed = JSON.parse(process.env.SCOUT_IDENTITY_JSON);
      if (parsed.did && parsed.privateKeyPem) return parsed;
    } catch {
      // fallback to file
    }
  }
  const resolved = path.resolve(storagePath);
  if (fs.existsSync(resolved)) {
    const content = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (content.did && content.privateKeyPem && content.publicKeyPem) {
      return content;
    }
  }
  const identity = generateIdentity();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
