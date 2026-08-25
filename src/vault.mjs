import crypto from 'node:crypto';

/**
 * Passphrase-encrypted backup for the agent identities.
 *
 * These keys cannot be rotated without throwing away the on-network history they
 * exist to accumulate, so losing them is unrecoverable in a way losing almost
 * anything else here is not. GitHub Secrets is not a backup: it is write-only,
 * and nothing can read a secret back out.
 *
 * scrypt for key derivation (memory-hard, so a weak passphrase costs an attacker
 * real hardware) and AES-256-GCM for the payload (authenticated, so a corrupted
 * or tampered file fails loudly instead of decrypting to plausible garbage).
 */

export const VAULT_VERSION = 1;

// N=2^17 is roughly a quarter-second per attempt on a laptop: unnoticeable once,
// ruinous at scale. maxmem has to be raised to match or Node refuses the call.
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export const MIN_PASSPHRASE_LENGTH = 12;

export function assertUsablePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. ` +
      'This is the only thing standing between a copied file and both agent identities.'
    );
  }
  return true;
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_PARAMS);
}

export function encryptVault(plaintextObject, passphrase) {
  assertUsablePassphrase(passphrase);

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObject), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    vaultVersion: VAULT_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    // Public identifiers only, so a backup can be identified without opening it.
    contains: Object.keys(plaintextObject),
    dids: Object.values(plaintextObject)
      .map((v) => (v && typeof v === 'object' ? v.did : null))
      .filter(Boolean)
  };
}

export function decryptVault(vault, passphrase) {
  if (!vault || vault.vaultVersion !== VAULT_VERSION) {
    throw new Error(`Unsupported vault version: ${vault?.vaultVersion}`);
  }
  assertUsablePassphrase(passphrase);

  const salt = Buffer.from(vault.salt, 'base64');
  const iv = Buffer.from(vault.iv, 'base64');
  const authTag = Buffer.from(vault.authTag, 'base64');
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(vault.ciphertext, 'base64')),
      decipher.final()
    ]);
  } catch {
    // GCM cannot tell "wrong passphrase" from "tampered file" — and it should
    // not guess, because both mean stop.
    throw new Error('Decryption failed: wrong passphrase, or the vault file has been altered.');
  }

  return JSON.parse(plaintext.toString('utf8'));
}
