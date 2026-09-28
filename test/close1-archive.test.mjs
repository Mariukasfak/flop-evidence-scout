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
  assert.equal(a.records.get(10).cls, RECORD.VERIFIED_FULL);
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
  assert.deepEqual(v.missing, [12], 'sweep 12 is unpublished, not empty');
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
  assert.equal(bad.records.get(10).cls, RECORD.MISMATCH);
  assert.deepEqual(bad.health.mismatch_sweeps, [10]);
  assert.equal(bad.verdicts.get(t.id).verdict, null);
  assert.equal(resolveTrade(t, { flows: omittedFlows(), latest: 40, ourDid: OUR, archive: bad.verdicts }).status, STATUS.UNKNOWN);
  // An index that maps the sweep to a hash the referee never signed is a mismatch too.
  const wrongIndex = fakeArchive({ 10: { bytes: sweepRecord(10), signedFile: 'f'.repeat(64) } }, { upTo: 30 });
  assert.equal((await reconcile([t], wrongIndex)).records.get(10).cls, RECORD.MISMATCH);
  // With no signed post to compare against, nothing is trusted either.
  assert.equal(classifyRecord({ entry: { status: 'full', file: sha(sweepRecord(10)) }, bytes: sweepRecord(10), signedFile: null }).cls, RECORD.UNANCHORED);
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
  assert.deepEqual(alerts.map((x) => x.kind), ['trade_resolved']);
  assert.match(alerts[0].text, /SETTLED_PROVEN.*verified archive record \(was UNKNOWN\)/);
});

test('9. an archive stall is announced once, on the transition — not every run', () => {
  const h = (status, latest, live = 900) => ({ archive_status: status, archive_latest_sweep: latest, live_latest_sweep: live, archive_lag_sweeps: live - latest, mismatch_sweeps: [] });
  assert.deepEqual(archiveAlerts(h('CURRENT', 895), h('LAGGING', 766)).map((a) => a.kind), ['archive_lagging']);
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('LAGGING', 766, 905)), [], 'still lagging: silent');
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('UNAVAILABLE', null)), [], 'a failed read is shown, not sent');
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('CURRENT', 899)).map((a) => a.kind), ['archive_current']);
  assert.deepEqual(archiveAlerts(h('LAGGING', 766), h('LAGGING', 800)).map((a) => a.kind), ['archive_advanced'], 'a new batch published');
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
  assert.equal(mr.observed.record, RECORD.REDACTED);
  // docs/close-1-referee.md room listing: our signed t:room listed in a signed flow post.
  const rooms = flowsTo(8, { 7: flow(7, { rooms: ['mfk-close1'] }) });
  const byRoom = buildLedger({ trades: [], registration, flows: rooms, prices: prices(8), ourDid: OUR, roomPosts: [{ room: 'mfk-close1', postedAt: at(6) }] });
  assert.deepEqual([byRoom.owner.evidence, byRoom.owner.assumption], [EVIDENCE.INFERRED_OWNER_FROM_ROOM_LISTING, 'ROOM_NAME_UNIQUE_TO_US']);
  assert.equal(byRoom.balance.provable, false, 'an inference never makes the balance provable');
  const early = buildLedger({ trades: [], registration, flows: rooms, prices: prices(8), ourDid: OUR, roomPosts: [{ room: 'mfk-close1', postedAt: at(8) }] });
  assert.notEqual(early.owner.evidence, EVIDENCE.INFERRED_OWNER_FROM_ROOM_LISTING, 'a listing before our post proves nothing about us');
});
