/**
 * The risk gate: every close-1 write passes here or does not happen.
 *
 * Fails CLOSED: an input it cannot read counts as a reason to halt. Returns
 * { ok, reasons[] } — `reasons` is machine-readable codes, one per failed check.
 *
 * Protocol limits (what the referee would accept) and policy limits (what we
 * choose to risk) are kept apart: the rules have no maximum quantity at all,
 * so MAX_TAKE_QTY is ours, sized for an evidence-collecting agent, not a trader.
 */
import { LIMIT_WINDOW, checkedTerms, makerPayload, takerPayload, safeVerify } from './protocol.mjs';
import { OWNER } from './ledger.mjs';

export const DEFAULT_POLICY = Object.freeze({
  mode: 'make',               // 'make' (our own offer) or 'take' (a stranger's open offer)
  allowOpenTake: false,       // see strategy.mjs: a take's settlement cannot be attributed to us
  maxTakeQty: 1.0,            // POLICY: contracts per trade (the protocol has no cap)
  unprovenMaxQty: 0.5,        // POLICY: the cap until one of OUR trades is SETTLED_PROVEN
  offerQty: 0.5,
  offerEdge: 0.002,
  offerSweeps: 6,
  maxDrift: 0.005,            // POLICY: our price within 0.5 % of the reference (protocol allows 5 %)
  maxAbsPosition: 10,         // POLICY: worst-case |position| including trades whose fate is unknown
  maxSettled: 3,
  maxAttempts: 20,
  maxPricePostAgeS: 480,      // the referee posts every 300 s; allow one late post
  maxRefTradeAgeS: 900,       // Hyperliquid's last trade behind the reference
  lockMarginSweeps: 12,       // stop an hour before the lock
  requiredRooms: ['d-close1-price', 'd-close1-flow'],
  maxReadAgeS: 600,
  gapLookbackS: 3600
});

export const REASON = Object.freeze({
  CONTEST_UNVERIFIED: 'contest_unverified',
  REFEREE_DID_CHANGED: 'referee_did_changed',
  REFEREE_SIG_FAILURE: 'referee_signature_failure',
  STREAM_GAP: 'stream_gap_in_required_room',
  READ_STALE: 'required_room_not_read_recently',
  REFERENCE_MISSING: 'reference_missing',
  REFERENCE_STALE: 'reference_stale',
  MINT_NOT_CONFIRMED: 'owner_mint_not_confirmed',
  FUNDS: 'insufficient_free_polf',
  PENDING_TRADE: 'another_trade_unresolved',
  EXPOSURE: 'exposure_limit',
  QTY: 'qty_over_policy',
  PRICE_POLICY: 'price_outside_policy_band',
  PRICE_PROTOCOL: 'price_outside_protocol_limits',
  CANONICAL: 'canonicalisation_failed',
  SIGNATURE: 'signature_check_failed',
  LOCK: 'too_close_to_lock',
  CAP_SETTLED: 'settled_cap_reached',
  CAP_ATTEMPTS: 'attempt_cap_reached',
  NOT_AFTER_UNTIL: 'probe_before_until'
});

/** Checks every write shares: is the contest and its referee what we pinned, and are we reading it? */
function commonChecks(snap, policy, nowMs) {
  const reasons = [];
  if (!snap.contest?.verified) reasons.push(REASON.CONTEST_UNVERIFIED);
  if (snap.observedRefereeDids?.some((d) => d !== snap.contest?.refereeDid)) reasons.push(REASON.REFEREE_DID_CHANGED);
  if ((snap.refereeSigFailures ?? 0) > 0) reasons.push(REASON.REFEREE_SIG_FAILURE);
  for (const room of policy.requiredRooms) {
    const st = snap.streams?.[room];
    if (!st?.lastOkAt || nowMs - Date.parse(st.lastOkAt) > policy.maxReadAgeS * 1000) { reasons.push(REASON.READ_STALE); break; }
    if (st.lastGap && nowMs - Date.parse(st.lastGap.at) < policy.gapLookbackS * 1000) { reasons.push(REASON.STREAM_GAP); break; }
  }
  return reasons;
}

