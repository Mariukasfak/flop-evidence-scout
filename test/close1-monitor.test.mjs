/**
 * close-1 EVIDENCE_ONLY monitoring (operator, 2026-09-29): what moves an alert,
 * what is only logged, and when the recommendation may change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceAlerts, withEvidenceReport, alertsBetween, deliverAlerts, REPORT_KINDS } from '../src/close1/runtime.mjs';
import { upstreamAlerts, communityNotes, ARCHIVE_ISSUE } from '../src/close1/upstream.mjs';
import { decide, MODE } from '../tools/close1-forensics.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const trade = (id, outcome, kind = null, over = {}) => ({
  id, status: 'UNKNOWN', evidence: 'UNKNOWN', terminal: true, corroborated_outcome: outcome, corroborated_settlement: outcome === 'UNKNOWN' ? 'UNKNOWN' : 'OFFICIALLY_CORROBORATED',
  corroboration: kind ? { kind, sweep: 300, record: 'OFFICIAL_INDEX_VERIFIED_REDACTED' } : null, ...over
});
const snap = (over = {}) => ({
  contest_verified: true, current_sweep: 1072, owner_state: 'MINT_CONFIRMED', owner_evidence: 'INFERRED_FOLD_ORDER', owner_confidence: 'OFFICIALLY_CORROBORATED',
  exposure_low: -4.5, exposure_high: 8.42, proven_position: 0, free_polf_worst_case: 6949.8,
  corroborated_account: { net_position: -1.9, unknown_range: { low: -1.9, high: -0.9 } },
  archive: { archive_status: 'LAGGING', archive_latest_sweep: 766, live_latest_sweep: 1072, archive_lag_sweeps: 306, archive_lag_minutes: 1530, archive_latest_changed_at: '2026-09-28T04:15:26Z', our_missing_sweeps: [], mismatch_sweeps: [] },
  evidence_summary: { recommended_next_mode: 'EVIDENCE_ONLY', reasons: ['archive lagging'] },
  trades: [trade('mfk-0ab', 'UNKNOWN'), trade('wrk73', 'SETTLED', 'SETTLED_OURS')],
  ...over
});

test('M1 a stalled archive and nothing else new: no alert at all', () => {
  const later = snap({ current_sweep: 1090, archive: { ...snap().archive, live_latest_sweep: 1090, archive_lag_sweeps: 324 } });
  assert.deepEqual(alertsBetween(snap(), later), []);
  assert.deepEqual(withEvidenceReport(snap(), later, []), []);
});

test('M2 a snapshot from before these fields is a baseline, not a change', () => {
  const old = snap({ trades: [{ id: 'mfk-0ab', status: 'UNKNOWN', terminal: true }], evidence_summary: undefined });
  assert.deepEqual(evidenceAlerts(old, snap()), []);
});

test('M3 an UNKNOWN resolving and a corroborated result changing alert, each once', () => {
  const next = snap({ trades: [trade('mfk-0ab', 'NOT_SETTLED', 'NOT_SETTLED'), trade('wrk73', 'NOT_SETTLED', 'SETTLED_NOT_OURS')] });
  const k = evidenceAlerts(snap(), next);
  assert.deepEqual(k.map((a) => a.kind), ['unknown_resolved', 'corroboration_changed']);
  assert.match(k[0].text, /mfk-0ab: UNKNOWN → NOT_SETTLED/);
  assert.match(k[1].text, /SETTLED_OURS.*→ NOT_SETTLED \(SETTLED_NOT_OURS/);
});

test('M4 stronger owner evidence, a moved proven range and a changed mode alert; weaker owner evidence does not', () => {
  const kinds = (next) => evidenceAlerts(snap(), next).map((a) => a.kind);
  assert.deepEqual(kinds(snap({ owner_confidence: 'PROVEN' })), ['owner_stronger']);
  assert.deepEqual(kinds(snap({ owner_confidence: 'INFERRED' })), []);
  assert.deepEqual(kinds(snap({ exposure_low: -1.9 })), ['proven_exposure_changed']);
  assert.deepEqual(kinds(snap({ evidence_summary: { recommended_next_mode: 'SAFE_RESUME_CANDIDATE', reasons: [] } })), ['mode_changed']);
});

test('M5 a proven settlement is its own kind', () => {
  const next = snap({ trades: [trade('mfk-0ab', 'UNKNOWN'), trade('wrk73', 'SETTLED', 'SETTLED_OURS', { status: 'SETTLED_PROVEN', evidence: 'OFFICIAL_ARCHIVE' })] });
  assert.ok(alertsBetween(snap(), next).some((a) => a.kind === 'settled_proven'));
});

test('M6 a meaningful change becomes one report in seven points; the folded alerts are kept, log only', () => {
  const next = snap({
    archive: { ...snap().archive, archive_status: 'CURRENT', archive_latest_sweep: 1071, archive_lag_sweeps: 1, archive_lag_minutes: 5, archive_latest_changed_at: '2026-09-29T09:00:00Z' },
    trades: [trade('mfk-0ab', 'NOT_SETTLED', 'NOT_SETTLED'), trade('wrk73', 'SETTLED', 'SETTLED_OURS')],
    evidence_summary: { recommended_next_mode: 'SAFE_RESUME_CANDIDATE', reasons: [] }
  });
  const out = withEvidenceReport(snap(), next, alertsBetween(snap(), next));
  const report = out.filter((a) => a.kind === 'evidence_report');
  assert.equal(report.length, 1);
  assert.ok(out.filter((a) => REPORT_KINDS.has(a.kind)).every((a) => a.logOnly));
  for (let i = 1; i <= 7; i++) assert.match(report[0].text, new RegExp(`\\n${i}\\. `));
  assert.match(report[0].text, /archive caught up/);
  assert.match(report[0].text, /mfk-0ab: UNKNOWN → NOT_SETTLED/);
  assert.match(report[0].text, /EVIDENCE_ONLY → SAFE_RESUME_CANDIDATE \(CHANGED\)/);
  assert.match(report[0].text, /NOT USED FOR SIGNING OR RISK APPROVAL/);
  assert.match(report[0].text, /7\. Operator action: review the new recommendation/);
});

test('M7 an account conflict is still sent on its own, with its facts', () => {
  const next = snap({ account_comparison: { conflicts: [{ kind: 'CORROBORATED_OUTSIDE_PROVEN_RANGE', detail: 'corroborated -6 outside proven -4.5 … 8.42' }] } });
  const out = withEvidenceReport(snap(), next, alertsBetween(snap(), next));
  assert.deepEqual(out.map((a) => [a.kind, Boolean(a.logOnly)]), [['account_conflict', false]]);
  assert.match(out[0].text, /outside proven -4.5/);
});

test('M8 log-only alerts are written, never sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1m-'));
  const sent = [];
  const fetchFn = async (_u, o) => { sent.push(JSON.parse(o.body).text); return { ok: true }; };
  const r = await deliverAlerts([{ kind: 'community_comment', logOnly: true, text: 'a' }, { kind: 'evidence_report', text: 'b' }],
    { logFile: path.join(dir, 'a.jsonl'), env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' }, fetchFn });
  assert.deepEqual(sent, ['🟡 SVARBU\nb']);
  assert.equal(r.logged, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8').trim().split('\n').length, 2);
});

const W = (newSince, over = {}) => ({ watched: { [ARCHIVE_ISSUE]: { repo: 'flop-labs/technocore-close-call-challenge', n: 15, priority: 'HIGH', topic: 'archive lag', state: 'open', comments: 2, newSince, ...over } } });

test('M9 #15: a maintainer answer is sent and tagged by what it settles; community comments are logged only', () => {
  const prev = W([], { comments: 1 });
  const svText = 'We will backfill sweeps after 766 before the lock and publish hourly from now on.';
  assert.equal(upstreamAlerts(prev, W([{ id: 2, author: 'sv', association: 'NONE', text: svText }]), { packageSha256: null }).length, 0, 'sv with NONE and no proof of publishing to the official main is a community voice');
  const sv = upstreamAlerts(prev, { ...W([{ id: 2, author: 'sv', association: 'NONE', text: svText }]), committers: ['sv'] }, { packageSha256: null });
  assert.equal(sv.length, 1);
  assert.match(sv[0].text, /\[mentions: backfill, cadence, before the lock\]/);
  const who = (author, text) => communityNotes(prev, W([{ id: 2, author, association: 'NONE', text }]));
  assert.deepEqual(who('ktrxktr', 'Confirmed on my side too: index still ends at 766 this morning.').map((a) => [a.kind, a.logOnly]), [['community_comment', true]]);
  assert.deepEqual(who('ktrxktr', 'The redacted file for sweep 700 does not match the sha256 in index.json.').map((a) => [a.kind, a.logOnly]), [['community_integrity_claim', false]]);
  assert.deepEqual(who('Mariukasfak', 'Adding one participant-side data point from flop-evidence-scout.'), [], 'our own comment is not news');
  assert.deepEqual(communityNotes(null, W([{ id: 2, author: 'x', text: 'y'.repeat(60) }])), [], 'first look is a baseline');
});

const ledger = { exposure: { definite: 0, low: -4.5, high: 8.42, worstFreePolf: 6949.8 } };
const row = (outcome, own = 'OFFICIALLY_CORROBORATED') => ({ outcome, ownership_confidence: own, settlement_confidence: own });

test('M10 the recommendation lifts only on evidence that makes a new trade checkable', () => {
  const lagging = { archive_status: 'LAGGING', archive_lag_sweeps: 306, our_missing_sweeps: [] };
  const current = { archive_status: 'CURRENT', archive_lag_sweeps: 1, our_missing_sweeps: [] };
  const none = { conflicts: [] };
  const allKnown = [row('SETTLED'), row('NOT_SETTLED')];
  let d = decide({ rows: [row('UNKNOWN'), row('SETTLED')], ledger, comparison: none, archive: lagging, attempts: 20 });
  assert.equal(d.recommended_next_mode, MODE.EVIDENCE_ONLY);
  d = decide({ rows: allKnown, ledger, comparison: none, archive: lagging, attempts: 20 });
  assert.equal(d.recommended_next_mode, MODE.EVIDENCE_ONLY, 'unknowns resolving alone is not enough while the archive lags');
  assert.deepEqual(d.evidence_improvements, ['no trade remains unknown']);
  assert.ok(d.reasons.some((r) => /could not be checked/.test(r)));
  assert.equal(decide({ rows: allKnown, ledger, comparison: none, archive: current, attempts: 20 }).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  assert.equal(decide({ rows: allKnown, ledger, comparison: none, archive: { ...current, our_missing_sweeps: [300] }, attempts: 20 }).recommended_next_mode, MODE.EVIDENCE_ONLY);
  assert.equal(decide({ rows: allKnown, ledger, comparison: none, archive: lagging, attempts: 20, officialLookup: true }).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  assert.equal(decide({ rows: allKnown, ledger, comparison: { conflicts: [{}] }, archive: current, attempts: 20 }).recommended_next_mode, MODE.HOLD);
});
