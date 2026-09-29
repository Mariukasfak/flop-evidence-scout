/**
 * The official archive, the Rule 11 reference, and Rule 18 ties (2026-09-28).
 * Numbered tests are the ten cases the operator asked for before any live change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { sweepTime } from '../src/close1/protocol.mjs';
import { buildLedger, resolveTrade, STATUS, EVIDENCE, OWNERSHIP, OWNER } from '../src/close1/ledger.mjs';
import {
  parseIndex, archiveHealth, classifyRecord, extractRecord, archiveVerdict, archiveMint, reconcileArchive, neededSweeps,
  RECORD, ARCHIVE_STATUS, LAG_TOLERANCE_SWEEPS
} from '../src/close1/archive.mjs';
import { approveTrade, DEFAULT_POLICY, REASON, referenceStatus } from '../src/close1/risk-gate.mjs';
import { decide } from '../src/close1/strategy.mjs';
import { buildSnapshot, alertsBetween, archiveAlerts, standingOf, PRIZE_STATUS } from '../src/close1/runtime.mjs';
import { classifyTrade, corroboratedAccount, compareAccounts, CORROBORATED_LABEL } from '../src/close1/corroborated.mjs';
import { watchUpstream, makeGitHub, RateLimited } from '../src/close1/upstream.mjs';
import { PINNED } from '../src/close1/contest-source.mjs';

const me = generateIdentity();
const stranger = generateIdentity();
const other = generateIdentity();
const OUR = me.did;
const NOW = Date.UTC(2026, 8, 28, 19, 30);
const iso = (ms) => new Date(ms).toISOString();
const at = (n) => iso(sweepTime(n) - 60_000);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'close1-archive-'));

const flow = (n, over = {}) => ({ t: 'flow', n, settled: [], void: [], omitted: {}, mints: [], missed: [], ...over });
const flowsTo = (top, special = {}) => new Map(Array.from({ length: top }, (_, i) => [i + 1, special[i + 1] ?? flow(i + 1)]));
const prices = (top) => new Map(Array.from({ length: top }, (_, i) => [i + 1, { t: 'price', n: i + 1, ref: { px: '224.00' } }]));
const registration = { did: OUR, postedAt: at(2) };
const offer = (id, n, over = {}) => ({ role: 'maker', id, maker: OUR, ourSide: 'buy', qty: '0.50', px: '224.00', until: n + 2, postedAt: at(n), ...over });
const take = (id, n, over = {}) => ({ id, maker: stranger.did, ourSide: 'sell', qty: '1.00', px: '224.00', until: n + 10, postedAt: at(n), text: '{}', ...over });

/** One sweep record in the fold's output shape. */
function sweepRecord(n, { trades = [], minted = [], redact = 0 } = {}) {
  const input = { close: '224.00', n, owners: minted, ref: '224.00', t: 'sweep', trades: [] };
  const output = { close: '224.00', global_price: '224.00', minted, reference: '224.00', sweep: n, trades: [] };
  for (const t of trades) {
    input.trades.push({ countersigner: t.countersigner, id: t.id, maker: t.maker, px: t.px ?? '224.00', qty: t.qty ?? '0.50', side: t.side ?? 'buy', taker: 'any', until: t.until ?? n + 5 });
    output.trades.push(t.outcome === 'settled' ? { id: t.id, maker_fee: '1.120000', outcome: 'settled', taker_fee: '1.120000' } : { id: t.id, outcome: 'void', reason: t.reason ?? 'expired' });
  }
  for (let i = 0; i < redact; i++) { input.trades.push({ redacted: 'private room' }); output.trades.push({ id: `p${i}`, outcome: 'settled', maker_fee: '1', taker_fee: '1' }); }
  return Buffer.from(JSON.stringify({ input, output }));
}

/**
 * A fake archive: `full` records hash to the signed file; `redacted` ones carry
 * the index's own sha256 and a signed file hash of the (unseen) full record.
 */
function fakeArchive(records, { upTo = Math.max(...Object.keys(records).map(Number)) } = {}) {
  const signedFiles = new Map(); const byPath = new Map(); const sweeps = [];
  for (let n = 1; n <= upTo; n++) {
    const spec = records[n] ?? { bytes: sweepRecord(n) };
    const bytes = spec.bytes;
    const full = !spec.redacted;
    const file = full ? sha(bytes) : sha(Buffer.from(`unredacted ${n}`));
    signedFiles.set(n, spec.signedFile ?? file);
    const p = full ? `sweeps/${file}.json` : `redacted/${file}.json`;
    byPath.set(p, spec.serve ?? bytes);
    sweeps.push(full ? { n, file, path: p, status: 'full', bytes: bytes.length } : { n, file, path: p, status: 'redacted', sha256: sha(bytes), redacted: 1, bytes: bytes.length });
  }
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const rel = url.replace('https://challenges.technocore.chat/close-1/', '');
    const body = rel === 'index.json' ? Buffer.from(JSON.stringify({ contest: 'close-1', sweeps })) : byPath.get(rel);
    if (!body) return { ok: false, status: 404, headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: (h) => (h === 'etag' ? `"${sha(body).slice(0, 8)}"` : null) }, text: async () => body.toString(), arrayBuffer: async () => body };
  };
  return { signedFiles, fetchFn, calls };
}

async function reconcile(trades, archive, { cacheDir = tmp(), liveLatest = 40 } = {}) {
  const a = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: archive.signedFiles, liveLatest, cacheDir, nowMs: NOW, fetchFn: archive.fetchFn });
  const verdicts = new Map(trades.map((t) => [t.id, archiveVerdict(t, { records: a.records, ourDid: OUR })]));
  return { ...a, verdicts, cacheDir };
}

// ---------------------------------------------------------------- P0-B: the reference (Rule 11)

