/**
 * One machine-readable runtime snapshot for close-1, and the alerts that a
 * change between two snapshots deserves.
 *
 * The snapshot feeds the dashboard. Alerts are only for changes that need a
 * human: nothing is sent while things stay healthy, so a Telegram channel fed
 * from `alertsBetween` stays quiet on a good day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectOf, isTerminal, STATUS, EVIDENCE } from './ledger.mjs';
import { referenceStatus } from './risk-gate.mjs';

export const PRIZE_PLACES = 3;
export const PRIZE_STATUS = Object.freeze({
  NOT_LISTED: 'UNKNOWN_NOT_LISTED',         // our key is not in the rows the referee shows
  TIE_TRUNCATED: 'UNKNOWN_TIE_TRUNCATED',   // our tie runs to the end of the visible rows and may continue past it
  UNORDERED: 'UNKNOWN_ROWS_UNORDERED',      // the rows are not in score order; nothing is inferred from them
  PROVISIONAL: 'PROVISIONAL_LIVE_MARK',     // the tie is complete, but scores are at the live mark, not at S
  FINAL: 'FINAL'                            // standings from a verified fold at S (not available before the lock)
});

/**
 * Where we stand on the `pnl` board, without inventing a rank.
 *
 * The row index is display order only. FLOP Labs, close-call #8 (comment
 * 5862711613): rows that share a score are ONE tie, shown in DID order. Rule 18
 * and the fold's `final`: tied owners share the places they span. So a place
 * can be computed only when the whole tie is visible — if the last visible row
 * still carries our score, the tie may continue past the truncated list and
 * the place is UNKNOWN. Scores are at the live mark until the lock, so even a
 * complete tie gives only PROVISIONAL places.
 */
export function standingOf(top, ourDid, { places = PRIZE_PLACES, final = false } = {}) {
  const rows = Array.isArray(top) ? top.filter((r) => Array.isArray(r) && typeof r[0] === 'string') : [];
  const idx = rows.findIndex((r) => r[0] === ourDid);
  const base = {
    leaderboard_display_row: idx >= 0 ? idx + 1 : null, leaderboard_rows_visible: rows.length,
    official_score: idx >= 0 ? rows[idx][1] : null, tie_score: null, tie_visible_count: null, tie_complete: null,
    rows_strictly_above: null, prize_place_status: PRIZE_STATUS.NOT_LISTED, prize_places: null, prize_sharing: null, prize_confidence: 'NONE',
    leaderboard_note: idx >= 0 ? null : 'not visible in truncated top list'
  };
  if (idx < 0) return base;
  const score = (r) => Number(r[1]);
  const ordered = rows.every((r, i) => i === 0 || score(rows[i - 1]) >= score(r));
  const ours = score(rows[idx]);
  const tied = rows.filter((r) => score(r) === ours).length;
  const above = rows.filter((r) => score(r) > ours).length;
  const complete = score(rows.at(-1)) !== ours;
  const out = { ...base, tie_score: rows[idx][1], tie_visible_count: tied, tie_complete: ordered && complete, rows_strictly_above: ordered ? above : null };
  if (!ordered) return { ...out, prize_place_status: PRIZE_STATUS.UNORDERED };
  if (!complete) return { ...out, prize_place_status: PRIZE_STATUS.TIE_TRUNCATED, leaderboard_note: 'tie may extend beyond visible list' };
  const spanned = [];
  for (let p = above + 1; p <= Math.min(above + tied, places); p++) spanned.push(p);
  return {
    ...out, prize_places: spanned, prize_sharing: spanned.length ? tied : 0,
    prize_place_status: final ? PRIZE_STATUS.FINAL : PRIZE_STATUS.PROVISIONAL,
    prize_confidence: final ? 'PROVEN' : 'PROVISIONAL'
  };
}

