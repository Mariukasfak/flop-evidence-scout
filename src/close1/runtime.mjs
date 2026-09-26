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
  writeErrors5m = 0, upstream = null, upstreamError = null, integrity = {}
}) {
  const res = ledger ? [...ledger.resolutions.values()] : [];
  const top = Array.isArray(pnl?.top) ? pnl.top : [];
  const rankIdx = top.findIndex((row) => Array.isArray(row) && row[0] === ourDid);
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
    reference_age_seconds: price?.ref?.time ? Math.round((nowMs - Date.parse(price.ref.time)) / 1000) : null,
    price_post_age_seconds: price?.postedAt ? Math.round((nowMs - Date.parse(price.postedAt)) / 1000) : null,
    last_flow_sweep: ledger?.latest ?? null,
    flow_counts: ledger?.latestFlowCounts ?? null,
    stream_cursor_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.cursor])),
    stream_gap_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.lastGap])),
    owner_state: ledger?.owner?.state ?? null,
    owner_evidence: ledger?.owner?.evidence ?? null,
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
    official_score: rankIdx >= 0 ? top[rankIdx][1] : null,
    local_replay_score: ledger?.replay.score ?? null,
    official_rank: rankIdx >= 0 ? rankIdx + 1 : null,
    official_rank_note: rankIdx >= 0 ? null : `not among the ${top.length} the referee lists`,
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
    gate: gate ?? null,
    trades: res.map((r) => ({
      id: r.id, status: r.status, evidence: r.evidence, ownership: r.ownership, basis: r.basis, sweep: r.sweep,
      void_reason: r.voidReason, effect: effectOf(r), terminal: isTerminal(r)
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
  const stale = (s) => s?.gate?.reasons?.includes('reference_stale') || s?.gate?.reasons?.includes('required_room_not_read_recently');
  if (stale(next) && !stale(prev)) add('referee_stale', 'close-1 referee/reference is stale — writes halted');
  if (prev) {
    const before = new Map((prev.trades || []).map((t) => [t.id, t]));
    for (const t of next.trades || []) {
      const was = before.get(t.id);
      if (t.terminal && (was?.status !== t.status || was?.evidence !== t.evidence)) {
        const own = t.status === STATUS.ID_SETTLED ? ' — the id settled; that it was OUR copy is not proven' : '';
        add('trade_resolved', `close-1 ${t.id}: ${t.status}${t.void_reason ? ` (${t.void_reason})` : ''}, evidence ${t.evidence}, ownership ${t.ownership}${own}`);
      }
    }
  }
  const top3 = (s) => s?.official_rank != null && s.official_rank <= 3;
  if (top3(next) && !top3(prev)) add('entered_top3', `close-1: we are #${next.official_rank}`);
  if (!top3(next) && top3(prev)) add('left_top3', 'close-1: we left the top 3');
  const halted = (s) => s?.gate && !s.gate.ok && s.gate.kind === 'halt';
  if (halted(next) && !halted(prev)) add('risk_gate_halt', `close-1 risk gate halted writes: ${next.gate.reasons.join(', ')}`);
  if ((next.write_errors_5m || 0) > 0 && !(prev?.write_errors_5m > 0)) add('write_failure', 'close-1 signing/posting failed; needs a look');
  return out;
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
  for (const a of alerts) {
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