function healthy(price) {
  const ledger = buildLedger({ trades: [], registration, flows: flowsTo(40, { 3: flow(3, { mints: [OUR] }) }), prices: prices(40), ourDid: OUR });
  return {
    contest: { verified: true, refereeDid: 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte', lockSweep: 2556 },
    observedRefereeDids: [], refereeSigFailures: 0,
    streams: { 'd-close1-price': { lastOkAt: iso(NOW - 5_000), lastGap: null }, 'd-close1-flow': { lastOkAt: iso(NOW - 5_000), lastGap: null } },
    price, ledger, attempts: 0
  };
}
const proposal = () => decide({ ourDid: OUR, ref: 224, nextSweep: 41, netPosition: 0, idHint: 'mfk-t' }, DEFAULT_POLICY);

test('1. a fresh signed price post with a 2 h old reference trade is NOT a halt (Rule 11, close-call #9)', () => {
  const price = { n: 40, for: 41, age_s: 8400, ref: { px: '224.00', time: iso(NOW - 60_000 - 8400_000) }, postedAt: iso(NOW - 60_000) };
  const g = approveTrade(healthy(price), proposal(), DEFAULT_POLICY, NOW);
  assert.deepEqual(g, { ok: true, reasons: [] });
  const r = referenceStatus(price, DEFAULT_POLICY, NOW);
  assert.equal(r.reference_age_at_post_seconds, 8400, 'the age the referee states in the post');
  assert.equal(r.reference_stale_by_market_time, true);
  assert.equal(r.reference_warning, 'REFERENCE_TRADE_OLD');
  assert.equal(r.price_post_age_seconds, 60);
  assert.equal(referenceStatus({ ...price, age_s: undefined, ref: { ...price.ref, age_s: 8400 } }, DEFAULT_POLICY, NOW).reference_age_at_post_seconds, 8400, 'ref.age_s is read too');
  // The protocol band is still measured against the PUBLISHED reference.
  const far = { ...proposal(), terms: { ...proposal().terms, px: '240.00' } };
  assert.ok(approveTrade(healthy(price), far, DEFAULT_POLICY, NOW).reasons.includes(REASON.PRICE_PROTOCOL));
});

test('2. a price post 10+ minutes old, or none at all, is a hard halt', () => {
  const stale = { n: 40, for: 41, age_s: 4, ref: { px: '224.00', time: iso(NOW - 11 * 60_000) }, postedAt: iso(NOW - 11 * 60_000) };
  assert.ok(approveTrade(healthy(stale), proposal(), DEFAULT_POLICY, NOW).reasons.includes(REASON.PRICE_POST_STALE));
  assert.ok(approveTrade(healthy(null), proposal(), DEFAULT_POLICY, NOW).reasons.includes(REASON.REFERENCE_MISSING));
  assert.ok(approveTrade(healthy({ n: 40, ref: { px: '224.00' }, postedAt: 'garbage' }), proposal(), DEFAULT_POLICY, NOW).reasons.includes(REASON.PRICE_POST_STALE), 'an unreadable stamp fails closed');
});

// ---------------------------------------------------------------- P0-C: ties (Rule 18, close-call #8)

test('3. equal pnl scores are ONE tie sharing the places it spans, not sequential ranks', () => {
  const [A, B, C, D] = ['did:key:z6MkA', 'did:key:z6MkB', 'did:key:z6MkC', 'did:key:z6MkD'];
  const top = [[A, '100.00'], [B, '50.00'], [OUR, '50.00'], [C, '50.00'], [D, '10.00']];
  const s = standingOf(top, OUR);
  assert.equal(s.leaderboard_display_row, 3, 'display row, kept only as that');
  assert.deepEqual([s.tie_score, s.tie_visible_count, s.tie_complete, s.rows_strictly_above], ['50.00', 3, true, 1]);
  assert.deepEqual([s.prize_places, s.prize_sharing], [[2, 3], 3]);
  assert.equal(s.prize_place_status, PRIZE_STATUS.PROVISIONAL, 'live mark, not the final S');
  assert.deepEqual(standingOf(top, B).prize_places, s.prize_places, 'every member of the tie gets the same places');
  assert.deepEqual(standingOf(top, C).prize_places, s.prize_places, 'DID order does not matter');
  assert.deepEqual(standingOf([[A, '9'], [B, '8'], [C, '7'], [OUR, '6'], [D, '1']], OUR).prize_places, [], 'fourth alone: no place');
  assert.equal(standingOf(top, 'did:key:z6MkNobody').prize_place_status, PRIZE_STATUS.NOT_LISTED);
  assert.equal(standingOf([[OUR, '5'], [A, '9'], [B, '1']], OUR).prize_place_status, PRIZE_STATUS.UNORDERED, 'rows out of score order are not trusted');
});

test('4. a tie that reaches the end of the truncated list: prize place UNKNOWN, and nothing is announced', () => {
  // Sweep 952 (2026-09-28): all 25 visible rows at 743.97.
  const top = Array.from({ length: 25 }, (_, i) => [i === 7 ? OUR : `did:key:z6Mk${String(i).padStart(2, '0')}`, '743.97']);
  const s = standingOf(top, OUR);
  assert.equal(s.tie_complete, false);
  assert.equal(s.prize_places, null);
  assert.equal(s.prize_place_status, PRIZE_STATUS.TIE_TRUNCATED);
  assert.equal(s.prize_confidence, 'NONE');
  const snap = buildSnapshot({ contest: null, streams: {}, price: null, ledger: null, pnl: { n: 952, top }, ourDid: OUR, trades: [], gate: null, nowMs: NOW });
  assert.equal(snap.leaderboard_display_row, 8);
  assert.ok(!('official_rank' in snap), 'no field calls a display row a rank');
  const prev = buildSnapshot({ contest: null, streams: {}, price: null, ledger: null, pnl: { n: 951, top: [] }, ourDid: OUR, trades: [], gate: null, nowMs: NOW });
  assert.deepEqual(alertsBetween(prev, snap).filter((a) => /top3|place/.test(a.kind)), [], 'no top-3 alert from a display row');
  const complete = buildSnapshot({ contest: null, streams: {}, price: null, ledger: null, pnl: { n: 952, top: [[OUR, '9'], ['did:key:z6MkX', '1']] }, ourDid: OUR, trades: [], gate: null, nowMs: NOW });
  assert.deepEqual(alertsBetween(prev, complete).filter((a) => /top3|place/.test(a.kind)), [], 'not even for a complete tie at the live mark');
});

// ---------------------------------------------------------------- P0-A: the archive

test('5. a full record whose hash matches the signed file, naming our maker/countersigner: SETTLED_PROVEN, OFFICIAL_ARCHIVE', async () => {
  const mk = offer('mfk-full', 10);
  const tk = take('tk-full', 12);
  const arch = fakeArchive({
    10: { bytes: sweepRecord(10, { trades: [{ id: 'mfk-full', maker: OUR, countersigner: stranger.did, outcome: 'settled' }] }) },
    12: { bytes: sweepRecord(12, { trades: [{ id: 'tk-full', maker: stranger.did, countersigner: other.did, qty: '1.00', outcome: 'void', reason: 'settled' }, { id: 'tk-full', maker: stranger.did, countersigner: OUR, qty: '1.00', outcome: 'settled' }] }) }
  }, { upTo: 30 });
  const a = await reconcile([mk, tk], arch);
  assert.equal(a.records.get(10).cls, RECORD.FULL);
  const L = buildLedger({ trades: [mk, tk], registration, flows: flowsTo(40), prices: prices(40), ourDid: OUR, archive: a.verdicts });
  for (const id of ['mfk-full', 'tk-full']) {
    const r = L.resolutions.get(id);
    assert.deepEqual([r.status, r.evidence, r.ownership], [STATUS.SETTLED_PROVEN, EVIDENCE.OFFICIAL_ARCHIVE, OWNERSHIP.PROVEN], id);
  }
  assert.equal(L.settledProvenCount, 2);
  assert.equal(L.replay.netPosition, -0.5, 'long 0.50 as maker, short 1.00 as taker');
  assert.equal(L.replay.fees, 2.24, 'fees taken from the verified record');
  // Someone else's copy of our id settling: provably NOT ours.
  const arch2 = fakeArchive({ 10: { bytes: sweepRecord(10, { trades: [{ id: 'mfk-full', maker: stranger.did, countersigner: other.did, outcome: 'settled' }] }) } }, { upTo: 30 });
  const r2 = resolveTrade(mk, { flows: flowsTo(40), latest: 40, ourDid: OUR, archive: (await reconcile([mk], arch2)).verdicts });
  assert.deepEqual([r2.status, r2.evidence], [STATUS.NOT_OURS, EVIDENCE.OFFICIAL_ARCHIVE]);
  // Every sweep of the window verified, the id never settled: NOT_SETTLED from the archive.
  const r3 = resolveTrade(mk, { flows: flowsTo(40), latest: 40, ourDid: OUR, archive: (await reconcile([mk], fakeArchive({}, { upTo: 30 }))).verdicts });
  assert.deepEqual([r3.status, r3.evidence, r3.basis], [STATUS.NOT_SETTLED, EVIDENCE.OFFICIAL_ARCHIVE, 'ARCHIVE_NO_SETTLEMENT']);
});

const omittedFlows = () => flowsTo(40, { 10: flow(10, { omitted: { settled: 900, void: 40 } }) });
const lostOffer = () => offer('mfk-lost', 10, { probes: [{ sweep: 13 }, { sweep: 18 }, { sweep: 23 }] });

test('6. a sweep the lagging archive has not published leaves UNKNOWN as UNKNOWN', async () => {
  const t = lostOffer();
  const a = await reconcile([t], fakeArchive({}, { upTo: 11 }), { liveLatest: 40 });
  assert.equal(a.health.archive_status, ARCHIVE_STATUS.LAGGING);
  assert.equal(a.health.archive_lag_sweeps, 29);
  const v = a.verdicts.get(t.id);
  assert.equal(v.verdict, null);
  assert.deepEqual(v.gaps.missing, [12], 'sweep 12 is unpublished, not empty');
  const r = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: a.verdicts });
  assert.deepEqual([r.status, r.evidence, r.basis], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN_OMITTED, 'PROBES_EXHAUSTED']);
  // The index itself unreachable: UNAVAILABLE, same conservative answer.
  const down = await reconcileArchive({ trades: [t], registration, ourDid: OUR, signedFiles: new Map(), liveLatest: 40, cacheDir: tmp(), nowMs: NOW, fetchFn: async () => ({ ok: false, status: 503, headers: { get: () => null } }) });
  assert.equal(down.health.archive_status, ARCHIVE_STATUS.UNAVAILABLE);
  assert.equal(down.records.size, 0);
});