/** The weakest link in what we claim about our own account. */
function confidence(ledger) {
  if (!ledger) return { overall: EVIDENCE.UNKNOWN };
  const trades = {};
  for (const r of ledger.resolutions.values()) trades[r.evidence] = (trades[r.evidence] || 0) + 1;
  const position = ledger.exposure.uncertainTrades === 0 ? 'PROVEN' : 'RANGE_ONLY';
  const overall = ledger.owner.evidence !== EVIDENCE.OFFICIAL || position !== 'PROVEN' ? 'PARTIAL' : 'PROVEN';
  return { overall, owner: ledger.owner.evidence, owner_assumption: ledger.owner.assumption ?? null, position, trades };
}

export function buildSnapshot({
  contest, contestError = null, streams, price, ledger, pnl, ourDid, trades, gate, nowMs,
  writeErrors5m = 0, upstream = null, upstreamError = null, integrity = {}, archive = null,
  corroborated = null, comparison = null, decision = null, host = null
}) {
  const res = ledger ? [...ledger.resolutions.values()] : [];
  const cRows = new Map((corroborated?.rows || []).map((x) => [x.id, x]));
  const top = Array.isArray(pnl?.top) ? pnl.top : [];
  const standing = standingOf(top, ourDid);
  const refStatus = referenceStatus(price, undefined, nowMs);
  const latencies = (trades || []).filter((t) => t.role === 'maker')
    .map((t) => { const k = (t.takers || []).find((x) => x.valid); return k ? Date.parse(k.ts) - Date.parse(t.postedAt) : null; })
    .filter((x) => Number.isFinite(x));
  const streamStats = streams || {};
  const lastTrade = (trades || []).at(-1);
  const lastRes = lastTrade ? ledger?.resolutions.get(lastTrade.id) : null;
  return {
    generated_at: new Date(nowMs).toISOString(),
    contest_verified: Boolean(contest),
    contest_error: contestError,
    package_sha256: contest?.packageSha256 ?? null,
    referee_did: contest?.refereeDid ?? null,
    current_sweep: price?.n ?? null,
    reference_price: price?.ref?.px ?? null,
    ...refStatus,
    last_flow_sweep: ledger?.latest ?? null,
    flow_counts: ledger?.latestFlowCounts ?? null,
    stream_cursor_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.cursor])),
    stream_gap_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.lastGap])),
    owner_state: ledger?.owner?.state ?? null,
    owner_evidence: ledger?.owner?.evidence ?? null,
    owner_confidence: ledger?.owner?.confidence ?? null,
    owner_evidence_sources: (ledger?.owner?.sources || []).map((x) => ({ evidence: x.evidence, basis: x.basis, sweep: x.sweep ?? null, assumption: x.assumption ?? null })),
    balance_provable: ledger?.balance.provable ?? false,
    polf_balance: ledger?.balance.polf ?? null,
    free_polf_worst_case: ledger?.balance.worstFreePolf ?? null,
    free_polf: ledger?.balance.provable ? ledger.replay.freePolf : null,
    collateral: ledger?.replay.collateral ?? null,
    net_position: ledger?.replay.netPosition ?? null,
    proven_position: ledger?.exposure.definite ?? null,
    exposure_low: ledger?.exposure.low ?? null,
    exposure_high: ledger?.exposure.high ?? null,
    average_entry: ledger?.replay.averageEntry ?? null,
    fees: ledger?.replay.fees ?? null,
    fees_exact: ledger?.replay.feesExact ?? null,
    ...standing,
    pnl_sweep: pnl?.n ?? null,
    local_replay_score: ledger?.replay.score ?? null,
    official_score_note: standing.leaderboard_note,
    open_offers: ledger?.openOffers ?? [],
    pending_trades: ledger?.pending ?? [],
    settled_count: ledger?.settledCount ?? 0,
    settled_proven_count: ledger?.settledProvenCount ?? 0,
    id_settled_count: ledger?.idSettledCount ?? 0,
    void_count_by_reason: ledger?.voidCounts ?? {},
    evidence_confidence: confidence(ledger),
    latest_trade: lastRes ? { id: lastRes.id, status: lastRes.status, evidence: lastRes.evidence, ownership: lastRes.ownership, basis: lastRes.basis, void_reason: lastRes.voidReason } : null,
    maker_fill_latency_ms: latencies.length ? latencies : null,
    read_errors_5m: Object.values(streamStats).reduce((s, x) => s + (x.errors5m || 0), 0),
    write_errors_5m: writeErrors5m,
    last_successful_referee_read: Object.entries(streamStats).filter(([r]) => r.startsWith('d-close1-'))
      .map(([, s]) => s.lastOkAt).filter(Boolean).sort().at(-1) ?? null,
    integrity: {
      seed_records: integrity.seedRecords ?? null,
      foreign_referee_authors: integrity.foreignAuthors ?? [],
      referee_signature_failures: integrity.sigFailures ?? 0
    },
    upstream: upstream ? {
      checked_at: upstream.at, manifest_sha256: upstream.manifestSha256, manifest_status: upstream.manifestStatus,
      rules_version: upstream.rulesVersion, head: upstream.headCommit, watched: upstream.watched
    } : null,
    upstream_error: upstreamError,
    github_watch_status: upstream?.github?.status ?? null,
    github_remaining: upstream?.github?.remaining ?? null,
    github_reset_at: upstream?.github?.reset_at ?? null,
    github_last_success: upstream?.github?.last_success ?? null,
    github_blocked_until: upstream?.github?.blocked_until ?? null,
    github_authenticated: upstream?.github?.authenticated ?? null,
    archive: archive ?? null,
    corroborated_account: corroborated ? { ...corroborated, rows: undefined } : null,
    account_comparison: comparison ?? null,
    // The forensics recommendation, for a person. Nothing in the agent reads it.
    evidence_summary: decision ? {
      recommended_next_mode: decision.recommended_next_mode, tally: decision.tally, exposure: decision.exposure,
      evidence_improvements: decision.evidence_improvements ?? [], reasons: decision.reasons
    } : null,
    // Host health: which machine is the runtime, what lock it is under, and what it has written.
    ...(host || {}),
    archive_conflicts: ledger?.archiveConflicts ?? [],
    gate: gate ?? null,
    trades: res.map((r) => ({
      id: r.id, status: r.status, evidence: r.evidence, ownership: r.ownership, basis: r.basis, sweep: r.sweep,
      void_reason: r.voidReason, effect: effectOf(r), terminal: isTerminal(r),
      archive_observations: (r.archiveObservations || []).slice(0, 4).map((o) => ({
        sweep: o.sweep, record: o.record, outcome: o.outcome, reason: o.reason, our_copy: o.ours,
        maker: o.maker === ourDid ? 'US' : o.maker, countersigner: o.countersigner === ourDid ? 'US' : o.countersigner
      })),
      archive_gaps: r.archiveGaps ? { redacted: r.archiveGaps.redacted?.length ?? 0, missing: r.archiveGaps.missing?.length ?? 0, unverified: r.archiveGaps.unverified?.length ?? 0, hidden_trades: r.archiveGaps.hidden_trades ?? 0 } : null,
      corroboration: r.corroboration ? { kind: r.corroboration.kind, exact: r.corroboration.exact, sweep: r.corroboration.sweep, record: r.corroboration.record, evidence: 'OFFICIAL_REDACTED_CORROBORATION' } : null,
      corroborated_outcome: cRows.get(r.id)?.outcome ?? null,
      corroborated_settlement: cRows.get(r.id)?.settlement_confidence ?? null,
      corroborated_ownership: cRows.get(r.id)?.ownership_confidence ?? null
    }))
  };
}

