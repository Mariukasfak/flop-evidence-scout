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
