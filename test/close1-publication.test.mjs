/**
 * Archive publication health (operator, 2026-09-29): one batch catch-up is not a stable archive,
 * and SAFE_RESUME_CANDIDATE must not flip with a one-cycle lag difference. The operator lock never moves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicationHealth, publicationTransition, PUBLICATION as P, STABLE_MAX_LAG, MIN_INDEPENDENT_ADVANCES, lastModifiedAgeMin } from '../src/close1/publication.mjs';
import { archiveHealth, ARCHIVE_STATUS } from '../src/close1/archive.mjs';
import { archiveAlerts } from '../src/close1/runtime.mjs';
import { decide, MODE } from '../tools/close1-forensics.mjs';
import { selectForTelegram, DEFAULT_SETTINGS, fmtArchive, severityOf } from '../src/close1/telegram-bot.mjs';
import { readOperatorLock, readWrites } from '../src/close1/operator-lock.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T09:00:00Z');
const lmOf = (t) => new Date(T0 + t * MIN).toUTCString();

/** Drive the state machine with readings {t (minutes), latest, live, lm}, as 20-minute cycles would. */
function drive(steps, start = null) {
  let pub = start; const all = [];
  for (const s of steps) {
    pub = publicationHealth(pub, { latest: s.latest, live: s.live, lag: s.live - s.latest, lastModified: s.lm ?? null, nowMs: T0 + s.t * MIN });
    all.push(pub);
  }
  return all;
}
const every20 = (from, to, f) => { const out = []; for (let t = from; t <= to; t += 20) out.push(f(t)); return out; };
const live = (t) => 1128 + Math.floor(t / 5);
const recoveringAfterBatch = () => drive([{ t: 0, latest: 766, live: 1100 }, { t: 20, latest: 1119, live: 1128, lm: lmOf(19) }]).at(-1);

test('P1. an archive that has not moved for a long time is STALLED, and stays so', () => {
  const runs = drive(every20(0, 200, (t) => ({ t, latest: 766, live: 766 + 330 + t / 5 })));
  assert.ok(runs.every((p) => p.state === P.STALLED));
  assert.match(runs[0].reason, /no history/);
});

test('P2. one batch 766 -> 1119 is RECOVERING, not STABLE', () => {
  const s = [...every20(0, 60, (t) => ({ t, latest: 766, live: live(t) - 300 })), { t: 80, latest: 1119, live: 1128, lm: lmOf(45) }];
  const runs = drive(s);
  const last = runs.at(-1);
  assert.equal(runs.at(-2).state, P.STALLED);
  assert.equal(last.state, P.RECOVERING);
  assert.equal(last.last_advance_jump, 1119 - 766);
  assert.equal(last.independent_advances, 0);
});

test('P3. after the batch nothing moves for several cycles: back to STALLED', () => {
  const start = recoveringAfterBatch();
  assert.equal(start.state, P.RECOVERING);
  // 10:04, 10:24 ... and still 1119 hours later, as in the real data
  const runs = drive(every20(40, 220, (t) => ({ t, latest: 1119, live: live(t) })), start);
  assert.equal(runs[0].state, P.RECOVERING, 'two quiet cycles are not yet a stall');
  assert.equal(runs.at(-1).state, P.STALLED);
  assert.match(runs.at(-1).reason, /no advance for/);
  assert.match(publicationTransition(start, runs.at(-1)), /RECOVERING → STALLED/);
});

test('P4. several independent later advances make it STABLE, not before', () => {
  let pub = recoveringAfterBatch();
  const step = (t, latest, lm) => { pub = drive([{ t, latest, live: latest + 8, lm }], pub)[0]; return pub; };
  assert.equal(step(70, 1131, lmOf(69)).state, P.RECOVERING);
  assert.equal(step(120, 1143, lmOf(119)).state, P.RECOVERING);
  assert.equal(pub.independent_advances, 2);
  const stable = step(170, 1155, lmOf(169));
  assert.equal(stable.state, P.STABLE);
  assert.equal(stable.independent_advances, MIN_INDEPENDENT_ADVANCES);
  // advances with an unchanged Last-Modified are not independent publications
  let same = recoveringAfterBatch();
  for (const [t, l] of [[70, 1131], [120, 1143], [170, 1155]]) same = drive([{ t, latest: l, live: l + 8, lm: lmOf(19) }], same)[0];
  assert.equal(same.state, P.RECOVERING);
});