/** Alerts for what changed from `prev` to `next`. Healthy-and-unchanged yields []. */
export function alertsBetween(prev, next) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (!next.contest_verified && (prev?.contest_verified ?? true)) add('contest_verification_failed', `close-1 contest check FAILED: ${next.contest_error ?? 'unknown'} — writes halted`);
  if (next.contest_verified && prev && !prev.contest_verified) add('contest_verification_restored', 'close-1 contest check passes again');
  const I = next.integrity || {};
  if ((I.seed_records ?? 1) > 1 && (I.seed_records !== prev?.integrity?.seed_records)) add('seed_changed', `close-1: the referee posted ${I.seed_records} seed records — the pinned seed may have been replaced`);
  const foreign = (I.foreign_referee_authors || []).filter((a) => !(prev?.integrity?.foreign_referee_authors || []).includes(a));
  if (foreign.length) add('referee_key_changed', `close-1: a referee room carries posts by ${foreign.join(', ')}, not the pinned referee`);
  if ((I.referee_signature_failures || 0) > 0 && !(prev?.integrity?.referee_signature_failures > 0)) add('referee_key_changed', 'close-1: a referee post failed its signature check');
  const minted = (s) => s === 'MINT_CONFIRMED' || s === 'ACTIVE';
  if (prev && minted(next.owner_state) && !minted(prev.owner_state)) add('mint_confirmed', `close-1 owner mint confirmed (${next.owner_evidence})`);
  for (const [room, gap] of Object.entries(next.stream_gap_by_room || {})) {
    if (!room.startsWith('d-close1-') || !gap) continue;
    if (gap.at !== prev?.stream_gap_by_room?.[room]?.at) add('stream_gap', `gap in ${room}: ${gap.kind} ${gap.from}…${gap.to}`);
  }
  const stale = (s) => s?.gate?.reasons?.includes('price_post_stale') || s?.gate?.reasons?.includes('required_room_not_read_recently');
  if (stale(next) && !stale(prev)) add('referee_stale', 'close-1 referee stopped posting (or we stopped reading it) — writes halted');
  if (prev) {
    const before = new Map((prev.trades || []).map((t) => [t.id, t]));
    for (const t of next.trades || []) {
      const was = before.get(t.id);
      if (t.terminal && (was?.status !== t.status || was?.evidence !== t.evidence)) {
        const own = t.status === STATUS.ID_SETTLED ? ' — the id settled; that it was OUR copy is not proven' : '';
        const arch = t.evidence === EVIDENCE.OFFICIAL_ARCHIVE && was && was.evidence !== EVIDENCE.OFFICIAL_ARCHIVE ? ` — decided by a verified archive record (was ${was.status})` : '';
        add(t.status === STATUS.SETTLED_PROVEN ? 'settled_proven' : 'trade_resolved', `close-1 ${t.id}: ${t.status}${t.void_reason ? ` (${t.void_reason})` : ''}, evidence ${t.evidence}, ownership ${t.ownership}${own}${arch}`);
      }
    }
  }
  // No top-3 alerts from display rows: a place is announced only once it is proven (final, complete tie).
  const placed = (s) => s?.prize_confidence === 'PROVEN' && (s.prize_places || []).length > 0;
  if (placed(next) && !placed(prev)) add('prize_place_proven', `close-1: proven prize place(s) ${next.prize_places.join(', ')}, shared by ${next.prize_sharing}`);
  out.push(...archiveAlerts(prev?.archive, next.archive));
  out.push(...evidenceAlerts(prev, next));
  out.push(...githubAlerts(prev, next));
  const sig = (s) => (s?.account_comparison?.conflicts || []).map((c) => c.kind).sort().join(',');
  if (sig(next) && sig(next) !== sig(prev)) add('account_conflict', `close-1 accounts disagree: ${next.account_comparison.conflicts.map((c) => c.detail).join('; ')}`);
  const conflicts = (next.archive_conflicts || []).filter((id) => !(prev?.archive_conflicts || []).includes(id));
  if (conflicts.length) add('archive_integrity', `close-1: a verified archive record contradicts our earlier inference for ${conflicts.join(', ')}`);
  const halted = (s) => s?.gate && !s.gate.ok && s.gate.kind === 'halt';
  if (halted(next) && !halted(prev)) add('risk_gate_halt', `close-1 risk gate halted writes: ${next.gate.reasons.join(', ')}`);
  if ((next.write_errors_5m || 0) > 0 && !(prev?.write_errors_5m > 0)) add('write_failure', 'close-1 signing/posting failed; needs a look');
  return out;
}

