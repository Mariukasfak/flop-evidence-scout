#!/usr/bin/env node
/**
 * close-1 forensics: every one of our trades, what each source says about it,
 * and a READ-ONLY recommendation for the operator. Nothing here signs, posts
 * or changes a cap; the recommendation is for a person to read.
 *
 *   node tools/close1-forensics.mjs          table + accounts + recommendation (markdown)
 *   node tools/close1-forensics.mjs --json   the same as JSON
 *   node tools/close1-forensics.mjs --revalidate  fetch and hash every needed record again, ignoring the cache
 *                                            (a cache copied from another host is derived data, not authority)
 *   node tools/close1-forensics.mjs --quiet write the files only (the agent calls this on an evidence change)
 *
 * Reads the evidence store, our trade records and the archive cache (the only
 * network read is the archive's index.json, to know what is published). It
 * writes data/local/close1/forensics.{json,md}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceStore } from '../src/close1/evidence-store.mjs';
import { buildLedger, STATUS, EVIDENCE } from '../src/close1/ledger.mjs';
import { reconcileArchive, archiveVerdict, archiveMint, windowOf, RECORD } from '../src/close1/archive.mjs';
import { corroboratedAccount, compareAccounts, CORROBORATED_LABEL } from '../src/close1/corroborated.mjs';
import { standingOf } from '../src/close1/runtime.mjs';
import { DEFAULT_POLICY } from '../src/close1/risk-gate.mjs';
import { sweepFor } from '../src/close1/protocol.mjs';
import { refereeBodies } from './close1-take.mjs';

const DIR = path.resolve('data/local/close1');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const short = (did, ourDid) => (did === ourDid ? 'US' : did ? `…${did.slice(-8)}` : '—');

export const MODE = Object.freeze({ HOLD: 'HOLD', EVIDENCE_ONLY: 'EVIDENCE_ONLY', SAFE_RESUME_CANDIDATE: 'SAFE_RESUME_CANDIDATE' });

/** What the signed flow posts showed for this id, in words. */
function flowVisible(res) {
  const v = (res.listedVoids || []).map((x) => `void ${x.reason}@${x.n}`);
  if (res.basis === 'FLOW_SETTLED') return `settled listed @${res.sweep}`;
  if (['PROBE_EXPIRED', 'PROBE_SETTLED'].includes(res.basis)) return `probe copy void ${res.basis === 'PROBE_EXPIRED' ? 'expired' : 'settled'}@${res.probeSweep}`;
  if (res.basis === 'FLOW_VOID_SETTLED_LATE') return `late copy void settled@${res.probeSweep}`;
  return v.length ? v.join(', ') : 'nothing listed (omitted counts only)';
}

/** One row per trade, in the columns the operator asked for. */
export function forensicRows({ trades, ledger, verdicts, corroborated, ourDid, cfg = null }) {
  const byId = new Map(corroborated.rows.map((r) => [r.id, r]));
  return trades.map((t) => {
    const res = ledger.resolutions.get(t.id) || {};
    const v = verdicts.get(t.id) || {};
    const k = byId.get(t.id) || {};
    const { from, last } = windowOf(t, cfg);
    const mine = (v.observations || []).filter((o) => o.ours);
    const shown = k.corroboration?.exact ? k.corroboration : mine.find((o) => o.outcome === 'settled') || mine[0] || null;
    const classes = {};
    for (let n = from; n <= last; n++) {
      const c = v.gaps ? (v.gaps.missing.includes(n) ? RECORD.MISSING : v.gaps.unverified.includes(n) ? RECORD.UNVERIFIED : v.gaps.redacted.includes(n) ? RECORD.REDACTED : RECORD.FULL) : RECORD.FULL;
      classes[c] = (classes[c] || 0) + 1;
    }
    const side = t.ourSide === 'buy' ? 1 : -1;
    const qty = Number(t.qty); const px = Number(t.px);
    const fee = shown?.fee != null ? Number(shown.fee) : null;
    const notes = [];
    if (res.status === STATUS.ID_SETTLED) notes.push('id settled per signed flow; copy not proven ours');
    if (t.role !== 'maker' && shown && !shown.ours) notes.push('the settled copy was someone else\'s');
    if (t.role === 'maker' && (v.gaps?.hidden_trades ?? 0) > 0 && k.effect === 'UNKNOWN') notes.push(`${v.gaps.hidden_trades} private-room trades redacted in its window; a copy of our offer could be among them`);
    if (res.basis === 'AWAITING_UNTIL') notes.push(`until ${t.until}: not probeable before then`);
    if (!t.text && t.role !== 'maker') notes.push('our signed copy text was not stored (older take)');
    return {
      trade_id: t.id,
      role: t.role === 'maker' ? 'maker' : 'taker',
      side: t.ourSide,
      qty: t.qty,
      price: t.px,
      posted_sweep: sweepFor(Date.parse(t.postedAt), cfg),
      our_signed_copy_known: t.role === 'maker' ? Boolean(t.terms && t.signed?.makerSig) : typeof t.text === 'string',
      referee_flow_visible_outcome: flowVisible(res),
      ledger_status: `${res.status}/${res.evidence}`,
      archive_class: Object.entries(classes).map(([c, n]) => `${c}×${n}`).join(', '),
      archive_contains_exact_trade: Boolean(mine.length),
      archive_maker: shown ? short(shown.maker, ourDid) : '—',
      archive_taker: shown ? short(shown.countersigner, ourDid) : '—',
      archive_outcome: shown?.outcome ?? '—',
      archive_void_reason: shown?.reason ?? '—',
      ownership_confidence: k.ownership_confidence,
      settlement_confidence: k.settlement_confidence,
      outcome: k.outcome,
      effect_on_position: k.effect === 'SETTLED' ? side * qty : k.effect === 'NONE' ? 0 : `0 or ${side * qty > 0 ? '+' : ''}${side * qty}`,
      // Opening either side locks qty × px as collateral; the fee leaves play.
      effect_on_cash: k.effect === 'SETTLED' ? Math.round(-(qty * px + (fee ?? 0.01 * qty * px)) * 100) / 100 : k.effect === 'NONE' ? 0 : `0 or ${(-(qty * px)).toFixed(2)} − fee`,
      notes: notes.join('; ')
    };
  });
}

