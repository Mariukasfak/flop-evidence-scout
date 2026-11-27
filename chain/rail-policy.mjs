/**
 * What the FLOP rail service will sign, decided before any key is touched. No imports,
 * so the repo's tests reach it without the chain's node_modules.
 *
 * The service holds the Scribe key (payer) and the Scout key (payee) for tclk deals on
 * the flop-htlc rail on FLOP Testnet. Every lock must pass `checkLock` against the
 * journal; every claim must pass `checkClaim`. Both return { ok, why }.
 *
 * Rules (user approval 2026-11-27 "viską tau leidžiu", within the airdrop rules):
 *   - native FLOP, hash lock, Testnet only (the service pins the genesis);
 *   - the payer is the Scribe; a payee may never be one of our own keys, so no deal
 *     is ever Scout <-> Scribe (circular, and worthless as evidence);
 *   - one lock per contract, ever, including after an uncertain submission;
 *   - per-lock and rolling-24 h caps, and short windows, so a counterparty that never
 *     delivers costs us fees and a refund wait, nothing more.
 */

export const FLOP = 10n ** 18n;
export const DEFAULT_POLICY = Object.freeze({
  maxLockPlanck: FLOP / 4n,          // 0.25 FLOP per deal
  dayCapPlanck: FLOP,                // 1 FLOP locked per rolling 24 h
  maxRefundAfterMs: 3 * 3600_000,    // refund window opens within 3 h of the lock
  minClaimWindowMs: 10 * 60_000,     // the payee gets at least 10 minutes to claim
  minFreeAfterLockPlanck: 2n * FLOP, // fees for the lock and the later refund stay on hand
});

/**
 * Contracts the payer key has tried to lock, in journal order. `lock-pending` is written
 * by tclk-flop's persistPending, just before signing; `lock-unsent` follows only when the
 * rail failed before chain.open, so nothing was signed and the attempt is void.
 */
export function attempts(journal) {
  const out = new Map();
  for (const e of journal) {
    if (e.kind === 'lock-unsent') out.delete(e.contract);
    else if (['lock', 'lock-pending', 'lock-error'].includes(e.kind) && !out.has(e.contract)) out.set(e.contract, e);
  }
  return out;
}

/** Is `free` (base units) enough to lock `amount` and still pay the fees after it? */
export function checkFunds(free, amount, policy = DEFAULT_POLICY) {
  const need = BigInt(amount) + policy.minFreeAfterLockPlanck;
  return free >= need ? { ok: true, why: 'funded' } : { ok: false, why: `payer free ${free} below ${need} (amount plus fee reserve)` };
}

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/;
const DAY_MS = 24 * 3600_000;

/** Base units locked in the last 24 h, from journal entries { kind: 'lock', at, amount }. */
export function lockedInDay(journal, now) {
  // A contract counts once, from its first attempt: an uncertain submission may
  // still have locked the funds, so it is counted as if it did.
  let sum = 0n;
  for (const e of attempts(journal).values()) {
    if (now - Date.parse(e.at) < DAY_MS && /^[0-9]{1,30}$/.test(String(e.amount))) sum += BigInt(e.amount);
  }
  return sum;
}

/** May the payer key lock these terms? */
export function checkLock(terms, { payerDid, ownDids, journal = [], now = Date.now(), policy = DEFAULT_POLICY }) {
  const no = (why) => ({ ok: false, why });
  if (!terms || typeof terms !== 'object') return no('no terms');
  if (terms.asset !== 'FLOP') return no(`asset ${terms.asset} is not FLOP`);
  if (terms.lock !== 'hash') return no(`lock ${terms.lock} is not hash`);
  if (!/^[0-9]{1,30}$/.test(String(terms.amount)) || BigInt(terms.amount) <= 0n) return no('amount must be positive base units');
  if (terms.payer !== payerDid) return no('payer is not the Scribe');
  if (!DID.test(String(terms.payee))) return no('payee is not an Ed25519 did:key');
  if (ownDids.includes(terms.payee)) return no('payee is one of our own keys');
  if (!/^0x[0-9a-f]{64}$/.test(String(terms.contract))) return no('malformed contract id');
  if (!/^0x[0-9a-f]{64}$/.test(String(terms.statement))) return no('malformed statement');
  const amount = BigInt(terms.amount);
  if (amount > policy.maxLockPlanck) return no(`amount ${amount} above the per-deal cap ${policy.maxLockPlanck}`);
  if (terms.claimByMs - now < policy.minClaimWindowMs) return no('claim window too short');
  if (terms.refundAfterMs <= terms.claimByMs) return no('refundAfterMs must follow claimByMs');
  if (terms.refundAfterMs - now > policy.maxRefundAfterMs) return no('refund window too far away');
  if (attempts(journal).has(terms.contract)) return no('this contract was already locked or attempted');
  const day = lockedInDay(journal, now);
  if (day + amount > policy.dayCapPlanck) return no(`rolling 24 h cap: ${day} locked, ${amount} more would pass ${policy.dayCapPlanck}`);
  return { ok: true, why: 'within policy' };
}

/** May the payee key claim? Only escrows whose payee is the Scout. */
export function checkClaim(terms, { payeeDid }) {
  if (terms?.payee !== payeeDid) return { ok: false, why: 'escrow payee is not the Scout' };
  if (terms.asset !== 'FLOP' || terms.lock !== 'hash') return { ok: false, why: 'not a FLOP hash lock' };
  return { ok: true, why: 'payee is the Scout' };
}
