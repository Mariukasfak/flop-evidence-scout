/**
 * Pure helpers for faucet-claim.mjs (tested in test/chain-faucet.test.mjs).
 *
 * Testnet (faucet image 0.1.47x, 2026-11-25) closed POST /fund and takes signed
 * agent claims at the /limits `agent.claimPath` (/v1/testnet/agent-claims):
 * { address, nonce: "<string>", signature: "0x.." } where the recipient key signs
 * `flop-faucet-agent/v1|<genesis>|<ss58>|<nonce>` (network#1252, #1255, #1265).
 * A bad signature is refused (401 claim_signature_invalid) before any cooldown,
 * so trying the <Bytes>-wrapped form after a raw-bytes 401 spends nothing.
 */
export function claimPlan(limits) {
  const faucet = limits?.faucet ?? {};
  const agentPath = faucet.agent?.claimPath ?? null;
  const ready = !faucet.status || faucet.status === 'open';
  return {
    mode: agentPath ? 'agent-claim' : 'fund',
    path: agentPath || '/fund',
    ready,
    status: faucet.status ?? null,
    grant: agentPath ? (faucet.agent?.grantFlop ?? null) : (faucet.anonymous?.grantFlop ?? null)
  };
}

export const agentClaimMessage = (genesis, address, nonce) =>
  `flop-faucet-agent/v1|${genesis}|${address}|${String(nonce)}`;

export const wrapBytes = (msg) => `<Bytes>${msg}</Bytes>`;

export const isSignatureRefusal = (status, body) =>
  status === 401 && (body?.reason === 'claim_signature_invalid' || /signature|D10/i.test(body?.error ?? ''));

/** True when today's log already holds a claim that may have paid (never claim twice a UTC day). */
export function claimedToday(lines, { agent, genesis, now = new Date() }) {
  const day = now.toISOString().slice(0, 10);
  return lines.some((e) => e && e.agent === agent && e.genesis === genesis
    && String(e.at ?? '').slice(0, 10) === day && ['accepted', 'unknown'].includes(e.outcome));
}

/**
 * How long to wait for the rolling daily cap to free (ms), or null when the faucet is not
 * capped or frees too late to wait for. /limits shows dailyCap.nextFreeAt while the status is
 * daily_cap_reached; the Scribe's claims on 2026-11-27 all ran while the cap was spent or the
 * queue was full, so a run that starts close to the reset waits for it instead of giving up.
 */
export function capWaitMs(limits, now = Date.now(), maxWaitMs = 65 * 60_000) {
  const f = limits?.faucet;
  if (f?.status !== 'daily_cap_reached') return null;
  const at = Date.parse(f?.dailyCap?.nextFreeAt ?? '');
  if (!Number.isFinite(at)) return null;
  const ms = at - now + 5_000;
  return ms <= maxWaitMs ? Math.max(ms, 0) : null;
}

/**
 * Seconds before re-sending the same signed claim (same nonce, so it can never pay twice),
 * or null when the answer is not the faucet's "busy, retry later". The faucet says
 * nothing was reserved in that case; we honour retryAfterSeconds, never less than 60 s.
 */
export function busyRetrySeconds(status, body) {
  const busy = body?.reason === 'faucet_busy' || (status === 503 && body?.action === 'retry_later');
  if (!busy) return null;
  const s = Number(body?.retryAfterSeconds);
  return Math.min(Math.max(Number.isFinite(s) ? s : 60, 60), 300);
}
