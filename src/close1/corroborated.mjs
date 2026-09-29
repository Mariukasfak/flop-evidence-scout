/**
 * The corroborated account: what our close-1 account probably is, if the
 * officially published REDACTED sweep records are right.
 *
 * NOT USED FOR SIGNING OR RISK APPROVAL. The risk gate reads the conservative
 * ledger (ledger.mjs) and nothing else; this module is imported only by the
 * snapshot, the dashboard and the forensics report, and a test pins that the
 * gate's answer is identical with or without it.
 *
 * Three confidence classes per trade, kept apart:
 *   CRYPTOGRAPHICALLY_PROVEN  decided by signed referee data: a signed flow post
 *                             (listed outcome, or a listed void of a re-posted copy
 *                             read through the frozen fold's order), or a sweep
 *                             record whose bytes hash to the signed `file`
 *   OFFICIALLY_CORROBORATED   an OFFICIAL_INDEX_VERIFIED_REDACTED record shows our
 *                             exact copy (id, terms, maker, countersigner, outcome)
 *   UNKNOWN                   neither
 * A trade whose id is proven settled but whose copy is not proven ours is
 * PROVEN at id level and, for our account, only as good as its corroboration.
 */
import { STATUS, EVIDENCE, replayAccount, ourFee } from './ledger.mjs';
import { MINT } from './protocol.mjs';

export const CORROBORATED_LABEL = 'NOT USED FOR SIGNING OR RISK APPROVAL';
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const PROVEN_EVIDENCE = new Set([EVIDENCE.OFFICIAL, EVIDENCE.OFFICIAL_ARCHIVE, EVIDENCE.INFERRED_PROBE]);

/** One trade, three questions: did its id settle, was the settling copy ours, and what did it do to us. */
export function classifyTrade(t, res) {
  const c = res?.corroboration ?? null;
  const proven = PROVEN_EVIDENCE.has(res?.evidence);
  let settlement = 'UNKNOWN'; let ownership = 'UNPROVEN'; let effect = 'UNKNOWN';
  if (res?.status === STATUS.SETTLED_PROVEN) { settlement = 'CRYPTOGRAPHICALLY_PROVEN'; ownership = 'CRYPTOGRAPHICALLY_PROVEN'; effect = 'SETTLED'; }
  else if (res?.status === STATUS.NOT_OURS) { settlement = 'CRYPTOGRAPHICALLY_PROVEN'; ownership = 'CRYPTOGRAPHICALLY_PROVEN'; effect = 'NONE'; }
  else if (res?.status === STATUS.NOT_SETTLED && proven) { settlement = 'CRYPTOGRAPHICALLY_PROVEN'; ownership = 'NOT_APPLICABLE'; effect = 'NONE'; }
  else if (c?.exact && c.kind === 'SETTLED_OURS') {
    settlement = res?.status === STATUS.ID_SETTLED && proven ? 'CRYPTOGRAPHICALLY_PROVEN' : 'OFFICIALLY_CORROBORATED';
    ownership = 'OFFICIALLY_CORROBORATED'; effect = 'SETTLED';
  } else if (c && c.kind === 'SETTLED_NOT_OURS') { settlement = 'OFFICIALLY_CORROBORATED'; ownership = 'OFFICIALLY_CORROBORATED'; effect = 'NONE'; }
  else if (c && c.kind === 'NOT_SETTLED') { settlement = 'OFFICIALLY_CORROBORATED'; ownership = 'NOT_APPLICABLE'; effect = 'NONE'; }
  else if (res?.status === STATUS.ID_SETTLED && proven) settlement = 'CRYPTOGRAPHICALLY_PROVEN_ID_ONLY';
  const outcome = effect === 'SETTLED' ? 'SETTLED' : effect === 'NONE' ? 'NOT_SETTLED' : 'UNKNOWN';
  return { settlement_confidence: settlement, ownership_confidence: ownership, effect, outcome, corroboration: c };
}

/**
 * The account the corroborated outcomes imply, beside the range of what is
 * still unknown. `mark` prices open lots (the latest reference, or the pnl
 * post's mark when comparing with the board).
 */
