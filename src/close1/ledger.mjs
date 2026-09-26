/**
 * close-1 ledger: what happened to each of our trades, what we hold, and how
 * sure we are — rebuilt deterministically from verified referee posts and our
 * own trade records. Pure: no network, no clock, no keys.
 *
 * Evidence strength is a field, never a phrase in a status string:
 *
 *   OFFICIAL             a signed referee post says it (flow `settled`/`void`, `mints`)
 *   CRYPTO_VERIFIED      a peer message whose signatures we verified (a valid taker)
 *   LOCAL_REPLAY         our replay of the published fold over official facts
 *   INFERRED_PROBE       the fate of a re-posted copy after `until` (see below)
 *   INFERRED_FOLD_ORDER  a void reason the fold only reaches after `not_owner`
 *   UNKNOWN              nothing we can stand on
 *
 * Attribution. The flow post names a trade by id only. An open offer
 * (`taker: "any"`) can be countersigned by many keys and "the first
 * countersigned copy wins", so for a trade we TOOK from an open offer, an id
 * listed as settled proves some copy settled — not that ours did. Only two
 * cases name us for certain: our own offers (the id is ours; we are the maker
 * of every copy) and offers that named us as taker. Everything else carries
 * `attributed: false` and counts toward exposure as a range, not a fact.
 *
 * The re-post probe. An id settles once and the fold checks `settled` before
 * `expired`, so a copy posted after `until` voids `settled` if the id ever
 * settled and `expired` if it never did; it can never itself settle. The
 * flow's void list is usually near-complete, but not always (69 voids omitted
 * at sweep 307, 193 at 277), so a probe whose void is not listed is retried a
 * few times and then reported UNKNOWN, never "not settled".
 */
import { MINT, FEE_RATE, sweepFor } from './protocol.mjs';

export const STATUS = Object.freeze({
  PENDING: 'PENDING',           // its fate is not decided yet: the sweeps that could apply it have not all run
  PROBE_DUE: 'PROBE_DUE',       // decided, not observed; a re-post after `until` can tell
  PROBE_POSTED: 'PROBE_POSTED', // re-posted; waiting for the referee to list the copy
  SETTLED: 'SETTLED',
  NOT_SETTLED: 'NOT_SETTLED',   // proven: the id never settled
  VOID: 'VOID',                 // the referee listed a void for this id
  UNKNOWN: 'UNKNOWN'
});

export const EVIDENCE = Object.freeze({
  OFFICIAL: 'OFFICIAL',
  CRYPTO_VERIFIED: 'CRYPTO_VERIFIED',
  LOCAL_REPLAY: 'LOCAL_REPLAY',
  INFERRED_PROBE: 'INFERRED_PROBE',
  INFERRED_FOLD_ORDER: 'INFERRED_FOLD_ORDER',
  UNKNOWN: 'UNKNOWN'
});

export const OWNER = Object.freeze({
  UNREGISTERED: 'UNREGISTERED',
  REGISTRATION_POSTED: 'REGISTRATION_POSTED',
  MINT_UNKNOWN: 'MINT_UNKNOWN',
  MINT_CONFIRMED: 'MINT_CONFIRMED',
  ACTIVE: 'ACTIVE'
});

/** Void reasons the fold can only reach after both keys passed `not_owner`. */
const PAST_NOT_OWNER = new Set(['taker', 'settled', 'expired', 'locked', 'limits', 'funds']);
/** How many sweeps after a probe we wait for its void before calling it lost. */
export const PROBE_WAIT_SWEEPS = 3;
export const MAX_PROBES = 3;

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Our side as +1 (long) / −1 (short). */
const signOf = (t) => (t.ourSide === 'buy' ? 1 : -1);

export function isAttributed(t, ourDid) {
  if (t.role === 'maker') return true;
  return termsOf(t, ourDid)?.taker === ourDid;
}

/** The terms of a record: rebuilt for our offers, parsed from the stored trade text for takes. */
export function termsOf(t, ourDid) {
  if (t.terms) return t.terms;
  if (t.role === 'maker') {
    return { id: t.id, maker: ourDid, px: t.px, qty: t.qty, side: t.ourSide, taker: 'any', until: t.until };
  }
  try { return JSON.parse(t.text).terms ?? null; } catch { return null; }
}

