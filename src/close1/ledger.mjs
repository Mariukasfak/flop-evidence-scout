/**
 * close-1 ledger: what happened to each of our trades, what we hold, and how
 * sure we are — rebuilt deterministically from verified referee posts and our
 * own trade records. Pure: no network, no clock, no keys.
 *
 * Three separate questions, three separate fields — never one status string:
 *
 *   status     what happened to the trade id   (SETTLED_PROVEN, ID_SETTLED, NOT_SETTLED, …)
 *   evidence   how we know it                  (OFFICIAL, INFERRED_PROBE, UNKNOWN_OMITTED, …)
 *   ownership  whether the copy that settled   (PROVEN, UNPROVEN, NOT_APPLICABLE)
 *              is provably OURS
 *
 * The id is not the trade. The flow post names trades by id only, and the
 * fold keeps "settled" as a set of ids: ANY copy carrying an id — a stranger's
 * countersignature of our open offer, or a message that simply reuses our id
 * with other keys — settles that id. So `settled: [id]` proves SOMEONE'S copy
 * settled. It becomes OUR settlement only with independent copy provenance: a
 * verified referee record naming the maker and countersigner of the copy that
 * settled. No such record is published today (the sweep `file` behind each
 * post's hash has no public route; checked 2026-09-26), so `provenance` is an
 * input that is empty in production and SETTLED_PROVEN is unreachable until
 * FLOP Labs publishes one. That is the honest state, not a bug.
 *
 * Listed is not total. Each flow post lists some ids and counts the rest in
 * `omitted.{mints,settled,void}`; at sweep 312, 0 settlements were listed and
 * 1,375 omitted. An empty list never means "nothing happened": where the
 * aggregate proves activity we cannot resolve to ids, the terminal evidence is
 * UNKNOWN_OMITTED.
 *
 * The re-post probe. An id settles once and the fold checks `settled` before
 * `expired`, so a copy posted after `until` voids `settled` if the id ever
 * settled and `expired` if it never did; it can never itself settle. A listed
 * `expired` is therefore proof that NO copy settled — ours included — whoever
 * posted the copy that was listed. A listed `settled` is id-level only.
 */
import { MINT, FEE_RATE, sweepFor } from './protocol.mjs';

export const STATUS = Object.freeze({
  PENDING: 'PENDING',               // its fate is not decided: sweeps that could apply it have not all run
  PROBE_DUE: 'PROBE_DUE',           // decided, not observed; a re-post after `until` can tell
  PROBE_POSTED: 'PROBE_POSTED',     // re-posted; waiting for the referee to list the copy
  SETTLED_PROVEN: 'SETTLED_PROVEN', // our copy settled, with copy provenance
  ID_SETTLED: 'ID_SETTLED',         // the id settled; whose copy is not established
  NOT_SETTLED: 'NOT_SETTLED',       // proven: no copy of the id ever settled
  NOT_OURS: 'NOT_OURS',             // provenance shows the settled copy was someone else's
  UNKNOWN: 'UNKNOWN'                // terminal: nothing further can be learned
});

export const EVIDENCE = Object.freeze({
  OFFICIAL: 'OFFICIAL',
  CRYPTO_VERIFIED: 'CRYPTO_VERIFIED',
  LOCAL_REPLAY: 'LOCAL_REPLAY',
  INFERRED_PROBE: 'INFERRED_PROBE',
  INFERRED_FOLD_ORDER: 'INFERRED_FOLD_ORDER',
  UNKNOWN_OMITTED: 'UNKNOWN_OMITTED', // the referee counted activity it did not list; ours may be in it
  UNKNOWN: 'UNKNOWN'
});