test('7. a redacted or hash-mismatched record proves neither absence nor ownership', async () => {
  const t = lostOffer();
  // Redacted: its bytes show OUR copy settled, but they do not hash to what the referee signed.
  const redacted = fakeArchive({
    10: { redacted: true, bytes: sweepRecord(10, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, outcome: 'settled' }], redact: 3 }) },
    11: { redacted: true, bytes: sweepRecord(11, { redact: 2 }) },
    12: { redacted: true, bytes: sweepRecord(12, { redact: 1 }) }
  }, { upTo: 30 });
  const a = await reconcile([t], redacted);
  assert.equal(a.records.get(10).cls, RECORD.REDACTED);
  const r = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: a.verdicts });
  assert.deepEqual([r.status, r.evidence, r.ownership], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN_OMITTED, OWNERSHIP.UNPROVEN], 'not upgraded');
  assert.deepEqual(r.archiveObservations.map((o) => [o.sweep, o.outcome, o.ours, o.record]), [[10, 'settled', true, RECORD.REDACTED]], 'kept as a hint');
  // Redacted sweeps that do NOT show our id cannot prove it never settled.
  const quiet = await reconcile([t], fakeArchive({ 10: { redacted: true, bytes: sweepRecord(10, { redact: 5 }) }, 11: { redacted: true, bytes: sweepRecord(11, { redact: 5 }) }, 12: { redacted: true, bytes: sweepRecord(12, { redact: 5 }) } }, { upTo: 30 }));
  assert.equal(quiet.verdicts.get(t.id).verdict, null);
  assert.equal(resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: quiet.verdicts }).status, STATUS.UNKNOWN);
  // Mismatch: the served bytes are not the record the referee hashed.
  const forged = sweepRecord(10, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, outcome: 'settled' }] });
  const bad = await reconcile([t], fakeArchive({ 10: { bytes: sweepRecord(10), serve: forged } }, { upTo: 30 }));
  assert.equal(bad.records.get(10).cls, RECORD.UNVERIFIED);
  assert.deepEqual(bad.health.mismatch_sweeps, [10]);
  assert.equal(bad.verdicts.get(t.id).verdict, null);
  assert.equal(resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: bad.verdicts }).status, STATUS.UNKNOWN);
  // An index that maps the sweep to a hash the referee never signed is a mismatch too.
  const wrongIndex = fakeArchive({ 10: { bytes: sweepRecord(10), signedFile: 'f'.repeat(64) } }, { upTo: 30 });
  assert.equal((await reconcile([t], wrongIndex)).records.get(10).cls, RECORD.UNVERIFIED);
  // With no signed post to compare against, nothing is trusted either.
  assert.equal(classifyRecord({ entry: { status: 'full', file: sha(sweepRecord(10)) }, bytes: sweepRecord(10), signedFile: null }).cls, RECORD.UNVERIFIED);
});