/** Every probe we posted for a record, old single-probe records included. */
export function probesOf(t) {
  const list = [...(t.probes || [])];
  if (t.probe?.sweep && !list.some((p) => p.sweep === t.probe.sweep)) list.unshift({ sweep: t.probe.sweep, postedAt: t.probe.postedAt, legacy: true });
  return list;
}

/** The sweep that applied a record we posted (our copy of a take, or our offer's first sweep). */
export const postSweepOf = (t, cfg) => sweepFor(Date.parse(t.postedAt), cfg);

/**
 * The last sweep whose flow post can still change this record's fate.
 * A take is applied once, at the sweep after it was stamped (+1 for the
 * seconds the referee posts late). An offer can be taken until `until`.
 */
export function decidedAfter(t, cfg) {
  return t.role === 'maker' ? t.until : Math.min(t.until, postSweepOf(t, cfg) + 1);
}

/**
 * One record's resolution.
 * @param flows   Map<n, verified flow body>
 * @param latest  the newest sweep with a verified flow post
 */
export function resolveTrade(t, { flows, latest, ourDid, cfg = null }) {
  const attributed = isAttributed(t, ourDid);
  const base = { id: t.id, attributed, sweep: null, voidReason: null, basis: null };
  const from = postSweepOf(t, cfg);
  const last = Math.max(t.until, from + 1);

  // 1. What the referee listed for this id while it could settle.
  let settledAt = null;
  const voids = [];
  for (let n = from; n <= last && n <= latest; n++) {
    const f = flows.get(n);
    if (!f) continue;
    if (settledAt === null && Array.isArray(f.settled) && f.settled.includes(t.id)) settledAt = n;
    for (const v of f.void || []) if (Array.isArray(v) && v[0] === t.id) voids.push({ n, reason: v[1] });
  }
  if (settledAt !== null) return { ...base, status: STATUS.SETTLED, evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_SETTLED', sweep: settledAt };
  const voidSettled = voids.find((v) => v.reason === 'settled');
  if (voidSettled && t.role === 'maker') {
    // Every copy of our id has us as maker; one voiding `settled` means an earlier copy settled.
    return { ...base, status: STATUS.SETTLED, evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_VOID_SETTLED', sweep: voidSettled.n };
  }

  // 2. Probes: a copy re-posted after `until`.
  const probes = probesOf(t);
  let lost = 0;
  for (const p of probes) {
    let seen = null;
    for (let n = p.sweep + 1; n <= p.sweep + PROBE_WAIT_SWEEPS && n <= latest; n++) {
      const f = flows.get(n);
      if (!f) continue;
      const v = (f.void || []).find((x) => Array.isArray(x) && x[0] === t.id);
      if (v) { seen = { n, reason: v[1] }; break; }
    }
    if (seen?.reason === 'settled') {
      return { ...base, status: STATUS.SETTLED, evidence: EVIDENCE.INFERRED_PROBE, basis: 'PROBE_SETTLED', sweep: null, probeSweep: seen.n };
    }
    if (seen?.reason === 'expired') {
      // No copy ever settled — ours included, so this negative is ours whoever took the offer.
      return { ...base, attributed: true, status: STATUS.NOT_SETTLED, evidence: EVIDENCE.INFERRED_PROBE, basis: 'PROBE_EXPIRED', sweep: null, probeSweep: seen.n };
    }
    if (seen) return { ...base, status: STATUS.UNKNOWN, evidence: EVIDENCE.OFFICIAL, basis: 'PROBE_VOID_OTHER', voidReason: seen.reason, probeSweep: seen.n };
    if (latest < p.sweep + PROBE_WAIT_SWEEPS) return { ...base, status: STATUS.PROBE_POSTED, evidence: EVIDENCE.UNKNOWN, basis: 'PROBE_WAITING' };
    lost += 1;   // not listed: the void was omitted or the copy never reached the referee
  }

  // 3. A listed void, for a take whose copy may or may not have been the one listed.
  const official = voids.find((v) => v.n >= from);
  if (latest < decidedAfter(t, cfg)) return { ...base, status: STATUS.PENDING, evidence: EVIDENCE.UNKNOWN, basis: 'WINDOW_OPEN' };
  const probeReady = latest >= t.until + 1;
  if (!attributed && official?.reason === 'settled') {
    // Some copy of this id settled, ours or the one that beat it; a probe would only repeat that.
    return { ...base, status: STATUS.VOID, evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_VOID', voidReason: 'settled', sweep: official.n };
  }
  if (probes.length < MAX_PROBES && probeReady) {
    return { ...base, status: STATUS.PROBE_DUE, evidence: official ? EVIDENCE.OFFICIAL : EVIDENCE.UNKNOWN,
      basis: official ? 'FLOW_VOID' : 'UNLISTED', voidReason: official?.reason ?? null, sweep: official?.n ?? null, probesLost: lost };
  }
  if (official) return { ...base, status: STATUS.VOID, evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_VOID', voidReason: official.reason, sweep: official.n };
  return { ...base, status: STATUS.UNKNOWN, evidence: EVIDENCE.UNKNOWN, basis: probeReady ? 'PROBES_EXHAUSTED' : 'AWAITING_UNTIL', probesLost: lost };
}

/** Is the record's position effect settled for us, not for us, or unknown? */
export function effectOf(res) {
  if (res.status === STATUS.SETTLED && res.attributed) return 'SETTLED';
  if (res.status === STATUS.NOT_SETTLED) return 'NONE';
  if (res.status === STATUS.VOID && res.attributed) return 'NONE';
  return 'UNCERTAIN';
}

/** The fold's Account, for one key, in floats rounded to 1e-6 (LOCAL_REPLAY). */
export function replayAccount(fills, mint = MINT) {
  const a = { cash: mint, lots: [], fees: 0, feesExact: true };
  for (const f of fills) {
    const side = f.side;       // +1 buy, −1 sell (ours)
    const fee = f.fee;
    if (!f.feeExact) a.feesExact = false;
    a.cash -= fee; a.fees += fee;
    let left = f.qty;
    while (left > 1e-9 && a.lots.length && a.lots[0][0] * side < 0) {
      const [lq, lp] = a.lots[0];
      const size = Math.min(left, Math.abs(lq));
      a.cash += side < 0 ? size * f.px : size * (2 * lp - f.px);
      left -= size;
      if (Math.abs(size - Math.abs(lq)) < 1e-9) a.lots.shift(); else a.lots[0][0] = lq + side * size;
    }
    if (left > 1e-9) { a.cash -= left * f.px; a.lots.push([side * left, f.px]); }
  }
  a.cash = r6(a.cash); a.fees = r6(a.fees);
  return a;
}

/** Our fee on one fill: 1 % of value, or the discount we got against the sweep's close, if more. */
export function ourFee({ side, qty, px, close, feeRate = FEE_RATE }) {
  const base = feeRate * qty * px;
  if (close == null) return { fee: r6(base), exact: false };
  const gap = (close - px) * qty;              // > 0: a buyer paid less than the close
  return { fee: r6(Math.max(base, side > 0 ? gap : -gap)), exact: true };
}

/** The owner state machine, with the evidence behind it. */
export function ownerState({ registration, resolutions, trades, flows, ourDid, latest, cfg = null }) {
  if (!registration) return { state: OWNER.UNREGISTERED, evidence: EVIDENCE.UNKNOWN };
  const regSweep = sweepFor(Date.parse(registration.postedAt), cfg);
  if (latest < regSweep) return { state: OWNER.REGISTRATION_POSTED, evidence: EVIDENCE.UNKNOWN, regSweep };
  let proof = null;
  for (const [n, f] of flows) if ((f.mints || []).includes(ourDid)) { proof = { evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_MINTS', sweep: n }; break; }
  if (!proof) {
    for (const t of trades) {
      const res = resolutions.get(t.id);
      if (!res) continue;
      // A probe copy is ours alone at its sweep; our offers' ids are ours alone. Either way a
      // void past `not_owner`, or a settlement, means the referee counted our key as an owner.
      const ownCopy = res.attributed || res.basis === 'PROBE_EXPIRED' || res.basis === 'PROBE_SETTLED' || res.basis === 'PROBE_VOID_OTHER';
      if (!ownCopy) continue;
      const passed = (res.status === STATUS.SETTLED && res.attributed)
        || res.basis === 'PROBE_EXPIRED' || res.basis === 'PROBE_SETTLED'
        || (res.voidReason && PAST_NOT_OWNER.has(res.voidReason));
      if (passed) { proof = { evidence: EVIDENCE.INFERRED_FOLD_ORDER, basis: res.basis, tradeId: t.id }; break; }
    }
  }
  if (!proof) return { state: OWNER.MINT_UNKNOWN, evidence: EVIDENCE.UNKNOWN, regSweep };
  const active = [...resolutions.values()].some((r) => effectOf(r) === 'SETTLED');
  return { state: active ? OWNER.ACTIVE : OWNER.MINT_CONFIRMED, ...proof, regSweep };
}

/**
 * The whole ledger. `prices` is Map<n, verified price body>; the close of
 * sweep n is the `ref.px` of the price post whose `n` is n.
 */
export function buildLedger({ trades, registration, flows, prices, ourDid, cfg = null, mint = MINT }) {
  const latest = Math.max(0, ...flows.keys());
  const resolutions = new Map();
  for (const t of trades) resolutions.set(t.id, resolveTrade(t, { flows, latest, ourDid, cfg }));

  const fills = [];
  let lo = 0; let hi = 0; let uncertainCollateral = 0; let uncertainFees = 0;
  const pending = [];
  for (const t of trades) {
    const res = resolutions.get(t.id);
    const q = Number(t.qty); const px = Number(t.px); const side = signOf(t);
    const effect = effectOf(res);
    if (effect === 'SETTLED') {
      const sweep = res.sweep ?? fillSweep(t, cfg);
      const close = sweep != null && prices.get(sweep)?.ref?.px != null ? Number(prices.get(sweep).ref.px) : null;
      const { fee, exact } = ourFee({ side, qty: q, px, close });
      fills.push({ id: t.id, side, qty: q, px, fee, feeExact: exact, sweep });
    } else if (effect === 'UNCERTAIN') {
      if (side > 0) hi += q; else lo -= q;
      uncertainCollateral += q * px;
      uncertainFees += Math.max(FEE_RATE * q * px, 0.05 * q * px);   // the worst clawback inside the 5 % band
    }
    if (res.status === STATUS.PENDING || res.status === STATUS.PROBE_POSTED) pending.push(t.id);
  }
  fills.sort((a, b) => (a.sweep ?? 0) - (b.sweep ?? 0));
  const acct = replayAccount(fills, mint);
  const net = r6(acct.lots.reduce((s, [q]) => s + q, 0));
  const held = acct.lots.reduce((s, [q]) => s + Math.abs(q), 0);
  const avgEntry = held ? r6(acct.lots.reduce((s, [q, p]) => s + Math.abs(q) * p, 0) / held) : null;
  const collateral = r6(acct.lots.reduce((s, [q, p]) => s + Math.abs(q) * p, 0));
  const latestPrice = prices.get(Math.max(0, ...prices.keys()));
  const mark = latestPrice?.ref?.px != null ? Number(latestPrice.ref.px) : null;
  const value = mark == null ? null : acct.cash + acct.lots.reduce((v, [q, p]) => v + (q > 0 ? q * mark : -q * (2 * p - mark)), 0);

  const voidCounts = {};
  for (const r of resolutions.values()) if (r.voidReason) voidCounts[r.voidReason] = (voidCounts[r.voidReason] || 0) + 1;

  return {
    latest,
    resolutions,
    owner: ownerState({ registration, resolutions, trades, flows, ourDid, latest, cfg }),
    replay: {
      evidence: EVIDENCE.LOCAL_REPLAY,
      freePolf: acct.cash,
      collateral,
      netPosition: net,
      averageEntry: avgEntry,
      fees: acct.fees,
      feesExact: acct.feesExact,
      score: value == null ? null : r6(value - mint),
      mark
    },
    exposure: {
      definite: net,
      low: r6(net + lo),
      high: r6(net + hi),
      worstAbs: r6(Math.max(Math.abs(net + lo), Math.abs(net + hi))),
      worstFreePolf: r6(acct.cash - uncertainCollateral - uncertainFees)
    },
    pending,
    settledCount: [...resolutions.values()].filter((r) => effectOf(r) === 'SETTLED').length,
    voidCounts
  };
}

/** The sweep a maker fill most likely settled in: the first valid taker's stamp. */
function fillSweep(t, cfg) {
  const k = (t.takers || []).find((x) => x.valid);
  return k?.ts ? sweepFor(Date.parse(k.ts), cfg) : null;
}