export const OWNERSHIP = Object.freeze({
  PROVEN: 'PROVEN',
  UNPROVEN: 'UNPROVEN',
  NOT_APPLICABLE: 'NOT_APPLICABLE'  // nothing settled, so there is no copy to own
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
const MAX_COUNT_ROWS = 12;

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const signOf = (t) => (t.ourSide === 'buy' ? 1 : -1);

/** Listed and omitted counts of one flow post; `missed` ranges count as unseen activity. */
export function flowCounts(f) {
  const o = f?.omitted || {};
  return {
    n: f?.n ?? null,
    listed: { mints: (f?.mints || []).length, settled: (f?.settled || []).length, void: (f?.void || []).length },
    omitted: { mints: o.mints ?? 0, settled: o.settled ?? 0, void: o.void ?? 0 },
    missed: (f?.missed || []).length
  };
}
const hidesActivity = (c) => c.omitted.settled > 0 || c.omitted.void > 0 || c.missed > 0;

/** The terms of a record: rebuilt for our offers, parsed from the stored trade text for takes. */
export function termsOf(t, ourDid) {
  if (t.terms) return t.terms;
  if (t.role === 'maker') return { id: t.id, maker: ourDid, px: t.px, qty: t.qty, side: t.ourSide, taker: 'any', until: t.until };
  try { return JSON.parse(t.text).terms ?? null; } catch { return null; }
}

/** Every probe we posted for a record, old single-probe records included. */
export function probesOf(t) {
  const list = [...(t.probes || [])];
  if (t.probe?.sweep && !list.some((p) => p.sweep === t.probe.sweep)) list.unshift({ sweep: t.probe.sweep, postedAt: t.probe.postedAt, legacy: true });
  return list;
}

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
 * Copy provenance for this id, if a verified referee source named the copy
 * that settled. Returns PROVEN (ours), NOT_OURS, or null (none).
 */
function provenanceOf(t, provenance, ourDid) {
  const p = provenance?.get(t.id);
  if (!p || p.source !== 'REFEREE_SIGNED') return null;
  const ours = t.role === 'maker' ? p.maker === ourDid : p.countersigner === ourDid;
  return { ...p, ours };
}

/**
 * One record's resolution.
 * @param flows       Map<n, verified flow body>
 * @param latest      the newest sweep with a verified flow post
 * @param provenance  Map<id, {sweep, maker, countersigner, source}> from verified referee records (empty today)
 */
export function resolveTrade(t, { flows, latest, ourDid, cfg = null, provenance = new Map() }) {
  const from = postSweepOf(t, cfg);
  const last = t.role === 'maker' ? Math.max(t.until, from) : from + 1;
  const counts = [];
  const note = (n) => { const f = flows.get(n); if (f && counts.length < MAX_COUNT_ROWS && !counts.some((c) => c.n === n)) counts.push(flowCounts(f)); };

  // 1. What the referee listed for this id while it could settle.
  let settledAt = null;
  const voids = [];
  for (let n = from; n <= last && n <= latest; n++) {
    const f = flows.get(n);
    if (!f) continue;
    note(n);
    if (settledAt === null && (f.settled || []).includes(t.id)) settledAt = n;
    for (const v of f.void || []) if (Array.isArray(v) && v[0] === t.id) voids.push({ n, reason: v[1] });
  }
  const base = { id: t.id, sweep: null, voidReason: null, basis: null, listedVoids: voids, flowCounts: counts };
  const prov = provenanceOf(t, provenance, ourDid);
  const settledResult = (evidence, basis, sweep) => {
    if (prov?.ours) return { ...base, status: STATUS.SETTLED_PROVEN, evidence, ownership: OWNERSHIP.PROVEN, basis, sweep: prov.sweep ?? sweep, provenance: prov };
    if (prov) return { ...base, status: STATUS.NOT_OURS, evidence, ownership: OWNERSHIP.PROVEN, basis, sweep: prov.sweep ?? sweep, provenance: prov };
    return { ...base, status: STATUS.ID_SETTLED, evidence, ownership: OWNERSHIP.UNPROVEN, basis, sweep };
  };
  if (settledAt !== null) return settledResult(EVIDENCE.OFFICIAL, 'FLOW_SETTLED', settledAt);
  const voidSettled = voids.find((v) => v.reason === 'settled');
  if (voidSettled) return { ...settledResult(EVIDENCE.OFFICIAL, 'FLOW_VOID_SETTLED', voidSettled.n), voidReason: 'settled' };
  const expiredListed = voids.find((v) => v.reason === 'expired');
  if (expiredListed) {
    return { ...base, status: STATUS.NOT_SETTLED, evidence: EVIDENCE.OFFICIAL, ownership: OWNERSHIP.NOT_APPLICABLE, basis: 'FLOW_VOID_EXPIRED', voidReason: 'expired', sweep: expiredListed.n };
  }

  // 2. Probes: a copy re-posted after `until`.
  const probes = probesOf(t);
  let lost = 0;
  for (const p of probes) {
    let seen = null;
    for (let n = p.sweep + 1; n <= p.sweep + PROBE_WAIT_SWEEPS && n <= latest; n++) {
      const f = flows.get(n);
      if (!f) continue;
      note(n);
      const v = (f.void || []).find((x) => Array.isArray(x) && x[0] === t.id);
      if (v) { seen = { n, reason: v[1] }; break; }
    }
    if (seen?.reason === 'settled') return { ...settledResult(EVIDENCE.INFERRED_PROBE, 'PROBE_SETTLED', null), probeSweep: seen.n };
    if (seen?.reason === 'expired') {
      return { ...base, status: STATUS.NOT_SETTLED, evidence: EVIDENCE.INFERRED_PROBE, ownership: OWNERSHIP.NOT_APPLICABLE, basis: 'PROBE_EXPIRED', probeSweep: seen.n };
    }
    if (seen) return { ...base, status: STATUS.UNKNOWN, evidence: EVIDENCE.OFFICIAL, ownership: OWNERSHIP.UNPROVEN, basis: 'PROBE_VOID_OTHER', voidReason: seen.reason, probeSweep: seen.n };
    if (latest < p.sweep + PROBE_WAIT_SWEEPS) return { ...base, status: STATUS.PROBE_POSTED, evidence: EVIDENCE.UNKNOWN, ownership: OWNERSHIP.UNPROVEN, basis: 'PROBE_WAITING' };
    lost += 1;   // not listed: the void was omitted, or the copy never reached the referee
  }

  // 2b. Anyone's late copy: a void listed after the window answers the same question a probe does.
  for (let n = last + 1; n <= latest; n++) {
    const f = flows.get(n);
    const v = (f?.void || []).find((x) => Array.isArray(x) && x[0] === t.id && (x[1] === 'expired' || x[1] === 'settled'));
    if (!v) continue;
    note(n);
    if (v[1] === 'settled') return { ...settledResult(EVIDENCE.OFFICIAL, 'FLOW_VOID_SETTLED_LATE', null), voidReason: 'settled', probeSweep: n };
    return { ...base, status: STATUS.NOT_SETTLED, evidence: EVIDENCE.OFFICIAL, ownership: OWNERSHIP.NOT_APPLICABLE, basis: 'FLOW_VOID_EXPIRED', voidReason: 'expired', sweep: n };
  }

  // 3. Not decided yet, or decided and still unseen.
  if (latest < decidedAfter(t, cfg)) return { ...base, status: STATUS.PENDING, evidence: EVIDENCE.UNKNOWN, ownership: OWNERSHIP.UNPROVEN, basis: 'WINDOW_OPEN' };
  const probeReady = latest >= t.until + 1;
  const official = voids[0] ?? null;          // a listed void of SOME copy: not our copy's fate
  const probeable = t.role === 'maker' || typeof t.text === 'string';   // older takes kept no signed text
  if (probeable && probes.length < MAX_PROBES && probeReady) {
    return { ...base, status: STATUS.PROBE_DUE, evidence: EVIDENCE.UNKNOWN, ownership: OWNERSHIP.UNPROVEN,
      basis: official ? 'FLOW_VOID_SOME_COPY' : 'UNLISTED', voidReason: official?.reason ?? null, sweep: official?.n ?? null, probesLost: lost };
  }
  if (!probeReady && probeable) {
    return { ...base, status: STATUS.UNKNOWN, evidence: EVIDENCE.UNKNOWN, ownership: OWNERSHIP.UNPROVEN, basis: 'AWAITING_UNTIL', voidReason: official?.reason ?? null };
  }
  const hidden = counts.some(hidesActivity);
  return {
    ...base, status: STATUS.UNKNOWN, evidence: hidden ? EVIDENCE.UNKNOWN_OMITTED : EVIDENCE.UNKNOWN, ownership: OWNERSHIP.UNPROVEN,
    basis: probeable ? 'PROBES_EXHAUSTED' : 'NOT_PROBEABLE', voidReason: official?.reason ?? null, sweep: official?.n ?? null, probesLost: lost
  };
}

/** Terminal: nothing more will change without new kinds of evidence. */
export const isTerminal = (r) => [STATUS.SETTLED_PROVEN, STATUS.ID_SETTLED, STATUS.NOT_SETTLED, STATUS.NOT_OURS].includes(r.status)
  || (r.status === STATUS.UNKNOWN && r.basis !== 'AWAITING_UNTIL');

/** The record's effect on OUR account: proven settled, proven none, or unknown. */
export function effectOf(res) {
  if (res.status === STATUS.SETTLED_PROVEN) return 'SETTLED';
  if (res.status === STATUS.NOT_SETTLED || res.status === STATUS.NOT_OURS) return 'NONE';
  return 'UNCERTAIN';
}

/** The fold's Account, for one key, in floats rounded to 1e-6 (LOCAL_REPLAY). */
export function replayAccount(fills, mint = MINT) {
  const a = { cash: mint, lots: [], fees: 0, feesExact: true };
  for (const f of fills) {
    const side = f.side;
    if (!f.feeExact) a.feesExact = false;
    a.cash -= f.fee; a.fees += f.fee;
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
  const gap = (close - px) * qty;
  return { fee: r6(Math.max(base, side > 0 ? gap : -gap)), exact: true };
}

/**
 * The owner state machine, with the evidence behind it.
 *
 * OFFICIAL only if a flow post lists our key in `mints` (it has not: mints are
 * omitted, not listed, from sweep 155 on — flop-labs/technocore-close-call-challenge#10).
 * Otherwise INFERRED_FOLD_ORDER from a listed void past `not_owner` on an id
 * only we generate (our random `mfk-` offer ids), which rests on the stated
 * assumption that nobody else posts a copy with our id.
 */
export function ownerState({ registration, resolutions, trades, flows, ourDid, latest, cfg = null }) {
  if (!registration) return { state: OWNER.UNREGISTERED, evidence: EVIDENCE.UNKNOWN };
  const regSweep = sweepFor(Date.parse(registration.postedAt), cfg);
  if (latest < regSweep) return { state: OWNER.REGISTRATION_POSTED, evidence: EVIDENCE.UNKNOWN, regSweep };
  let proof = null;
  for (const [n, f] of flows) if ((f.mints || []).includes(ourDid)) { proof = { evidence: EVIDENCE.OFFICIAL, basis: 'FLOW_MINTS', sweep: n }; break; }
  if (!proof) {
    for (const t of trades) {
      if (t.role !== 'maker') continue;
      const res = resolutions.get(t.id);
      const reasons = [...(res?.listedVoids || []).map((v) => v.reason), res?.voidReason].filter(Boolean);
      const passed = ['PROBE_EXPIRED', 'PROBE_SETTLED', 'FLOW_VOID_EXPIRED', 'FLOW_VOID_SETTLED'].includes(res?.basis) || reasons.some((r) => PAST_NOT_OWNER.has(r));
      if (passed) { proof = { evidence: EVIDENCE.INFERRED_FOLD_ORDER, basis: res.basis, tradeId: t.id, assumption: 'ID_UNIQUE_TO_US' }; break; }
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
export function buildLedger({ trades, registration, flows, prices, ourDid, cfg = null, mint = MINT, provenance = new Map() }) {
  const latest = Math.max(0, ...flows.keys());
  const resolutions = new Map();
  for (const t of trades) resolutions.set(t.id, resolveTrade(t, { flows, latest, ourDid, cfg, provenance }));

  const fills = [];
  let lo = 0; let hi = 0; let uncertainCollateral = 0; let uncertainFees = 0; let uncertainCount = 0;
  const pending = [];
  const openOffers = [];
  for (const t of trades) {
    const res = resolutions.get(t.id);
    const q = Number(t.qty); const px = Number(t.px); const side = signOf(t);
    const effect = effectOf(res);
    if (effect === 'SETTLED') {
      const sweep = res.sweep;
      const close = sweep != null && prices.get(sweep)?.ref?.px != null ? Number(prices.get(sweep).ref.px) : null;
      const { fee, exact } = ourFee({ side, qty: q, px, close });
      fills.push({ id: t.id, side, qty: q, px, fee, feeExact: exact, sweep });
    } else if (effect === 'UNCERTAIN') {
      uncertainCount += 1;
      if (side > 0) hi += q; else lo -= q;
      uncertainCollateral += q * px;
      uncertainFees += Math.max(FEE_RATE * q * px, 0.05 * q * px);   // the worst clawback inside the 5 % band
    }
    if (res.status === STATUS.PENDING || res.status === STATUS.PROBE_POSTED) pending.push(t.id);
    if (t.role === 'maker' && res.status === STATUS.PENDING) openOffers.push({ id: t.id, side: t.ourSide, qty: t.qty, px: t.px, until: t.until });
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
  const owner = ownerState({ registration, resolutions, trades, flows, ourDid, latest, cfg });
  // A balance is PROVEN only on an official mint and no trade of unknown effect.
  const balanceProvable = owner.evidence === EVIDENCE.OFFICIAL && uncertainCount === 0;

  const voidCounts = {};
  for (const r of resolutions.values()) for (const v of r.listedVoids || []) voidCounts[v.reason] = (voidCounts[v.reason] || 0) + 1;

  return {
    latest,
    latestFlowCounts: flows.get(latest) ? flowCounts(flows.get(latest)) : null,
    resolutions,
    owner,
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
    balance: {
      provable: balanceProvable,
      polf: balanceProvable ? acct.cash : null,
      worstFreePolf: r6(acct.cash - uncertainCollateral - uncertainFees)
    },
    exposure: {
      definite: net,
      low: r6(net + lo),
      high: r6(net + hi),
      worstAbs: r6(Math.max(Math.abs(net + lo), Math.abs(net + hi))),
      worstFreePolf: r6(acct.cash - uncertainCollateral - uncertainFees),
      uncertainTrades: uncertainCount
    },
    pending,
    openOffers,
    settledCount: [...resolutions.values()].filter((r) => effectOf(r) === 'SETTLED').length,
    settledProvenCount: [...resolutions.values()].filter((r) => r.status === STATUS.SETTLED_PROVEN).length,
    idSettledCount: [...resolutions.values()].filter((r) => r.status === STATUS.ID_SETTLED).length,
    voidCounts
  };
}