test('8. when the archive resumes, an earlier UNKNOWN is reconciled; checked sweeps come from the cache', async () => {
  const t = lostOffer();
  const cacheDir = tmp();
  const records = { 11: { bytes: sweepRecord(11, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, outcome: 'settled' }] }) } };
  const before = await reconcile([t], fakeArchive(records, { upTo: 10 }), { cacheDir });
  assert.equal(resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: before.verdicts }).status, STATUS.UNKNOWN);
  const resumed = fakeArchive(records, { upTo: 30 });
  const after = await reconcile([t], resumed, { cacheDir });
  const r = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: after.verdicts });
  assert.deepEqual([r.status, r.evidence, r.ownership, r.sweep], [STATUS.SETTLED_PROVEN, EVIDENCE.OFFICIAL_ARCHIVE, OWNERSHIP.PROVEN, 11]);
  assert.deepEqual(r.superseded, { status: STATUS.UNKNOWN, evidence: EVIDENCE.UNKNOWN_OMITTED, basis: 'PROBES_EXHAUSTED' });
  assert.ok(!resumed.calls.some((u) => u.endsWith(`${sha(sweepRecord(10))}.json`)), 'sweep 10 was already checked: not fetched again');
  // The alert names the archive as what decided it.
  const snapOf = (res) => ({ contest_verified: true, trades: [{ id: t.id, status: res.status, evidence: res.evidence, ownership: res.ownership, terminal: true }] });
  const was = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR });
  const alerts = alertsBetween(snapOf(was), snapOf(r));
  assert.deepEqual(alerts.map((x) => x.kind), ['settled_proven']);
  assert.match(alerts[0].text, /SETTLED_PROVEN.*verified archive record \(was UNKNOWN\)/);
});

test('9. an archive stall is announced once, on the transition — not every run', () => {
  const h = (status, latest, live = 900) => ({ archive_status: status, archive_latest_sweep: latest, live_latest_sweep: live, archive_lag_sweeps: live - latest, mismatch_sweeps: [] });
  assert.deepEqual(archiveAlerts(h('CURRENT', 895), h('LAGGING', 766)).map((a) => a.kind), ['archive_lagging']);
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('LAGGING', 766, 905)), [], 'still lagging: silent');
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('UNAVAILABLE', null)), [], 'a failed read is shown, not sent');
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('CURRENT', 899)).map((a) => a.kind), ['archive_current']);
  const at = (x, iso) => ({ ...x, archive_latest_changed_at: iso });
  assert.deepEqual(archiveAlerts(at(h('LAGGING', 766), iso(NOW - 3 * 3600_000)), at(h('LAGGING', 800), iso(NOW))).map((a) => a.kind), ['archive_advanced'], 'moved after a long stall');
  assert.deepEqual(archiveAlerts(at(h('LAGGING', 766), iso(NOW - 10 * 60_000)), at(h('LAGGING', 770), iso(NOW))), [], 'a small step right after another: silent');
  assert.deepEqual(archiveAlerts(at(h('LAGGING', 766), iso(NOW - 10 * 60_000)), at(h('LAGGING', 830), iso(NOW))).map((a) => a.kind), ['archive_advanced'], 'lag down more than 50 sweeps');
  assert.deepEqual(archiveAlerts({ ...h('LAGGING', 766), our_missing_sweeps: [900] }, { ...h('LAGGING', 766), our_missing_sweeps: [] }).map((a) => a.kind), ['archive_our_sweeps'], 'a sweep of ours appeared');
  assert.deepEqual(archiveAlerts(null, h('LAGGING', 766)), [], 'the first observation is a baseline');
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), { ...h('LAGGING', 766), mismatch_sweeps: [312] }).map((a) => a.kind), ['archive_integrity']);
  assert.deepEqual(archiveAlerts({ ...h('LAGGING', 766), mismatch_sweeps: [312] }, { ...h('LAGGING', 766), mismatch_sweeps: [312] }), [], 'a known mismatch is not re-sent');
  // Health itself: a lag inside the tolerance is CURRENT.
  const idx = parseIndex({ contest: 'close-1', sweeps: [{ n: 1, file: 'a'.repeat(64), path: `sweeps/${'a'.repeat(64)}.json`, status: 'full' }] });
  assert.equal(archiveHealth({ index: idx, liveLatest: 1 + LAG_TOLERANCE_SWEEPS, nowMs: NOW }).archive_status, ARCHIVE_STATUS.CURRENT);
  assert.equal(archiveHealth({ index: idx, liveLatest: 2 + LAG_TOLERANCE_SWEEPS, nowMs: NOW }).archive_status, ARCHIVE_STATUS.LAGGING);
  const failed = archiveHealth({ index: null, error: 'HTTP 503', liveLatest: 900, prev: { archive_last_success: 'then' }, nowMs: NOW });
  assert.deepEqual([failed.archive_status, failed.archive_last_success], [ARCHIVE_STATUS.UNAVAILABLE, 'then']);
});

test('10. with no archive evidence, UNKNOWN_OMITTED and every other resolution are exactly as before', async () => {
  const cases = [lostOffer(), offer('mfk-plain', 10), take('tk-plain', 12)];
  const empty = await reconcile(cases, fakeArchive({}, { upTo: 5 }));
  for (const t of cases) {
    const before = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR });
    const after = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: empty.verdicts });
    assert.deepEqual([after.status, after.evidence, after.ownership, after.basis], [before.status, before.evidence, before.ownership, before.basis], t.id);
  }
  assert.equal(resolveTrade(lostOffer(), { flows: omittedFlows(), latest: 40, ourDid: OUR }).evidence, EVIDENCE.UNKNOWN_OMITTED);
});

// ---------------------------------------------------------------- supporting pieces

test('index parsing refuses unsafe paths and malformed entries', () => {
  const ok = { n: 1, file: 'a'.repeat(64), path: `sweeps/${'a'.repeat(64)}.json`, status: 'full' };
  assert.equal(parseIndex({ contest: 'close-1', sweeps: [ok] }).get(1).status, 'full');
  assert.throws(() => parseIndex({ contest: 'close-1', sweeps: [{ ...ok, path: '../../etc/passwd' }] }));
  assert.throws(() => parseIndex({ contest: 'close-1', sweeps: [{ ...ok, status: 'redacted', path: `redacted/${'a'.repeat(64)}.json` }] }), /sha256/);
  assert.throws(() => parseIndex({ contest: 'sonnet-2', sweeps: [] }));
});