export function corroboratedAccount({ trades, resolutions, prices = new Map(), marks = {}, mint = MINT }) {
  const rows = [];
  const fills = [];
  let unknownLong = 0; let unknownShort = 0;
  for (const t of trades) {
    const res = resolutions.get(t.id);
    const k = classifyTrade(t, res);
    const side = t.ourSide === 'buy' ? 1 : -1;
    const qty = Number(t.qty); const px = Number(t.px);
    if (k.effect === 'SETTLED') {
      const sweep = res?.sweep ?? k.corroboration?.sweep ?? null;
      const archiveFee = res?.archiveFee ?? k.corroboration?.fee;
      const close = sweep != null && prices.get(sweep)?.ref?.px != null ? Number(prices.get(sweep).ref.px) : null;
      const f = archiveFee != null ? { fee: Number(archiveFee), exact: true } : ourFee({ side, qty, px, close });
      fills.push({ id: t.id, side, qty, px, fee: f.fee, feeExact: f.exact, sweep });
    } else if (k.effect === 'UNKNOWN') {
      if (side > 0) unknownLong += qty; else unknownShort += qty;
    }
    rows.push({ id: t.id, ...k });
  }
  fills.sort((a, b) => (a.sweep ?? 0) - (b.sweep ?? 0));
  const acct = replayAccount(fills, mint);
  const net = r6(acct.lots.reduce((s, [q]) => s + q, 0));
  const held = acct.lots.reduce((s, [q]) => s + Math.abs(q), 0);
  const valueAt = (m) => (m == null ? null : r6(acct.cash + acct.lots.reduce((v, [q, p]) => v + (q > 0 ? q * m : -q * (2 * p - m)), 0) - mint));
  return {
    label: CORROBORATED_LABEL,
    trades_counted: fills.length,
    net_position: net,
    long_exposure: r6(acct.lots.filter(([q]) => q > 0).reduce((s, [q]) => s + q, 0)),
    short_exposure: r6(-acct.lots.filter(([q]) => q < 0).reduce((s, [q]) => s + q, 0)),
    average_entry: held ? r6(acct.lots.reduce((s, [q, p]) => s + Math.abs(q) * p, 0) / held) : null,
    cash: acct.cash,
    collateral: r6(acct.lots.reduce((s, [q, p]) => s + Math.abs(q) * p, 0)),
    fees: acct.fees,
    fees_exact: acct.feesExact,
    score_at: Object.fromEntries(Object.entries(marks).map(([k, m]) => [k, { mark: m, score: valueAt(m) }])),
    unknown_range: { low: r6(net - unknownShort), high: r6(net + unknownLong), unknown_trades: rows.filter((r) => r.effect === 'UNKNOWN').length },
    caveat: 'Only trades we posted are counted. A copy of one of our offers countersigned in a private room would be redacted from the records and is not visible here.',
    rows
  };
}

/**
 * A: the conservative ledger's range. B: the corroborated account. C: the
 * referee's pnl board. Any disagreement is returned as a conflict to alert on.
 */
export function compareAccounts({ ledger, corroborated, standing, pnl }) {
  const conflicts = [];
  const A = ledger ? { definite: ledger.exposure.definite, low: ledger.exposure.low, high: ledger.exposure.high, worst_free_polf: ledger.exposure.worstFreePolf } : null;
  const B = corroborated ? { net_position: corroborated.net_position, cash: corroborated.cash, score_at_pnl_mark: corroborated.score_at?.pnl_mark?.score ?? null } : null;
  let C = { visible: false, note: 'not visible in truncated top list' };
  if (standing?.leaderboard_display_row) C = { visible: true, score: Number(standing.official_score), pnl_sweep: pnl?.n ?? null };
  if (A && B && (B.net_position < A.low - 1e-9 || B.net_position > A.high + 1e-9)) {
    conflicts.push({ kind: 'CORROBORATED_OUTSIDE_PROVEN_RANGE', detail: `corroborated position ${B.net_position} is outside the ledger's ${A.low} … ${A.high}` });
  }
  // Scores compare only when no trade is left unknown; otherwise B is a partial account, not a claim.
  const comparable = (corroborated?.unknown_range?.unknown_trades ?? 1) === 0;
  if (B) B.score_comparable = comparable;
  if (comparable && B?.score_at_pnl_mark != null && C.visible && Math.abs(B.score_at_pnl_mark - C.score) > 0.01) {
    conflicts.push({ kind: 'CORROBORATED_SCORE_NOT_BOARD', detail: `corroborated score ${B.score_at_pnl_mark} vs board ${C.score} at sweep ${C.pnl_sweep}` });
  }
  // Not listed means at or below the lowest visible score (equal only if the tie runs past the list).
  const rows = Array.isArray(pnl?.top) ? pnl.top : [];
  const lowest = rows.length ? Number(rows.at(-1)[1]) : null;
  if (comparable && B?.score_at_pnl_mark != null && !C.visible && lowest != null && B.score_at_pnl_mark > lowest + 0.01) {
    conflicts.push({ kind: 'CORROBORATED_SCORE_ABOVE_BOARD', detail: `corroborated score ${B.score_at_pnl_mark} beats the lowest listed ${lowest}, yet our key is not listed` });
  }
  return { A, B, C, conflicts };
}