/** Counts by confidence, and a recommendation derived only from stated facts. */
export function decide({ rows, ledger, comparison, archive, attempts, policy = DEFAULT_POLICY, officialLookup = false }) {
  const count = (f) => rows.filter(f).length;
  const tally = {
    attempts,
    proven_settled_ours: count((r) => r.outcome === 'SETTLED' && r.ownership_confidence === 'CRYPTOGRAPHICALLY_PROVEN'),
    corroborated_settled_ours: count((r) => r.outcome === 'SETTLED' && r.ownership_confidence === 'OFFICIALLY_CORROBORATED'),
    proven_not_settled_for_us: count((r) => r.outcome === 'NOT_SETTLED' && r.settlement_confidence === 'CRYPTOGRAPHICALLY_PROVEN'),
    corroborated_not_settled_for_us: count((r) => r.outcome === 'NOT_SETTLED' && r.settlement_confidence === 'OFFICIALLY_CORROBORATED'),
    unknown: count((r) => r.outcome === 'UNKNOWN'),
    at_least_officially_corroborated: count((r) => r.outcome !== 'UNKNOWN')
  };
  // Funds and exposure limits permitting a trade is never a reason to resume (operator, 2026-09-29):
  // only better evidence is. Each improvement is listed; only the ones that also make a NEW trade
  // checkable — an archive covering current sweeps, or an official signed lookup — can lift the mode.
  const covering = archive?.archive_status === 'CURRENT' && !(archive.our_missing_sweeps || []).length;
  const improvements = [];
  if (covering) improvements.push('the archive covers current sweeps');
  if (officialLookup) improvements.push('FLOP Labs publishes a signed per-owner/per-trade lookup');
  if (tally.proven_settled_ours > 0) improvements.push(`${tally.proven_settled_ours} trade(s) have copy-level settlement provenance`);
  if (tally.unknown === 0) improvements.push('no trade remains unknown');
  const reasons = [];
  let mode = covering || officialLookup ? MODE.SAFE_RESUME_CANDIDATE : MODE.EVIDENCE_ONLY;
  if (comparison.conflicts.length) { mode = MODE.HOLD; reasons.push('the proven, corroborated and board views disagree'); }
  if (!covering) {
    reasons.push(`the archive is ${archive?.archive_status ?? 'unknown'} (${archive?.archive_lag_sweeps ?? '?'} sweeps behind): a new trade now would land in a sweep with no record, and the flow post omits most outcomes, so it would most likely end UNKNOWN like the last ones`);
  }
  if (!covering && !officialLookup && improvements.length) reasons.push(`improved (${improvements.join('; ')}), but a new trade still could not be checked`);
  if (tally.proven_settled_ours === 0) reasons.push('no trade is proven ours yet, so the ledger still carries every unknown at worst case');
  if (tally.unknown > 0) reasons.push(`${tally.unknown} trades remain unknown`);
  const E = ledger.exposure;
  return {
    tally,
    exposure: { proven_definite: E.definite, proven_range: [E.low, E.high], worst_free_polf: E.worstFreePolf, policy_max_abs: policy.maxAbsPosition },
    recommended_next_mode: mode,
    evidence_improvements: improvements,
    reasons,
    note: 'Recommendation for a person only. The 20-attempt cap is unchanged and nothing here is read by the agent.'
  };
}

