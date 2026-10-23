/**
 * The FLOP account behind a did:key.
 *
 * tclk's FLOP rail (flop-labs/tclk #210, 2026-10-22) binds a party's FLOP
 * AccountId32 to the exact Ed25519 public key in its did:key, so every
 * identity this agent already holds is a FLOP address. This turns one into the
 * SS58 form wallets, the faucet and the explorer use (prefix 42 on devnet).
 * No dependency: base58 and the blake2b-512 checksum are both in reach.
 */
import crypto from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const zeros = text.length - text.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(n ? hex : '', 'hex')]);
}

function base58Encode(bytes) {
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

/** The raw 32-byte Ed25519 key in a `did:key:z6Mk…`. */
export function ed25519KeyOfDid(did) {
  const m = String(did).match(/^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/);
  if (!m) throw new Error('not a did:key');
  const raw = base58Decode(m[1]);
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error('not an Ed25519 did:key');
  return raw.subarray(2);
}

/** SS58 address of a 32-byte public key; prefix 42 is the generic/devnet format. */
export function ss58Address(publicKey, prefix = 42) {
  if (publicKey.length !== 32 || prefix < 0 || prefix > 63) throw new Error('32-byte key and a one-byte prefix only');
  const body = Buffer.concat([Buffer.from([prefix]), publicKey]);
  const check = crypto.createHash('blake2b512').update(Buffer.concat([Buffer.from('SS58PRE'), body])).digest();
  return base58Encode(Buffer.concat([body, check.subarray(0, 2)]));
}

export const flopAddressOfDid = (did, prefix = 42) => ss58Address(ed25519KeyOfDid(did), prefix);
