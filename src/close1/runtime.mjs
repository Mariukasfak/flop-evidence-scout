/**
 * One machine-readable runtime snapshot for close-1, and the alerts that a
 * change between two snapshots deserves.
 *
 * The snapshot is what a dashboard shows. Alerts are only for changes that
 * need a human: nothing is sent while things stay healthy, so a Telegram
 * channel fed from `alertsBetween` stays quiet on a good day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectOf, STATUS } from './ledger.mjs';

export function buildSnapshot({ contest, contestError = null, streams, price, ledger, pnl, ourDid, trades, gate, nowMs, writeErrors5m = 0 }) {
  const res = ledger ? [...ledger.resolutions.values()] : [];
  const top = Array.isArray(pnl?.top) ? pnl.top : [];
  const rankIdx = top.findIndex((row) => Array.isArray(row) && row[0] === ourDid);
  const latencies = (trades || []).filter((t) => t.role === 'maker')
    .map((t) => { const k = (t.takers || []).find((x) => x.valid); return k ? Date.parse(k.ts) - Date.parse(t.postedAt) : null; })
    .filter((x) => Number.isFinite(x));
  const streamStats = streams || {};
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
    stream_cursor_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.cursor])),
    stream_gap_by_room: Object.fromEntries(Object.entries(streamStats).map(([r, s]) => [r, s.lastGap])),
    owner_state: ledger?.owner?.state ?? null,
    owner_evidence: ledger?.owner?.evidence ?? null,
    free_polf: ledger?.replay.freePolf ?? null,
    collateral: ledger?.replay.collateral ?? null,
    net_position: ledger?.replay.netPosition ?? null,
    exposure_low: ledger?.exposure.low ?? null,
    exposure_high: ledger?.exposure.high ?? null,
    average_entry: ledger?.replay.averageEntry ?? null,
    fees: ledger?.replay.fees ?? null,
    fees_exact: ledger?.replay.feesExact ?? null,
    official_score: rankIdx >= 0 ? top[rankIdx][1] : null,
    local_replay_score: ledger?.replay.score ?? null,
    official_rank: rankIdx >= 0 ? rankIdx + 1 : null,
    official_rank_note: rankIdx >= 0 ? null : `not among the ${top.length} the referee lists`,
    pending_trades: ledger?.pending ?? [],
    settled_count: ledger?.settledCount ?? 0,
    void_count_by_reason: ledger?.voidCounts ?? {},
    maker_fill_latency_ms: latencies.length ? latencies : null,
    read_errors_5m: Object.values(streamStats).reduce((s, x) => s + (x.errors5m || 0), 0),
    write_errors_5m: writeErrors5m,
    last_successful_referee_read: Object.entries(streamStats).filter(([r]) => r.startsWith('d-close1-'))
      .map(([, s]) => s.lastOkAt).filter(Boolean).sort().at(-1) ?? null,
    gate: gate ?? null,
    trades: res.map((r) => ({ id: r.id, status: r.status, evidence: r.evidence, basis: r.basis, attributed: r.attributed, sweep: r.sweep, void_reason: r.voidReason, effect: effectOf(r) }))
  };
}

const TERMINAL = new Set([STATUS.SETTLED, STATUS.VOID, STATUS.NOT_SETTLED]);

/** Alerts for what changed from `prev` to `next`. Healthy-and-unchanged yields []. */
export function alertsBetween(prev, next) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (!next.contest_verified && (prev?.contest_verified ?? true)) add('contest_verification_failed', `close-1 contest check FAILED: ${next.contest_error ?? 'unknown'} — writes halted`);
  if (next.contest_verified && prev && !prev.contest_verified) add('contest_verification_restored', 'close-1 contest check passes again');
  const minted = (s) => s === 'MINT_CONFIRMED' || s === 'ACTIVE';
  if (prev && minted(next.owner_state) && !minted(prev.owner_state)) add('mint_confirmed', `close-1 owner mint confirmed (${next.owner_evidence})`);
  for (const [room, gap] of Object.entries(next.stream_gap_by_room || {})) {
    if (!room.startsWith('d-close1-') || !gap) continue;
    if (gap.at !== prev?.stream_gap_by_room?.[room]?.at) add('stream_gap', `gap in ${room}: ${gap.kind} ${gap.from}…${gap.to}`);
  }
  const stale = (s) => s?.gate?.reasons?.includes('reference_stale') || s?.gate?.reasons?.includes('required_room_not_read_recently');
  if (stale(next) && !stale(prev)) add('referee_stale', 'close-1 referee/reference is stale — writes halted');
  const before = new Map((prev?.trades || []).map((t) => [t.id, t]));
  for (const t of next.trades || []) {
    const was = before.get(t.id);
    if (!prev) break;   // the first snapshot is a baseline, not news
    const exhausted = t.status === STATUS.UNKNOWN && t.basis === 'PROBES_EXHAUSTED';
    if ((TERMINAL.has(t.status) || exhausted) && (was?.status !== t.status || was?.basis !== t.basis)) {
      add('trade_resolved', `close-1 ${t.id}: ${t.status}${t.void_reason ? ` (${t.void_reason})` : ''}, evidence ${t.evidence}${t.attributed ? '' : ', not attributable to our copy'}`);
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