/**
 * Archive health changes worth a message: CURRENT → LAGGING, back to CURRENT,
 * and a record whose hash disagrees with the referee. Staying LAGGING, or
 * flapping through UNAVAILABLE, is shown on the dashboard and sent nowhere.
 */
export const ARCHIVE_STALL_MS = 60 * 60_000;
export const ARCHIVE_LAG_DROP_SWEEPS = 50;

export function archiveAlerts(prev, next) {
  const out = [];
  if (!next || !prev) return out;
  const add = (kind, text) => out.push({ kind, text });
  const was = prev.archive_status; const now = next.archive_status;
  const moved = next.archive_latest_sweep != null && prev.archive_latest_sweep != null && next.archive_latest_sweep > prev.archive_latest_sweep;
  if (now === 'LAGGING' && was === 'CURRENT') add('archive_lagging', `close-1 archive stalled: ends at sweep ${next.archive_latest_sweep}, referee at ${next.live_latest_sweep} (${next.archive_lag_sweeps} sweeps, ~${next.archive_lag_minutes} min behind)`);
  if (now === 'CURRENT' && was && was !== 'CURRENT') add('archive_current', `close-1 archive caught up: sweep ${next.archive_latest_sweep} (referee ${next.live_latest_sweep})`);
  else if (moved) {
    const stalledFor = prev.archive_latest_changed_at ? Date.parse(next.archive_latest_changed_at) - Date.parse(prev.archive_latest_changed_at) : 0;
    const drop = (prev.archive_lag_sweeps ?? 0) - (next.archive_lag_sweeps ?? 0);
    if (stalledFor >= ARCHIVE_STALL_MS || drop > ARCHIVE_LAG_DROP_SWEEPS) {
      add('archive_advanced', `close-1 archive moved: sweep ${prev.archive_latest_sweep} → ${next.archive_latest_sweep}${drop > 0 ? `, lag down ${drop} sweeps` : ''}; still ${next.archive_lag_sweeps} behind`);
    }
  }
  const arrived = (prev.our_missing_sweeps || []).filter((n) => !(next.our_missing_sweeps || []).includes(n));
  if (arrived.length) add('archive_our_sweeps', `close-1 archive now has sweep(s) ${arrived.slice(0, 12).join(', ')} holding our trades, missing until now`);
  const bad = (next.mismatch_sweeps || []).filter((n) => !(prev.mismatch_sweeps || []).includes(n));
  if (bad.length) add('archive_integrity', `close-1 archive record(s) for sweep ${bad.join(', ')} fail the hash check`);
  return out;
}

