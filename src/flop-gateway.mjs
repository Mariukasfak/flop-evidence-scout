/**
 * Wallet enrollment and read-only checks for the FLOP gateway, api.flop.network.
 *
 * The flow is the one Flop Labs pointed us to (flop.network/connect, OpenAPI
 * 2.0.0): GET /v1/enroll/wallet/challenge?address=, sign the message with the
 * account key, POST /v1/enroll/wallet. The answer is a bearer with a 24-hour
 * allowance, once per address — re-enrolling rotates the bearer and does not
 * renew it, so enrollment is a single deliberate attempt, never a loop.
 *
 * Our agents' FLOP accounts are the Ed25519 keys of their did:key identities,
 * so signing needs only node:crypto. The gateway verifies with the polkadot
 * wallet convention, which wraps the signed bytes in <Bytes>…</Bytes>.
 */
import crypto from 'node:crypto';

import { flopAddressOfDid } from './flop-address.mjs';

export const GATEWAY = 'https://api.flop.network';

/** The <Bytes> wrapper polkadot wallets apply before signing a raw message. */
export const wrapBytes = (message) => `<Bytes>${message}</Bytes>`;

export function signEnrollment(message, privateKeyPem) {
  const sig = crypto.sign(null, Buffer.from(wrapBytes(message), 'utf8'), crypto.createPrivateKey(privateKeyPem));
  return `0x${sig.toString('hex')}`;
}

const json = async (res) => {
  try { return await res.json(); } catch { return {}; }
};

/**
 * One enrollment attempt. Returns { ok, status, code, body } and never throws for
 * an HTTP refusal: `wallet_enrollment_cap_reached` and `_unavailable` are the
 * daily cap and a paused service (flop-labs/network#123, #141), both "later".
 */
export async function enrollWallet(identity, { gateway = GATEWAY, fetchFn = fetch } = {}) {
  const address = flopAddressOfDid(identity.did);
  const ch = await fetchFn(`${gateway}/v1/enroll/wallet/challenge?address=${address}`, { signal: AbortSignal.timeout(30_000) });
  const challenge = await json(ch);
  if (!ch.ok || !challenge.message) {
    return { ok: false, stage: 'challenge', status: ch.status, code: challenge.error ?? challenge.code ?? null, address };
  }
  const res = await fetchFn(`${gateway}/v1/enroll/wallet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, message: challenge.message, signature: signEnrollment(challenge.message, identity.privateKeyPem) }),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await json(res);
  if (!res.ok || !body.key) {
    return { ok: false, stage: 'enroll', status: res.status, code: body.error ?? body.code ?? null, address };
  }
  return { ok: true, status: res.status, address, body };
}

/** Quota, expiry and the receipts the key has, by state. Never returns the key. */
export async function gatewayStatus(key, { gateway = GATEWAY, fetchFn = fetch } = {}) {
  const auth = { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) };
  const meRes = await fetchFn(`${gateway}/v1/keys/me`, auth);
  const me = await json(meRes);
  const rRes = await fetchFn(`${gateway}/v1/keys/me/receipts`, auth);
  const r = await json(rRes);
  const list = Array.isArray(r) ? r : (r.data ?? r.receipts ?? []);
  const byState = {};
  let settledRaw = 0n;
  for (const x of list) {
    byState[x.state] = (byState[x.state] ?? 0) + 1;
    if (x.settled_spend_raw) settledRaw += BigInt(x.settled_spend_raw);
  }
  return {
    status: meRes.status,
    remainingQuota: me.remaining_quota ?? null,
    expiresAt: me.expires_at ?? null,
    model: me.model ?? null,
    receipts: list.length,
    byState,
    settledSpendRaw: settledRaw.toString(),
    latest: list.slice(0, 5).map((x) => ({ request_id: x.request_id, state: x.state, settled_spend_raw: x.settled_spend_raw, channel_id: x.channel_id }))
  };
}