test('extraction pairs each trade with its own outcome and refuses a record that does not line up', () => {
  const bytes = sweepRecord(7, { trades: [{ id: 'x', maker: OUR, countersigner: stranger.did, outcome: 'settled' }], minted: [OUR], redact: 2 });
  const e = extractRecord(bytes, 7, { ids: new Set(['x']), ourDid: OUR });
  assert.equal(e.minted_us, true);
  assert.deepEqual(e.trades.map((t) => [t.id, t.outcome, t.maker_fee]), [['x', 'settled', '1.120000']]);
  assert.equal(e.redacted_trades, 2);
  assert.throws(() => extractRecord(bytes, 8, { ids: new Set(), ourDid: OUR }), /not sweep 8/);
  const j = JSON.parse(bytes); j.output.trades.pop();
  assert.throws(() => extractRecord(JSON.stringify(j), 7, { ids: new Set(), ourDid: OUR }), /outcomes/);
});

test('only the sweeps our trades and mint need are fetched, capped per run', async () => {
  assert.deepEqual(neededSweeps({ trades: [offer('a', 10), take('b', 20)], registration, archiveLatest: 20 }), [2, 3, 10, 11, 12, 20]);
  const trades = Array.from({ length: 10 }, (_, i) => offer(`m${i}`, 10 + i * 3));
  const arch = fakeArchive({}, { upTo: 60 });
  const a = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: arch.signedFiles, liveLatest: 60, cacheDir: tmp(), nowMs: NOW, fetchFn: arch.fetchFn, maxFetch: 5 });
  assert.equal(a.health.fetched_this_run, 5);
  assert.ok(a.health.pending_sweeps > 0);
  assert.equal(arch.calls.length, 6, 'the index plus five records');
});

test('the mint: verified only from a full record; a room listing is its own, weaker class', async () => {
  const arch = fakeArchive({ 2: { bytes: sweepRecord(2, { minted: [OUR] }) } }, { upTo: 5 });
  const a = await reconcile([], arch);
  const m = archiveMint({ records: a.records, regSweep: 2 });
  assert.deepEqual(m.verified, { sweep: 2 });
  const L = buildLedger({ trades: [], registration, flows: flowsTo(5), prices: prices(5), ourDid: OUR, archiveMint: m });
  assert.deepEqual([L.owner.state, L.owner.evidence], [OWNER.MINT_CONFIRMED, EVIDENCE.OFFICIAL_ARCHIVE]);
  assert.equal(L.balance.provable, true, 'official mint + no uncertain trades');
  const red = await reconcile([], fakeArchive({ 2: { redacted: true, bytes: sweepRecord(2, { minted: [OUR], redact: 1 }) } }, { upTo: 5 }));
  const mr = archiveMint({ records: red.records, regSweep: 2 });
  assert.equal(mr.verified, null);
  assert.equal(mr.corroborated.record, RECORD.REDACTED);
  // docs/close-1-referee.md room listing: our signed t:room listed in a signed flow post.
  const rooms = flowsTo(8, { 7: flow(7, { rooms: ['mfk-close1'] }) });
  const byRoom = buildLedger({ trades: [], registration, flows: rooms, prices: prices(8), ourDid: OUR, roomPosts: [{ room: 'mfk-close1', postedAt: at(6) }] });
  assert.deepEqual([byRoom.owner.evidence, byRoom.owner.assumption], [EVIDENCE.INFERRED_OWNER_FROM_ROOM_LISTING, 'ROOM_NAME_UNIQUE_TO_US']);
  assert.equal(byRoom.balance.provable, false, 'an inference never makes the balance provable');
  const early = buildLedger({ trades: [], registration, flows: rooms, prices: prices(8), ourDid: OUR, roomPosts: [{ room: 'mfk-close1', postedAt: at(8) }] });
  assert.notEqual(early.owner.evidence, EVIDENCE.INFERRED_OWNER_FROM_ROOM_LISTING, 'a listing before our post proves nothing about us');
});

// ---------------------------------------------------------------- 2026-09-29: trust classes, corroboration, GitHub budget

test('R1. redacted bytes matching the index sha256: OFFICIAL_INDEX_VERIFIED_REDACTED, never FULL', () => {
  const bytes = sweepRecord(9, { redact: 2 });
  const signed = 'b'.repeat(64);
  const c = classifyRecord({ entry: { status: 'redacted', file: signed, sha256: sha(bytes) }, bytes, signedFile: signed });
  assert.equal(c.cls, RECORD.REDACTED);
  assert.equal(RECORD.REDACTED, 'OFFICIAL_INDEX_VERIFIED_REDACTED');
  assert.notEqual(c.cls, RECORD.FULL);
});

test('R2. redacted bytes that do not match the index sha256: ARCHIVE_UNVERIFIED, flagged for integrity', () => {
  const bytes = sweepRecord(9, { redact: 2 });
  const signed = 'b'.repeat(64);
  const c = classifyRecord({ entry: { status: 'redacted', file: signed, sha256: 'c'.repeat(64) }, bytes, signedFile: signed });
  assert.deepEqual([c.cls, c.integrity], [RECORD.UNVERIFIED, true]);
});

test('R3. full bytes matching the signed referee file: REFEREE_HASH_VERIFIED_FULL', () => {
  const bytes = sweepRecord(9);
  const c = classifyRecord({ entry: { status: 'full', file: sha(bytes) }, bytes, signedFile: sha(bytes) });
  assert.equal(c.cls, 'REFEREE_HASH_VERIFIED_FULL');
});