const health = (pub, lag, extra = {}) => ({
  archive_status: lag <= 12 ? ARCHIVE_STATUS.CURRENT : ARCHIVE_STATUS.LAGGING, archive_latest_sweep: 1119, live_latest_sweep: 1119 + lag, archive_lag_sweeps: lag,
  pending_sweeps: 0, mismatch_sweeps: [], our_missing_sweeps: [], archive_cache_valid: true, publication: pub, ...extra
});
const decideArgs = (archive) => ({ rows: [], ledger: { exposure: { definite: 0, low: -4.5, high: 8.42, worstFreePolf: 1 } }, comparison: { conflicts: [] }, archive, attempts: 20 });

test('P5/P6. a lag of 9 in one cycle does not make it SAFE; a lag of 13 later does not undo a stable state', () => {
  const recovering = recoveringAfterBatch();
  const d9 = decide(decideArgs(health(recovering, 9)));
  assert.equal(d9.recommended_next_mode, MODE.EVIDENCE_ONLY, 'CURRENT by lag alone, but only RECOVERING');
  assert.match(d9.reasons.join(' '), /publication is RECOVERING/);
  const stable = { ...recovering, state: P.STABLE };
  assert.equal(decide(decideArgs(health(stable, 9))).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  assert.equal(decide(decideArgs(health(stable, 13))).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  assert.equal(archiveAlerts(health(stable, 9), health(stable, 13)).length, 0, 'no lag-threshold alert');
  assert.equal(archiveAlerts(health(stable, 13), health(stable, 9)).length, 0);
});

test('P7. STABLE plus the auditability conditions gives SAFE_RESUME_CANDIDATE; missing any of them does not', () => {
  const base = health({ state: P.STABLE, reason: 'x' }, 5);
  assert.equal(decide(decideArgs(base)).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  for (const bad of [{ our_missing_sweeps: [700] }, { pending_sweeps: 3 }, { mismatch_sweeps: [900] }, { archive_cache_valid: false }, { archive_lag_sweeps: STABLE_MAX_LAG + 1 },
    { publication: { state: P.STALLED, reason: 'x' } }, { publication: { state: P.RECOVERING, reason: 'x' } }]) {
    assert.equal(decide(decideArgs({ ...base, ...bad })).recommended_next_mode, MODE.EVIDENCE_ONLY, JSON.stringify(bad));
  }
  assert.equal(decide({ ...decideArgs(base), comparison: { conflicts: ['x'] } }).recommended_next_mode, MODE.HOLD);
});

test('P8/P9. the recommendation never touches the operator lock or the write counters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close1-pub-'));
  fs.writeFileSync(path.join(dir, 'operator-mode.json'), JSON.stringify({ mode: 'EVIDENCE_ONLY' }));
  fs.writeFileSync(path.join(dir, 'host-role.json'), JSON.stringify({ host: 'MINI_PC', writer: true }));
  const snap = () => fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const before = snap();
  const d = decide(decideArgs(health({ state: P.STABLE, reason: 'x' }, 2)));
  assert.equal(d.recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  assert.match(d.note, /Recommendation for a person only/);
  const lock = readOperatorLock(dir);
  assert.equal(lock.mode, 'EVIDENCE_ONLY');
  assert.equal(lock.writes_allowed, false);
  assert.equal(readWrites(dir).actual, 0);
  assert.deepEqual(snap(), before);
});

test('P10. Telegram gets only meaningful state transitions, not lag jitter', () => {
  const seq = [
    { t: 0, latest: 766, live: 1100 }, { t: 20, latest: 766, live: 1104 },
    { t: 40, latest: 1119, live: 1128, lm: lmOf(39) },
    { t: 60, latest: 1119, live: 1132 },
    { t: 100, latest: 1131, live: 1140, lm: lmOf(99) }, { t: 150, latest: 1143, live: 1152, lm: lmOf(149) }, { t: 200, latest: 1155, live: 1164, lm: lmOf(199) },
    { t: 220, latest: 1155, live: 1168 }, { t: 240, latest: 1155, live: 1172 },
    { t: 260, latest: 1167, live: 1176, lm: lmOf(259) }, { t: 280, latest: 1167, live: 1180 },
    { t: 500, latest: 1167, live: 1240 }
  ];
  let pub = null; const hs = [];
  for (const s of seq) {
    pub = publicationHealth(pub, { latest: s.latest, live: s.live, lag: s.live - s.latest, lastModified: s.lm ?? null, nowMs: T0 + s.t * MIN });
    hs.push({ archive_status: s.live - s.latest <= 12 ? 'CURRENT' : 'LAGGING', archive_latest_sweep: s.latest, live_latest_sweep: s.live, archive_lag_sweeps: s.live - s.latest, publication: pub });
  }
  const alerts = [];
  for (let i = 1; i < hs.length; i++) alerts.push(...archiveAlerts(hs[i - 1], hs[i]));
  assert.deepEqual(alerts.map((a) => a.kind), ['publication_transition', 'publication_transition', 'publication_transition']);
  assert.deepEqual(alerts.map((a) => a.text.match(/(\w+) → (\w+)/).slice(1, 3).join('>')), ['STALLED>RECOVERING', 'RECOVERING>STABLE', 'STABLE>STALLED']);
  assert.ok(alerts.every((a) => !['archive_lagging', 'archive_current', 'archive_advanced'].includes(a.kind)));
  assert.equal(severityOf('publication_transition'), 'IMPORTANT');
  assert.equal(selectForTelegram(alerts, DEFAULT_SETTINGS).send.length, 3);
  assert.equal(selectForTelegram(alerts, { ...DEFAULT_SETTINGS, quiet_mode: true }).send.length, 0);
});

test('P11. without publication history the old alerts still work (older snapshots)', () => {
  const a = { archive_status: 'CURRENT', archive_latest_sweep: 700, live_latest_sweep: 705, archive_lag_sweeps: 5 };
  const b = { archive_status: 'LAGGING', archive_latest_sweep: 700, live_latest_sweep: 760, archive_lag_sweeps: 60, archive_lag_minutes: 300 };
  assert.deepEqual(archiveAlerts(a, b).map((x) => x.kind), ['archive_lagging']);
});

test('P12. archiveHealth carries the publication state from one cycle to the next', () => {
  const idx = (n) => new Map([[n, { n, status: 'full' }]]);
  const h1 = archiveHealth({ index: idx(766), liveLatest: 1100, prev: null, nowMs: T0, lastModified: lmOf(-500) });
  assert.equal(h1.publication.state, P.STALLED);
  const h2 = archiveHealth({ index: idx(1119), liveLatest: 1128, prev: h1, nowMs: T0 + 20 * MIN, lastModified: lmOf(19) });
  assert.equal(h2.publication.state, P.RECOVERING);
  const h3 = archiveHealth({ index: null, error: 'HTTP 500', liveLatest: 1130, prev: h2, nowMs: T0 + 40 * MIN });
  assert.equal(h3.publication.state, P.RECOVERING, 'an unreadable index invents no event');
  assert.equal(lastModifiedAgeMin(lmOf(-30), T0), 30);
});

test('P13. /archive shows the publication facts an operator needs', () => {
  const pub = recoveringAfterBatch();
  const snap = { archive: { archive_status: 'LAGGING', archive_latest_sweep: 1119, live_latest_sweep: 1132, archive_lag_sweeps: 13, archive_lag_minutes: 65, archive_index_last_modified: lmOf(19),
    archive_latest_changed_at: new Date(T0 + 20 * MIN).toISOString(), archive_cache_present: 130, archive_cache_required: 130, archive_cache_valid: true, mismatch_sweeps: [], our_missing_sweeps: [], publication: pub } };
  const text = fmtArchive(snap, T0 + 60 * MIN);
  assert.match(text, /Publication: RECOVERING/);
  assert.match(text, /Latest: 1119 · live: 1132 · lag: 13/);
  assert.match(text, /Last-Modified: .*amžius 41 min/);
  assert.match(text, /766 → 1119, \+353/);
  assert.match(text, /0\/3 nepriklausomų/);
});