function referenceChecks(snap, policy, nowMs) {
  const p = snap.price;
  if (!p?.ref?.px || !p.postedAt) return [REASON.REFERENCE_MISSING];
  const reasons = [];
  if (nowMs - Date.parse(p.postedAt) > policy.maxPricePostAgeS * 1000) reasons.push(REASON.REFERENCE_STALE);
  else if (p.ref.time && nowMs - Date.parse(p.ref.time) > policy.maxRefTradeAgeS * 1000) reasons.push(REASON.REFERENCE_STALE);
  return reasons;
}

/**
 * May this trade proposal be signed and posted?
 * @param snap  runtime snapshot pieces: contest, streams, price, ledger, attempts
 */
export function approveTrade(snap, proposal, policy = DEFAULT_POLICY, nowMs = Date.now()) {
  const reasons = [...commonChecks(snap, policy, nowMs), ...referenceChecks(snap, policy, nowMs)];
  const L = snap.ledger;
  if (!L) return { ok: false, reasons: [...reasons, REASON.CONTEST_UNVERIFIED] };
  if (![OWNER.MINT_CONFIRMED, OWNER.ACTIVE].includes(L.owner?.state)) reasons.push(REASON.MINT_NOT_CONFIRMED);
  if (L.pending?.length) reasons.push(REASON.PENDING_TRADE);
  if (L.settledCount >= policy.maxSettled) reasons.push(REASON.CAP_SETTLED);
  if ((snap.attempts ?? 0) >= policy.maxAttempts) reasons.push(REASON.CAP_ATTEMPTS);

  const t = proposal?.terms;
  const canon = t && checkedTerms(t);
  if (!canon || JSON.stringify(canon) !== JSON.stringify(t)) reasons.push(REASON.CANONICAL);
  if (canon) {
    const qty = Number(canon.qty); const px = Number(canon.px);
    const ref = Number(snap.price?.ref?.px);
    // Until we can prove one settlement is ours, nothing larger than half a contract.
    const cap = (L.settledProvenCount ?? 0) > 0 ? policy.maxTakeQty : Math.min(policy.maxTakeQty, policy.unprovenMaxQty);
    if (qty > cap + 1e-9) reasons.push(REASON.QTY);
    if (ref > 0 && Math.abs(px / ref - 1) > LIMIT_WINDOW) reasons.push(REASON.PRICE_PROTOCOL);
    else if (ref > 0 && Math.abs(px / ref - 1) > policy.maxDrift) reasons.push(REASON.PRICE_POLICY);
    const need = qty * px * 1.06;          // price + the worst fee inside the band
    if (!(L.exposure?.worstFreePolf >= need)) reasons.push(REASON.FUNDS);
    if (!(L.exposure?.worstAbs + qty <= policy.maxAbsPosition)) reasons.push(REASON.EXPOSURE);
    const cur = snap.price?.n ?? 0;
    if (canon.until > (snap.contest?.lockSweep ?? 0) - policy.lockMarginSweeps
        || cur >= (snap.contest?.lockSweep ?? 0) - policy.lockMarginSweeps) reasons.push(REASON.LOCK);
    if (proposal.action === 'TAKE_OFFER' && !safeVerify(makerPayload(canon), proposal.makerSig, canon.maker)) reasons.push(REASON.SIGNATURE);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * May this re-post probe go out? It must be unable to settle: the newest
 * posted sweep is already past `until`, so the copy lands in a sweep that
 * voids it as `settled` or `expired`. Both signatures must verify first.
 */
export function approveProbe(snap, probe, policy = DEFAULT_POLICY, nowMs = Date.now()) {
  const reasons = commonChecks(snap, policy, nowMs);
  const t = checkedTerms(probe.terms);
  if (!t) reasons.push(REASON.CANONICAL);
  else {
    if (!((snap.price?.n ?? 0) >= t.until + 1)) reasons.push(REASON.NOT_AFTER_UNTIL);
    if (!safeVerify(makerPayload(t), probe.makerSig, t.maker)
        || !safeVerify(takerPayload(t, probe.taker), probe.takerSig, probe.taker)) reasons.push(REASON.SIGNATURE);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