test('R4. a redacted record with our EXACT trade is OFFICIAL_REDACTED_CORROBORATION, never SETTLED_PROVEN', async () => {
  const t = lostOffer();
  const a = await reconcile([t], fakeArchive({
    10: { redacted: true, bytes: sweepRecord(10, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, outcome: 'settled' }], redact: 1 }) },
    11: { redacted: true, bytes: sweepRecord(11, { redact: 1 }) }, 12: { redacted: true, bytes: sweepRecord(12, { redact: 1 }) }
  }, { upTo: 30 }));
  const r = resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: a.verdicts });
  assert.deepEqual([r.status, r.evidence, r.ownership], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN_OMITTED, OWNERSHIP.UNPROVEN]);
  assert.deepEqual([r.corroboration.kind, r.corroboration.exact, r.corroboration.record], ['SETTLED_OURS', true, RECORD.REDACTED]);
  const k = classifyTrade(t, r);
  assert.deepEqual([k.settlement_confidence, k.ownership_confidence, k.effect], ['OFFICIALLY_CORROBORATED', 'OFFICIALLY_CORROBORATED', 'SETTLED']);
  // Other terms (another price) are not our exact copy.
  const other = await reconcile([t], fakeArchive({ 10: { redacted: true, bytes: sweepRecord(10, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, px: '230.00', outcome: 'settled' }] }) } }, { upTo: 30 }));
  assert.equal(other.verdicts.get(t.id).corroboration.exact, false);
  // Our offer with no visible copy, in sweeps where private trades were redacted: stays unknown.
  const hidden = await reconcile([t], fakeArchive({ 10: { redacted: true, bytes: sweepRecord(10, { redact: 3 }) }, 11: { redacted: true, bytes: sweepRecord(11) }, 12: { redacted: true, bytes: sweepRecord(12) } }, { upTo: 30 }));
  assert.equal(hidden.verdicts.get(t.id).corroboration, null, 'a private-room copy of our offer could be among the redacted');
  // A take whose own public copy was voided: corroborated not settled for us.
  const tk = take('tk-v', 12);
  const voided = await reconcile([tk], fakeArchive({ 12: { redacted: true, bytes: sweepRecord(12, { trades: [{ id: 'tk-v', maker: stranger.did, countersigner: OUR, side: 'buy', qty: '1.00', outcome: 'void', reason: 'funds' }], redact: 4 }) } }, { upTo: 30 }));
  assert.deepEqual([voided.verdicts.get('tk-v').corroboration.kind, voided.verdicts.get('tk-v').corroboration.reason], ['NOT_SETTLED', 'funds']);
});

test('R5. the corroborated account never reaches the risk gate', async () => {
  const t = lostOffer();
  const records = { 10: { redacted: true, bytes: sweepRecord(10, { trades: [{ id: 'mfk-lost', maker: OUR, countersigner: stranger.did, outcome: 'settled' }] }) } };
  const withC = await reconcile([t], fakeArchive(records, { upTo: 30 }));
  const base = { trades: [t], registration, flows: omittedFlows(), prices: prices(40), ourDid: OUR };
  const L0 = buildLedger(base);
  const L1 = buildLedger({ ...base, archive: withC.verdicts });
  for (const k of ['exposure', 'balance', 'pending', 'settledCount', 'settledProvenCount']) assert.deepEqual(L1[k], L0[k], k);
  assert.equal(L1.owner.state, L0.owner.state);
  const price = { n: 40, for: 41, ref: { px: '224.00', time: iso(NOW - 60_000) }, postedAt: iso(NOW - 60_000) };
  const gate = (L) => approveTrade({ ...healthy(price), ledger: L, attempts: 20 }, proposal(), DEFAULT_POLICY, NOW);
  assert.deepEqual(gate(L1), gate(L0));
  const acct = corroboratedAccount({ trades: [t], resolutions: L1.resolutions, prices: prices(40), marks: { reference: 224 } });
  assert.equal(acct.label, CORROBORATED_LABEL);
  assert.equal(acct.net_position, 0.5, 'the corroborated view does count it');
  assert.equal(L1.exposure.definite, 0, 'the proven view does not');
  // A corroborated mint shows in the sources but does not confirm the mint for the gate.
  const redMint = await reconcile([], fakeArchive({ 2: { redacted: true, bytes: sweepRecord(2, { minted: [OUR], redact: 1 }) } }, { upTo: 5 }));
  const Lm = buildLedger({ trades: [], registration, flows: flowsTo(5), prices: prices(5), ourDid: OUR, archiveMint: archiveMint({ records: redMint.records, regSweep: 2 }) });
  assert.deepEqual([Lm.owner.state, Lm.owner.confidence], [OWNER.MINT_UNKNOWN, 'OFFICIALLY_CORROBORATED']);
});

test('R5b. accounts are compared, and a disagreement is raised once', () => {
  const ledger = { exposure: { definite: 0, low: -1, high: 1, worstFreePolf: 9000 } };
  const inside = compareAccounts({ ledger, corroborated: { net_position: 0.5, cash: 9800, score_at: { pnl_mark: { score: -2 } }, unknown_range: { unknown_trades: 0 } }, standing: { leaderboard_display_row: null }, pnl: { top: [['x', '100']] } });
  assert.deepEqual(inside.conflicts, []);
  assert.equal(inside.C.note, 'not visible in truncated top list');
  const outside = compareAccounts({ ledger, corroborated: { net_position: -2.1, cash: 9800, score_at: { pnl_mark: { score: 150 } }, unknown_range: { unknown_trades: 0 } }, standing: { leaderboard_display_row: null }, pnl: { top: [['x', '100']] } });
  assert.deepEqual(outside.conflicts.map((c) => c.kind).sort(), ['CORROBORATED_OUTSIDE_PROVEN_RANGE', 'CORROBORATED_SCORE_ABOVE_BOARD']);
  const snap = (c) => ({ contest_verified: true, account_comparison: { conflicts: c } });
  assert.deepEqual(alertsBetween(snap([]), snap(outside.conflicts)).map((a) => a.kind), ['account_conflict']);
  assert.deepEqual(alertsBetween(snap(outside.conflicts), snap(outside.conflicts)), [], 'the same conflict is not re-sent');
});

test('R6/R7. a long stall is silent run after run; the resume is one alert', () => {
  const h = (latest, live, changedAt) => ({ archive_status: live - latest > 12 ? 'LAGGING' : 'CURRENT', archive_latest_sweep: latest, live_latest_sweep: live, archive_lag_sweeps: live - latest, archive_latest_changed_at: changedAt, mismatch_sweeps: [], our_missing_sweeps: [] });
  const stalled = iso(NOW - 26 * 3600_000);
  let prev = h(766, 1000, stalled); const sent = [];
  for (let i = 1; i <= 72; i++) { const next = h(766, 1000 + i, stalled); sent.push(...archiveAlerts(prev, next)); prev = next; }
  assert.deepEqual(sent, [], 'six hours of 5-minute runs, nothing');
  const resumed = h(1070, 1073, iso(NOW));
  assert.deepEqual(archiveAlerts(prev, resumed).map((a) => a.kind), ['archive_current']);
  assert.deepEqual(archiveAlerts(resumed, h(1071, 1074, iso(NOW))), [], 'and then quiet again');
});