/**
 * Evidence moving under our 20 trades (operator, 2026-09-29): an UNKNOWN that
 * resolves, a corroborated result that changes, owner evidence that gets
 * stronger, a proven exposure range that moves, and the recommendation
 * changing. A snapshot written before these fields existed is a baseline.
 */
const OWNER_RANK = { UNKNOWN: 0, INFERRED: 1, OFFICIALLY_CORROBORATED: 2, PROVEN: 3 };

export function evidenceAlerts(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  const add = (kind, text) => out.push({ kind, text });
  const before = new Map((prev.trades || []).map((t) => [t.id, t]));
  const how = (t) => `${t.corroborated_outcome}${t.corroboration ? ` (${t.corroboration.kind}, ${t.corroboration.record ?? 'record'} sweep ${t.corroboration.sweep ?? '?'})` : ''}`;
  for (const t of next.trades || []) {
    const was = before.get(t.id);
    if (!was || was.corroborated_outcome === undefined || t.corroborated_outcome == null) continue;
    if (was.corroborated_outcome === t.corroborated_outcome && (was.corroboration?.kind ?? null) === (t.corroboration?.kind ?? null)) continue;
    if (was.corroborated_outcome === 'UNKNOWN') add('unknown_resolved', `close-1 ${t.id}: UNKNOWN → ${how(t)}, settlement ${t.corroborated_settlement}`);
    else add('corroboration_changed', `close-1 ${t.id}: corroborated ${how(was)} → ${how(t)}`);
  }
  const rank = (s) => OWNER_RANK[s] ?? -1;
  if (prev.owner_confidence && rank(next.owner_confidence) > rank(prev.owner_confidence)) {
    add('owner_stronger', `close-1 owner evidence stronger: ${prev.owner_confidence} → ${next.owner_confidence} (${next.owner_state}, ${next.owner_evidence})`);
  }
  const range = (s) => `${s.exposure_low} … ${s.exposure_high} (definite ${s.proven_position})`;
  if (prev.exposure_low != null && next.exposure_low != null && range(prev) !== range(next)) {
    add('proven_exposure_changed', `close-1 proven exposure ${range(prev)} → ${range(next)}`);
  }
  const mode = (s) => s?.evidence_summary?.recommended_next_mode;
  if (mode(prev) && mode(next) && mode(prev) !== mode(next)) add('mode_changed', `close-1 RECOMMENDED_NEXT_MODE ${mode(prev)} → ${mode(next)}: ${(next.evidence_summary.reasons || []).join('; ')}`);
  return out;
}