function markdown(report) {
  const cols = ['trade_id', 'role', 'side', 'qty', 'price', 'posted_sweep', 'our_signed_copy_known', 'referee_flow_visible_outcome', 'archive_class', 'archive_contains_exact_trade',
    'archive_maker', 'archive_taker', 'archive_outcome', 'archive_void_reason', 'ownership_confidence', 'settlement_confidence', 'effect_on_position', 'effect_on_cash', 'notes'];
  const lines = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`];
  for (const r of report.rows) lines.push(`| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '/')).join(' | ')} |`);
  return lines.join('\n');
}

export async function run(argv = process.argv.slice(2)) {
  const evidence = new EvidenceStore({ dir: path.join(DIR, 'evidence') });
  const state = readJson(path.resolve('data/local/close1-trades.json'), { trades: [] });
  const registration = readJson(path.resolve('data/local/close1-registration.json'), null);
  const ourDid = registration?.did;
  if (!ourDid) throw new Error('no registration');
  const flows = refereeBodies(evidence, 'd-close1-flow');
  const prices = refereeBodies(evidence, 'd-close1-price');
  const pnl = refereeBodies(evidence, 'd-close1-pnl').latest?.body ?? null;
  const signedFiles = new Map();
  for (const [n, b] of prices.byN) if (typeof b.file === 'string') signedFiles.set(n, b.file);
  for (const [n, b] of flows.byN) if (typeof b.file === 'string') signedFiles.set(n, b.file);
  const prev = readJson(path.join(DIR, 'runtime.json'), null);
  const a = await reconcileArchive({ trades: state.trades, registration, ourDid, signedFiles, liveLatest: prices.latest?.body.n ?? null, cacheDir: path.join(DIR, 'archive'), prevHealth: prev?.archive ?? null, maxFetch: 0, revalidate: argv.includes('--revalidate') });
  const verdicts = new Map(state.trades.map((t) => [t.id, archiveVerdict(t, { records: a.records, ourDid })]));
  const mint = archiveMint({ records: a.records, regSweep: sweepFor(Date.parse(registration.postedAt)) });
  const ledger = buildLedger({ trades: state.trades, registration, flows: flows.byN, prices: prices.byN, ourDid, archive: verdicts, archiveMint: mint, roomPosts: state.roomPosts ?? [] });
  const ref = prices.latest?.body.ref?.px != null ? Number(prices.latest.body.ref.px) : null;
  const corroborated = corroboratedAccount({ trades: state.trades, resolutions: ledger.resolutions, prices: prices.byN, marks: { reference: ref, pnl_mark: pnl?.mark != null ? Number(pnl.mark) : null } });
  const standing = standingOf(pnl?.top, ourDid);
  const comparison = compareAccounts({ ledger, corroborated, standing, pnl });
  const rows = forensicRows({ trades: state.trades, ledger, verdicts, corroborated, ourDid });
  const decision = decide({ rows, ledger, comparison, archive: a.health, attempts: state.trades.length });
  const report = {
    generated_at: new Date().toISOString(), sweep: prices.latest?.body.n ?? null, reference: ref,
    owner: { state: ledger.owner.state, evidence: ledger.owner.evidence, confidence: ledger.owner.confidence, sources: ledger.owner.sources },
    archive: a.health, rows,
    accounts: {
      A_proven: comparison.A, B_corroborated: { label: CORROBORATED_LABEL, ...corroborated, rows: undefined }, C_board: { ...comparison.C, leaderboard_note: standing.leaderboard_note, pnl_sweep: pnl?.n ?? null },
      conflicts: comparison.conflicts
    },
    decision
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'forensics.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(DIR, 'forensics.md'), markdown(report) + '\n');
  if (argv.includes('--quiet')) return report;
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(markdown(report));
    if (a.health.revalidated) console.log(`\nrevalidated: fetched ${a.health.revalidated.fetched}, compared with cache ${a.health.revalidated.compared_with_cache}, differs from cache in sweeps [${a.health.revalidated.differs_from_cache.join(', ')}]; cache valid ${a.health.archive_cache_valid}`);
    console.log(`\nowner: ${report.owner.state} ${report.owner.evidence} confidence ${report.owner.confidence}`);
    console.log(`A proven: ${JSON.stringify(report.accounts.A_proven)}`);
    const B = report.accounts.B_corroborated;
    console.log(`B corroborated (${B.label}): pos ${B.net_position} long ${B.long_exposure} short ${B.short_exposure} avg ${B.average_entry} cash ${B.cash} fees ${B.fees} score ${JSON.stringify(B.score_at)} unknown ${JSON.stringify(B.unknown_range)}`);
    console.log(`C board: ${JSON.stringify(report.accounts.C_board)}`);
    console.log(`conflicts: ${JSON.stringify(report.accounts.conflicts)}`);
    console.log(`tally: ${JSON.stringify(decision.tally)}`);
    console.log(`RECOMMENDED_NEXT_MODE = ${decision.recommended_next_mode}\n- ${decision.reasons.join('\n- ')}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