/** A fake GitHub: counts requests, answers with rate headers, can refuse. */
function fakeGitHub({ remaining = 50, reset = NOW / 1000 + 1800, refuse = false } = {}) {
  const calls = [];
  const state = { remaining };
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, etag: opts.headers?.['if-none-match'] ?? null });
    const hdr = () => ({ get: (k) => ({ 'x-ratelimit-remaining': String(state.remaining), 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(Math.floor(reset)), etag: '"e1"' })[k] ?? null });
    if (refuse) { state.remaining = 0; return { ok: false, status: 403, headers: hdr(), json: async () => ({}), text: async () => '' }; }
    if (opts.headers?.['if-none-match'] === '"e1"') return { ok: false, status: 304, headers: hdr(), json: async () => null, text: async () => '' };
    state.remaining = Math.max(0, state.remaining - 1);
    let body = null; let status = 200;
    if (url.includes('/git/trees/')) body = { sha: 't1', tree: [] };
    else if (url.includes('/issues?')) body = [];
    else if (url.includes('raw.githubusercontent')) body = url.endsWith('manifest.json') ? JSON.stringify({ status: 'draft' }) : JSON.stringify({ rules_version: '0.1-draft' });
    else if (url.includes('/commits')) body = [{ sha: 'abcdef1234', commit: { message: 'x' } }];
    else status = 404;
    return { ok: status === 200, status, headers: hdr(), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetchFn, calls, state };
}

test('R8. a GitHub 403 rate limit backs off: no further calls until the reset, and it is not a trading failure', async () => {
  const gh = fakeGitHub({ refuse: true });
  const first = await watchUpstream({ prev: null, fetchFn: gh.fetchFn, nowMs: NOW, env: {}, pinned: PINNED });
  assert.equal(gh.calls.length, 1, 'stopped at the first refusal');
  assert.match(first.error, /rate limit/);
  assert.equal(first.obs.github.status, 'BLIND', 'never succeeded');
  assert.ok(first.obs.github.blocked_until);
  gh.calls.length = 0;
  for (const min of [10, 20, 29]) {
    const again = await watchUpstream({ prev: first.obs, fetchFn: gh.fetchFn, nowMs: NOW + min * 60_000, env: {}, pinned: PINNED });
    assert.equal(again.ran, false);
  }
  assert.equal(gh.calls.length, 0, 'no request while blocked');
  // A low remaining budget also stops us before the reset.
  const low = makeGitHub({ fetchFn: gh.fetchFn, env: {}, nowMs: NOW, state: { remaining: 3, reset_at: iso(NOW + 600_000) } });
  await assert.rejects(low.json('https://api.github.com/x'), RateLimited);
  assert.equal(gh.calls.length, 0);
});

test('R9. after the reset the watcher resumes; unchanged answers come back as free 304s', async () => {
  const refused = fakeGitHub({ refuse: true });
  const blocked = (await watchUpstream({ prev: null, fetchFn: refused.fetchFn, nowMs: NOW, env: {}, pinned: PINNED })).obs;
  const gh = fakeGitHub({ reset: NOW / 1000 + 7200 });
  const later = NOW + 31 * 60_000;
  const resumed = await watchUpstream({ prev: blocked, fetchFn: gh.fetchFn, nowMs: later, env: {}, pinned: PINNED });
  assert.equal(resumed.ran, true);
  assert.equal(resumed.obs.github.status, 'OK');
  assert.equal(resumed.obs.github.last_success, iso(later));
  assert.deepEqual(alertsBetween({ contest_verified: true, github_watch_status: 'BLIND' }, { contest_verified: true, github_watch_status: 'OK' }).map((a) => a.kind), ['github_watch_restored']);
  assert.deepEqual(alertsBetween({ contest_verified: true, github_watch_status: 'OK' }, { contest_verified: true, github_watch_status: 'DEGRADED' }), [], 'a short degradation is not news');
  assert.deepEqual(alertsBetween({ contest_verified: true, github_watch_status: 'DEGRADED' }, { contest_verified: true, github_watch_status: 'BLIND' }).map((a) => a.kind), ['github_watch_blind']);
  // Not due yet: no requests at all.
  gh.calls.length = 0;
  const soon = await watchUpstream({ prev: resumed.obs, fetchFn: gh.fetchFn, nowMs: later + 5 * 60_000, env: {}, pinned: PINNED });
  assert.deepEqual([soon.ran, gh.calls.length], [false, 0]);
  // Due again: every read carries its ETag and comes back 304.
  const next = await watchUpstream({ prev: resumed.obs, fetchFn: gh.fetchFn, nowMs: later + 31 * 60_000, env: {}, pinned: PINNED });
  assert.equal(next.obs.github.status, 'OK');
  assert.ok(gh.calls.length > 0 && gh.calls.every((c) => c.etag === '"e1"'), 'conditional requests only');
  assert.equal(next.obs.github.not_modified_last_run, gh.calls.length);
  // A token, if present, is used; its absence is fine.
  let auth = null;
  await makeGitHub({ fetchFn: async (u, o) => { auth = o.headers.authorization; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; }, env: { GITHUB_TOKEN: 't0k' }, nowMs: NOW }).json('https://api.github.com/y');
  assert.equal(auth, 'Bearer t0k');
});