/**
 * A fresh host has no archive cache, and a half-filled cache shows fewer
 * corroborated outcomes than the archive really holds. Until every published
 * sweep we need has been fetched and checked, there is no baseline, and a
 * "change" would only be the cache filling up. The first complete snapshot IS
 * the baseline; only changes after it may alert.
 */
export function baselineStatus(archive) {
  const a = archive || {};
  if (a.archive_latest_sweep == null) return { ready: false, status: 'BACKFILLING', why: 'the archive index has not been read' };
  if ((a.pending_sweeps ?? 1) > 0) return { ready: false, status: 'BACKFILLING', why: `${a.pending_sweeps ?? '?'} needed sweeps not yet fetched and checked` };
  if ((a.mismatch_sweeps || []).length) return { ready: false, status: 'BACKFILLING', why: `hash mismatch in sweep(s) ${a.mismatch_sweeps.join(', ')}` };
  return { ready: true, status: 'BASELINE_READY', why: null };
}

/** Evidence transitions: what a cache filling up would fake. Integrity, lock, GitHub and contest alerts are not among them. */
export const EVIDENCE_TRANSITION_KINDS = Object.freeze(new Set([
  'trade_resolved', 'settled_proven', 'unknown_resolved', 'corroboration_changed', 'owner_stronger', 'mint_confirmed',
  'proven_exposure_changed', 'mode_changed', 'archive_our_sweeps', 'account_conflict', 'prize_place_proven'
]));

/** Without a baseline on BOTH sides of the comparison, evidence transitions are logged, not sent. */
export function gateEvidenceAlerts(prev, next, alerts) {
  if (prev?.evidence_baseline_ready === true && next?.evidence_baseline_ready === true) return alerts;
  return alerts.map((a) => (EVIDENCE_TRANSITION_KINDS.has(a.kind) ? { ...a, logOnly: true, suppressed: next?.evidence_baseline_ready ? 'BASELINE_JUST_ESTABLISHED' : 'BACKFILLING' } : a));
}

/** Kinds that are folded into one evidence report instead of being sent one by one. */
export const REPORT_KINDS = Object.freeze(new Set([
  'archive_advanced', 'archive_current', 'archive_our_sweeps', 'archive_integrity', 'maintainer_reply',
  'unknown_resolved', 'corroboration_changed', 'settled_proven', 'trade_resolved', 'mint_confirmed', 'owner_stronger',
  'proven_exposure_changed', 'mode_changed'
]));
const OFFICIAL_KINDS = new Set(['archive_advanced', 'archive_current', 'archive_our_sweeps', 'archive_integrity', 'maintainer_reply']);

/**
 * On a meaningful change, one message in the operator's seven points; the
 * alerts it folds stay in the log. Nothing meaningful: the alerts unchanged.
 */