test('R10. a truncated tie never becomes a rank; not listed is said plainly', () => {
  const top = Array.from({ length: 25 }, (_, i) => [i === 24 ? OUR : `did:key:z6Mk${String(i).padStart(2, '0')}`, '743.97']);
  const s = standingOf(top, OUR);
  assert.equal(s.leaderboard_note, 'tie may extend beyond visible list');
  assert.equal(s.prize_places, null);
  const gone = standingOf(top.slice(0, 24), OUR);
  assert.equal(gone.leaderboard_note, 'not visible in truncated top list');
  assert.equal(gone.leaderboard_display_row, null);
  const snap = buildSnapshot({ contest: null, streams: {}, price: null, ledger: null, pnl: { n: 1, top: top.slice(0, 24) }, ourDid: OUR, trades: [], gate: null, nowMs: NOW });
  assert.ok(!/rank >|>25|#2[5-9]/.test(JSON.stringify(snap)), 'no pseudo-rank anywhere in the snapshot');
  assert.equal(snap.official_score_note, 'not visible in truncated top list');
});

// ---------------------------------------------------------------- 2026-09-29: a fresh host, a partial cache, no fake alerts

import { baselineStatus, gateEvidenceAlerts, withEvidenceReport } from '../src/close1/runtime.mjs';

/** Ten maker offers, each settled ours in a redacted record: the corroborated view should end at 10/10. */
function freshHostFixture() {
  const trades = Array.from({ length: 10 }, (_, i) => offer(`m${i}`, 10 + i * 3));
  const records = {};
  trades.forEach((t, i) => { records[11 + i * 3] = { redacted: true, bytes: sweepRecord(11 + i * 3, { trades: [{ id: t.id, maker: OUR, countersigner: stranger.did, outcome: 'settled' }] }) }; });
  return { trades, arch: fakeArchive(records, { upTo: 60 }) };
}

function snapshotOf(trades, a) {
  const verdicts = new Map(trades.map((t) => [t.id, archiveVerdict(t, { records: a.records, ourDid: OUR })]));
  const ledger = buildLedger({ trades, registration, flows: flowsTo(60), prices: prices(60), ourDid: OUR, archive: verdicts, archiveMint: archiveMint({ records: a.records, regSweep: 2 }) });
  const corroborated = corroboratedAccount({ trades, resolutions: ledger.resolutions, prices: prices(60), marks: { reference: 224, pnl_mark: 224 } });
  const b = baselineStatus(a.health);
  return buildSnapshot({ contest: null, streams: {}, price: null, ledger, pnl: null, ourDid: OUR, trades, gate: null, nowMs: NOW, archive: a.health, corroborated,
    host: { evidence_baseline_ready: b.ready, evidence_status: b.status } });
}

test('H1. fresh host: partial cache → more cache → complete: NO fake "resolved" alerts, and the baseline is not an event', async () => {
  const { trades, arch } = freshHostFixture();
  const cacheDir = tmp();
  const snaps = []; const sent = []; const raw = [];
  let prev = null;
  for (let run = 0; run < 12; run++) {
    const a = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: arch.signedFiles, liveLatest: 60, cacheDir, nowMs: NOW, fetchFn: arch.fetchFn, maxFetch: 5 });
    const snap = snapshotOf(trades, a);
    const alerts = withEvidenceReport(prev, snap, gateEvidenceAlerts(prev, snap, alertsBetween(prev, snap)));
    sent.push(...alerts.filter((x) => !x.logOnly));
    raw.push(...alertsBetween(prev, snap));
    snaps.push(snap);
    prev = snap;
    if (a.health.pending_sweeps === 0 && snaps.length > 2 && snaps.at(-2).evidence_baseline_ready) break;
  }
  const corr = (s) => s.trades.filter((t) => t.corroborated_outcome === 'SETTLED').length;
  assert.equal(snaps[0].evidence_baseline_ready, false, 'the first partial run is BACKFILLING');
  assert.ok(corr(snaps[0]) < 10, 'the partial cache shows fewer corroborated outcomes than the archive holds');
  assert.equal(corr(snaps.at(-1)), 10, 'the complete cache shows all of them');
  assert.equal(snaps.at(-1).evidence_baseline_ready, true);
  assert.deepEqual(sent.filter((x) => /unknown_resolved|corroboration_changed|trade_resolved|evidence_report|settled_proven|mint_confirmed|owner_stronger/.test(x.kind)), [], 'no fake evidence transitions were sent');
  assert.ok(raw.some((x) => /unknown_resolved|corroboration_changed/.test(x.kind)), 'without the baseline gate the filling cache WOULD have produced fake resolved alerts (the test is not vacuous)');
  // Only a change AFTER the baseline may alert.
  const last = snaps.at(-1);
  const later = { ...last, trades: last.trades.map((t, i) => (i === 0 ? { ...t, corroborated_outcome: 'UNKNOWN', corroboration: null } : t)) };
  const real = withEvidenceReport(last, later, gateEvidenceAlerts(last, later, alertsBetween(last, later)));
  assert.ok(real.some((x) => x.kind === 'evidence_report' && !x.logOnly), 'a genuine change after the baseline is reported');
});

test('H2. a copied cache is derived data: --revalidate fetches and hashes everything again and reports what differs', async () => {
  const { trades, arch } = freshHostFixture();
  const cacheDir = tmp();
  const first = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: arch.signedFiles, liveLatest: 60, cacheDir, nowMs: NOW, fetchFn: arch.fetchFn, maxFetch: 99 });
  assert.equal(first.health.archive_cache_valid, true);
  // Someone hands us a cache in which one record has been altered to say something else.
  const f = path.join(cacheDir, 'records', '14.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.extract = null; rec.cls = 'REFEREE_HASH_VERIFIED_FULL';
  fs.writeFileSync(f, JSON.stringify(rec));
  const plain = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: arch.signedFiles, liveLatest: 60, cacheDir, nowMs: NOW, fetchFn: arch.fetchFn, maxFetch: 0 });
  assert.equal(plain.records.get(14).cls, 'REFEREE_HASH_VERIFIED_FULL', 'without revalidation the cache is believed, which is why a copied cache must be revalidated once');
  const calls0 = arch.calls.length;
  const v = await reconcileArchive({ trades, registration, ourDid: OUR, signedFiles: arch.signedFiles, liveLatest: 60, cacheDir, nowMs: NOW, fetchFn: arch.fetchFn, maxFetch: 0, revalidate: true });
  assert.deepEqual(v.health.revalidated.differs_from_cache, [14]);
  assert.equal(v.health.revalidated.fetched, v.health.archive_cache_required);
  assert.ok(arch.calls.length > calls0 + 10, 'every needed record was fetched again');
  assert.equal(v.records.get(14).cls, RECORD.REDACTED, 'the fresh hash check, not the copy, decides');
  assert.equal(v.health.archive_cache_valid, true);
  assert.deepEqual(baselineStatus(v.health), { ready: true, status: 'BASELINE_READY', why: null });
});

test('H3. no baseline while anything is unfetched, unread or mismatched', () => {
  assert.equal(baselineStatus(null).ready, false);
  assert.equal(baselineStatus({ archive_latest_sweep: null, pending_sweeps: 0 }).ready, false, 'index never read');
  assert.equal(baselineStatus({ archive_latest_sweep: 766, pending_sweeps: 78 }).ready, false);
  assert.equal(baselineStatus({ archive_latest_sweep: 766, pending_sweeps: 0, mismatch_sweeps: [300] }).ready, false);
  assert.equal(baselineStatus({ archive_latest_sweep: 766, pending_sweeps: 0, mismatch_sweeps: [] }).ready, true);
});