export function withEvidenceReport(prev, next, alerts) {
  const folded = alerts.filter((a) => REPORT_KINDS.has(a.kind) && !a.logOnly);
  if (!folded.length) return alerts;
  const texts = (f) => folded.filter(f).map((a) => `  - ${a.text}`);
  const official = texts((a) => OFFICIAL_KINDS.has(a.kind));
  const ours = texts((a) => !OFFICIAL_KINDS.has(a.kind) && !['proven_exposure_changed', 'mode_changed'].includes(a.kind));
  const range = (s) => (s?.exposure_low != null ? `${s.exposure_low} … ${s.exposure_high} (definite ${s.proven_position}), worst-case free POLF ${Math.round(s.free_polf_worst_case * 100) / 100}` : '?');
  const corr = (s) => (s?.corroborated_account ? `${s.corroborated_account.net_position} (still unknown ${s.corroborated_account.unknown_range?.low} … ${s.corroborated_account.unknown_range?.high})` : '?');
  const a = next.archive || {};
  const es = next.evidence_summary || {}; const pm = prev?.evidence_summary?.recommended_next_mode; const nm = es.recommended_next_mode;
  const act = [];
  if (nm && pm && nm !== pm) act.push(`review the new recommendation ${nm}; nothing changes until a person decides`);
  if (folded.some((x) => x.kind === 'archive_integrity')) act.push('an archive record fails its hash check: look before trusting any archive result');
  const text = [
    `close-1 evidence change at sweep ${next.current_sweep ?? '?'}`,
    '1. Official:', ...(official.length ? official : ['  - no new official publication']),
    '2. Our trades:', ...(ours.length ? ours : ['  - none of our trades changed state']),
    `3. Proven exposure: ${range(prev)} → ${range(next)}`,
    `4. Corroborated position (NOT USED FOR SIGNING OR RISK APPROVAL): ${corr(prev)} → ${corr(next)}`,
    `5. Archive: ${a.archive_status ?? '?'}, latest ${a.archive_latest_sweep ?? '?'}, referee ${a.live_latest_sweep ?? '?'}, lag ${a.archive_lag_sweeps ?? '?'} sweeps (~${a.archive_lag_minutes ?? '?'} min)`,
    `6. RECOMMENDED_NEXT_MODE: ${pm && nm && pm !== nm ? `${pm} → ${nm} (CHANGED)` : `${nm ?? '?'} (unchanged)`}`,
    `7. Operator action: ${act.length ? act.join('; ') : 'none required'}`
  ].join('\n');
  return [...alerts.map((x) => (folded.includes(x) ? { ...x, logOnly: true } : x)), { kind: 'evidence_report', text }];
}

/** The GitHub watcher: news only when it goes blind for hours, and when it can see again. */
export function githubAlerts(prev, next) {
  const was = prev?.github_watch_status; const now = next?.github_watch_status;
  if (!was || !now || was === now) return [];
  if (now === 'BLIND') return [{ kind: 'github_watch_blind', text: `close-1 GitHub watcher blind since ${next.github_last_success ?? 'never'} (rate limit; resets ${next.github_reset_at ?? '?'}). Trading is not affected.` }];
  if (now === 'OK' && was === 'BLIND') return [{ kind: 'github_watch_restored', text: 'close-1 GitHub watcher sees upstream again' }];
  return [];
}

/**
 * Deliver alerts: always appended to a local log; also sent to Telegram when
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (not set on 2026-09-26).
 */
export async function deliverAlerts(alerts, { logFile, env = process.env, fetchFn = fetch }) {
  if (!alerts.length) return { sent: 0 };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, alerts.map((a) => JSON.stringify({ at: new Date().toISOString(), ...a })).join('\n') + '\n');
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { sent: 0, logged: alerts.length };
  let sent = 0;
  // logOnly: recorded, not sent (community comments; alerts folded into an evidence report).
  for (const a of alerts.filter((x) => !x.logOnly)) {
    try {
      const r = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: a.text })
      });
      if (r.ok) sent += 1;
    } catch { /* logged above; a failed alert must not stop the run */ }
  }
  return { sent, logged: alerts.length };
}
