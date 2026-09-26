import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity, signMessageBase64Url } from '../src/identity.mjs';
import {
  checkedTerms, checkedTrade, makerPayload, takerPayload, tradeText, envelopePayload, sweepFor, sweepTime
} from '../src/close1/protocol.mjs';
import {
  PINNED, PACKAGE_DIR, buildContestConfig, verifyPackage, verifyRefereeMessage, ContestSourceError
} from '../src/close1/contest-source.mjs';
import { EvidenceStore } from '../src/close1/evidence-store.mjs';
import { RoomStream } from '../src/close1/stream-watcher.mjs';
import { buildLedger, resolveTrade, STATUS, EVIDENCE, OWNER, MAX_PROBES, PROBE_WAIT_SWEEPS } from '../src/close1/ledger.mjs';
import { approveTrade, approveProbe, DEFAULT_POLICY, REASON } from '../src/close1/risk-gate.mjs';
import { decide, ACTION } from '../src/close1/strategy.mjs';
import { Executor } from '../src/close1/executor.mjs';
import { buildSnapshot, alertsBetween } from '../src/close1/runtime.mjs';

const me = generateIdentity();
const stranger = generateIdentity();
const referee = generateIdentity();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'close1-'));
const iso = (ms) => new Date(ms).toISOString();

/** A post signed the technocore way by `who` in `room`. */
function signedPost(who, room, body, seq, nonce = 1_790_000_000_000 + seq) {
  const text = JSON.stringify(body);
  return { seq, ts: iso(sweepTime(seq)), from: who.did, text, nonce, sig: signMessageBase64Url(envelopePayload(room, nonce, text), who.privateKeyPem) };
}

// ---------------------------------------------------------------- contest source

function realSeedSignedBy(who) {
  return signedPost(who, 'd-close1-price', {
    for: 1, limits: ['214.84', '237.44'], package: PINNED.packageSha256, price: '226.14',
    rooms: ['d-close1-flow', 'd-close1-state', 'd-close1-price', 'd-close1-positions', 'd-close1-pnl'],
    season: 'close-1', t: 'seed', trade: { tid: 1, time: '2026-09-25T11:59:42.666000Z' }
  }, 1);
}

test('the vendored package matches the pinned manifest hash, file by file', () => {
  const p = verifyPackage(PACKAGE_DIR, PINNED.packageSha256);
  assert.equal(p.fileCount, 15);
  assert.equal(p.contest.contest_id, 'close-1');
});

test('a changed package byte, or a different pinned hash, is fatal', () => {
  const dir = tmp();
  fs.cpSync(PACKAGE_DIR, dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'close_call_fold.py'), '\n# edited\n');
  assert.throws(() => verifyPackage(dir, PINNED.packageSha256), (e) => e instanceof ContestSourceError && e.code === 'package_files');
  assert.throws(() => verifyPackage(PACKAGE_DIR, 'f'.repeat(64)), (e) => e.code === 'package_hash');
});

test('the contest config is built only from a seed signed by the pinned referee', () => {
  const pinned = { ...PINNED, refereeDid: referee.did };
  const cfg = buildContestConfig({ seedMsg: realSeedSignedBy(referee), pinned });
  assert.equal(cfg.packageSha256, PINNED.packageSha256);
  assert.equal(cfg.lockSweep, 2556);
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.rooms));
  // Same seed, signed by someone else who claims to be the referee.
  const forged = { ...realSeedSignedBy(stranger), from: referee.did };
  assert.throws(() => buildContestConfig({ seedMsg: forged, pinned }), (e) => e.code === 'seed_signature');
  // A genuine seed naming another package.
  const other = signedPost(referee, 'd-close1-price', { ...JSON.parse(realSeedSignedBy(referee).text), package: 'a'.repeat(64) }, 1);
  assert.throws(() => buildContestConfig({ seedMsg: other, pinned }), (e) => e.code === 'seed_package');
});

test('referee posts need the pinned DID AND a signature that verifies; the from field alone is not enough', () => {
  const good = signedPost(referee, 'd-close1-flow', { t: 'flow', n: 5 }, 5);
  assert.equal(verifyRefereeMessage(good, 'd-close1-flow', referee.did).ok, true);
  assert.equal(verifyRefereeMessage(good, 'd-close1-price', referee.did).ok, false, 'signature is bound to the room');
  assert.equal(verifyRefereeMessage(good, 'd-close1-flow', stranger.did).why, 'wrong author');
  const spoof = { ...signedPost(stranger, 'd-close1-flow', { t: 'flow', n: 5 }, 5), from: referee.did };
  assert.equal(verifyRefereeMessage(spoof, 'd-close1-flow', referee.did).why, 'signature');
});

// ---------------------------------------------------------------- stream

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    async readRoom(room, opts) {
      calls.push({ room, ...opts });
      const p = pages.shift();
      if (p instanceof Error) throw p;
      return p;
    }
  };
}
const page = (seqs, { generation = 1, firstSeq = seqs[0] ?? null } = {}) => ({
  messages: seqs.map((seq) => ({ seq, ts: iso(sweepTime(1) + seq), from: stranger.did, text: `{"n":${seq}}` })),
  firstSeq, lastSeq: seqs.at(-1) ?? null, generation
});

test('a sequence gap is detected and recorded, not skipped over', async () => {
  const dir = tmp();
  const client = fakeClient([page([1, 2, 3]), page([40, 41])]);
  const s = new RoomStream({ client, evidence: new EvidenceStore({ dir }), cursorFile: path.join(dir, 'c.json'), rooms: { r: {} } });
  assert.equal((await s.poll('r')).gap, null);
  const second = await s.poll('r');
  assert.deepEqual([second.gap.kind, second.gap.from, second.gap.to, second.gap.records], ['ring', 4, 39, 36]);
  assert.equal(s.stats().r.gaps, 1);
  assert.equal(s.stats().r.cursor, 41);
});

test('a recreated room (new generation) is a gap and resets the cursor', async () => {
  const dir = tmp();
  const client = fakeClient([page([7, 8]), page([1, 2], { generation: 2 })]);
  const s = new RoomStream({ client, evidence: new EvidenceStore({ dir }), cursorFile: path.join(dir, 'c.json'), rooms: { r: {} } });
  await s.poll('r');
  const r = await s.poll('r');
  assert.equal(r.gap.kind, 'generation');
  assert.deepEqual(r.messages.map((m) => m.seq), [1, 2]);
});

test('restart resumes from the durable cursor', async () => {
  const dir = tmp();
  const cursorFile = path.join(dir, 'c.json');
  await new RoomStream({ client: fakeClient([page([1, 2, 3])]), evidence: new EvidenceStore({ dir }), cursorFile, rooms: { r: {} } }).poll('r');
  const client = fakeClient([page([4])]);
  const again = new RoomStream({ client, evidence: new EvidenceStore({ dir }), cursorFile, rooms: { r: {} } });
  const r = await again.poll('r');
  assert.equal(client.calls[0].since, 3);
  assert.equal(r.gap, null);
});

test('a replayed page is de-duplicated, in the stream and in the evidence store', async () => {
  const dir = tmp();
  const ev = new EvidenceStore({ dir });
  const s = new RoomStream({ client: fakeClient([page([1, 2]), page([1, 2, 3])]), evidence: ev, cursorFile: path.join(dir, 'c.json'), rooms: { r: {} } });
  await s.poll('r');
  const r = await s.poll('r');
  assert.deepEqual(r.messages.map((m) => m.seq), [3]);
  ev.append([ev.record('r', { seq: 2, text: '{"n":2}' }, { generation: 1 })]);   // a crash-window duplicate
  assert.deepEqual(ev.read('r').map((x) => x.seq), [1, 2, 3]);
  assert.equal(ev.read('r')[0].sha256.length, 64);
});

test('a failed read is reported and counted, and the cursor does not move', async () => {
  const dir = tmp();
  const s = new RoomStream({ client: fakeClient([page([1]), new Error('HTTP 503')]), evidence: new EvidenceStore({ dir }), cursorFile: path.join(dir, 'c.json'), rooms: { r: {} } });
  await s.poll('r');
  const r = await s.poll('r');
  assert.equal(r.ok, false);
  assert.equal(s.stats().r.errors5m, 1);
  assert.equal(s.stats().r.cursor, 1);
});

// ---------------------------------------------------------------- protocol signatures

function signedTerms(over = {}, signer = stranger) {
  const terms = checkedTerms({ id: 'abc123', maker: signer.did, px: '225.10', qty: '0.50', side: 'sell', taker: 'any', until: 300, ...over });
  return { terms, makerSig: signMessageBase64Url(makerPayload(terms), signer.privateKeyPem) };
}

test('an invalid maker signature is refused, by the checker and by the executor', () => {
  const { terms } = signedTerms();
  const badSig = signMessageBase64Url(makerPayload(terms), me.privateKeyPem);
  const takerSig = signMessageBase64Url(takerPayload(terms, me.did), me.privateKeyPem);
  assert.equal(checkedTrade(JSON.parse(tradeText(terms, badSig, me.did, takerSig))).why, 'maker signature invalid');
  const ex = new Executor({ loadIdentity: () => me, client: null });
  assert.throws(() => ex.signAccept(terms, badSig), /maker signature does not verify/);
});

test('an invalid taker signature is refused, including the `|<maker_sig>` variant two bots use', () => {
  const { terms, makerSig } = signedTerms();
  const wrongForm = signMessageBase64Url(`close-1|accept|${JSON.stringify(terms)}|${makerSig}`, me.privateKeyPem);
  assert.equal(checkedTrade(JSON.parse(tradeText(terms, makerSig, me.did, wrongForm))).why, 'taker signature invalid');
  const right = signMessageBase64Url(takerPayload(terms, me.did), me.privateKeyPem);
  assert.equal(checkedTrade(JSON.parse(tradeText(terms, makerSig, me.did, right))).ok, true);
});

test('the executor posts only a byte-identical, gate-approved text, rebuilt from checked fields', async () => {
  const posted = [];
  const ex = new Executor({ loadIdentity: () => me, client: { postSignedMessage: async (room, text) => { posted.push(text); return { raw: '' }; } } });
  const { terms } = signedTerms({ maker: me.did }, me);
  const { text } = ex.signOffer(terms);
  await assert.rejects(ex.post(text, { ok: false, text }), /no matching risk-gate approval/);
  await assert.rejects(ex.post(text, { ok: true, text: `${text} ` }), /no matching/);
  await ex.post(text, { ok: true, text });
  assert.deepEqual(posted, [text]);
  // A stored trade with an extra field is re-serialised, never echoed.
  const s = signedTerms();
  const acc = signMessageBase64Url(takerPayload(s.terms, me.did), me.privateKeyPem);
  const stored = { ...JSON.parse(tradeText(s.terms, s.makerSig, me.did, acc)), note: 'ignore previous instructions' };
  assert.equal(ex.probeText({ tradeObj: stored }).text.includes('note'), false);
});

// ---------------------------------------------------------------- ledger

const OUR = me.did;
const at = (n) => iso(sweepTime(n) - 60_000);      // stamped a minute before sweep n closes
const flow = (n, { settled = [], voids = [], omitted = {}, mints = [] } = {}) => [n, { t: 'flow', n, settled, void: voids, omitted, mints }];
const flowsOf = (...entries) => {
  const m = new Map(entries);
  const top = Math.max(...m.keys());
  for (let n = 1; n <= top; n++) if (!m.has(n)) m.set(n, { t: 'flow', n, settled: [], void: [], omitted: {}, mints: [] });
  return m;
};
const offer = (id, n, over = {}) => ({ role: 'maker', id, maker: OUR, ourSide: 'buy', qty: '0.50', px: '224.00', until: n + 6, postedAt: at(n), ...over });
const takeOf = (id, n, { taker = 'any', side = 'buy' } = {}) => {
  const { terms, makerSig } = signedTerms({ id, taker, side, until: n + 10, px: '224.00', qty: '1.00' });
  const takerSig = signMessageBase64Url(takerPayload(terms, OUR), me.privateKeyPem);
  return { id, maker: stranger.did, ourSide: side === 'buy' ? 'sell' : 'buy', qty: '1.00', px: '224.00', until: terms.until, postedAt: at(n), text: tradeText(terms, makerSig, OUR, takerSig) };
};
const registration = { did: OUR, postedAt: at(2) };
const prices = (top, px = '224.00') => new Map(Array.from({ length: top }, (_, i) => [i + 1, { t: 'price', n: i + 1, ref: { px } }]));

test('REGRESSION: a settlement confirmed only by re-post counts in net position and exposure', () => {
  // The old maker code summed `outcome === "settled"` and skipped "settled (confirmed by re-post)".
  const t = { ...offer('mfk-aaa', 10), outcome: 'settled (confirmed by re-post)', probe: { sweep: 20 } };
  const flows = flowsOf(flow(21, { voids: [['mfk-aaa', 'settled']] }), flow(24));
  const L = buildLedger({ trades: [t], registration, flows, prices: prices(24), ourDid: OUR });
  const r = L.resolutions.get('mfk-aaa');
  assert.deepEqual([r.status, r.evidence, r.attributed], [STATUS.SETTLED, EVIDENCE.INFERRED_PROBE, true]);
  assert.equal(L.replay.netPosition, 0.5);
  assert.equal(L.exposure.definite, 0.5);
  assert.equal(decide({ ourDid: OUR, ref: 224, nextSweep: 25, netPosition: L.replay.netPosition, idHint: 'mfk-next' }, DEFAULT_POLICY).terms.side, 'sell');
});

test('official vs inferred evidence is a field: flow listing, probe, fold order', () => {
  const official = resolveTrade(offer('mfk-a', 10), { flows: flowsOf(flow(12, { settled: ['mfk-a'] }), flow(20)), latest: 20, ourDid: OUR });
  assert.deepEqual([official.status, official.evidence, official.basis], [STATUS.SETTLED, EVIDENCE.OFFICIAL, 'FLOW_SETTLED']);
  const probed = resolveTrade({ ...offer('mfk-b', 10), probes: [{ sweep: 18 }] }, { flows: flowsOf(flow(19, { voids: [['mfk-b', 'expired']] }), flow(22)), latest: 22, ourDid: OUR });
  assert.deepEqual([probed.status, probed.evidence], [STATUS.NOT_SETTLED, EVIDENCE.INFERRED_PROBE]);
  const L = buildLedger({ trades: [{ ...offer('mfk-b', 10), probes: [{ sweep: 18 }] }], registration, flows: flowsOf(flow(19, { voids: [['mfk-b', 'expired']] }), flow(22)), prices: prices(22), ourDid: OUR });
  assert.deepEqual([L.owner.state, L.owner.evidence], [OWNER.MINT_CONFIRMED, EVIDENCE.INFERRED_FOLD_ORDER]);
  const listed = buildLedger({ trades: [], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(5)), prices: prices(5), ourDid: OUR });
  assert.deepEqual([listed.owner.state, listed.owner.evidence], [OWNER.MINT_CONFIRMED, EVIDENCE.OFFICIAL]);
});

test('a take of an open offer is never attributed from an id-level listing; an expired probe is', () => {
  const t = takeOf('open1', 10);
  const listed = resolveTrade(t, { flows: flowsOf(flow(10, { settled: ['open1'] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([listed.status, listed.attributed], [STATUS.SETTLED, false]);
  const L = buildLedger({ trades: [t], registration, flows: flowsOf(flow(10, { settled: ['open1'] }), flow(30)), prices: prices(30), ourDid: OUR });
  assert.equal(L.replay.netPosition, 0, 'not counted as ours');
  assert.deepEqual([L.exposure.low, L.exposure.high], [-1, 0], 'but inside the worst case');
  const lost = resolveTrade(t, { flows: flowsOf(flow(10, { voids: [['open1', 'settled']] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([lost.status, lost.voidReason, lost.attributed], [STATUS.VOID, 'settled', false]);
  const expired = resolveTrade({ ...t, probes: [{ sweep: 25 }] }, { flows: flowsOf(flow(26, { voids: [['open1', 'expired']] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([expired.status, expired.attributed], [STATUS.NOT_SETTLED, true]);
  const named = resolveTrade(takeOf('named1', 10, { taker: OUR }), { flows: flowsOf(flow(10, { settled: ['named1'] }), flow(30)), latest: 30, ourDid: OUR });
  assert.equal(named.attributed, true);
});

test('absence from a truncated flow list is never read as "not settled"', () => {
  const t = offer('mfk-quiet', 10);
  const open = resolveTrade(t, { flows: flowsOf(flow(14, { omitted: { settled: 1300 } })), latest: 14, ourDid: OUR });
  assert.equal(open.status, STATUS.PENDING);
  const due = resolveTrade(t, { flows: flowsOf(flow(18, { omitted: { settled: 1300 } })), latest: 18, ourDid: OUR });
  assert.deepEqual([due.status, due.evidence], [STATUS.PROBE_DUE, EVIDENCE.UNKNOWN]);
  // Probes whose voids are omitted: retried, then UNKNOWN — never NOT_SETTLED.
  const probes = Array.from({ length: MAX_PROBES }, (_, i) => ({ sweep: 18 + i * 5 }));
  const gone = resolveTrade({ ...t, probes }, { flows: flowsOf(flow(18 + MAX_PROBES * 5 + PROBE_WAIT_SWEEPS, { omitted: { void: 40 } })), latest: 18 + MAX_PROBES * 5 + PROBE_WAIT_SWEEPS, ourDid: OUR });
  assert.deepEqual([gone.status, gone.basis], [STATUS.UNKNOWN, 'PROBES_EXHAUSTED']);
});

test('owner states: unregistered, posted, mint unknown', () => {
  const none = buildLedger({ trades: [], registration: null, flows: flowsOf(flow(5)), prices: prices(5), ourDid: OUR });
  assert.equal(none.owner.state, OWNER.UNREGISTERED);
  const posted = buildLedger({ trades: [], registration: { did: OUR, postedAt: at(9) }, flows: flowsOf(flow(5)), prices: prices(5), ourDid: OUR });
  assert.equal(posted.owner.state, OWNER.REGISTRATION_POSTED);
  const unknown = buildLedger({ trades: [], registration, flows: flowsOf(flow(9, { omitted: { mints: 3000 } })), prices: prices(9), ourDid: OUR });
  assert.equal(unknown.owner.state, OWNER.MINT_UNKNOWN);
});

test('sweep arithmetic: a stamp is applied by the first sweep that closes after it', () => {
  assert.equal(sweepFor(sweepTime(882) - 1), 882);
  assert.equal(sweepFor(Date.parse('2026-09-28T13:30:00Z')), 882);
  assert.equal(sweepFor(sweepTime(882) + 1), 883);
});

// ---------------------------------------------------------------- risk gate

const NOW = sweepTime(40) + 60_000;
function healthy(over = {}) {
  const ledger = buildLedger({ trades: [], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(40)), prices: prices(40), ourDid: OUR });
  return {
    contest: { verified: true, refereeDid: referee.did, lockSweep: 2556 },
    observedRefereeDids: [referee.did], refereeSigFailures: 0,
    streams: { 'd-close1-price': { lastOkAt: iso(NOW - 5_000), lastGap: null }, 'd-close1-flow': { lastOkAt: iso(NOW - 5_000), lastGap: null } },
    price: { n: 40, for: 41, ref: { px: '224.00', time: iso(NOW - 90_000) }, postedAt: iso(NOW - 60_000) },
    ledger, attempts: 0, ...over
  };
}
const proposalFor = (snap, over = {}) => ({ ...decide({ ourDid: OUR, ref: 224, nextSweep: 41, netPosition: 0, idHint: 'mfk-gate' }, DEFAULT_POLICY), ...over });

test('the gate opens only when everything checks out', () => {
  const g = approveTrade(healthy(), proposalFor(), DEFAULT_POLICY, NOW);
  assert.deepEqual(g, { ok: true, reasons: [] });
});

test('the gate halts: stale reference, unverified contest, changed referee, gap, dead read', () => {
  const s = healthy();
  const reasons = (snap) => approveTrade(snap, proposalFor(), DEFAULT_POLICY, NOW).reasons;
  assert.ok(reasons({ ...s, price: { ...s.price, postedAt: iso(NOW - 20 * 60_000) } }).includes(REASON.REFERENCE_STALE));
  assert.ok(reasons({ ...s, price: { ...s.price, ref: { px: '224.00', time: iso(NOW - 3600_000) } } }).includes(REASON.REFERENCE_STALE));
  assert.ok(reasons({ ...s, contest: { verified: false } }).includes(REASON.CONTEST_UNVERIFIED));
  assert.ok(reasons({ ...s, observedRefereeDids: [referee.did, stranger.did] }).includes(REASON.REFEREE_DID_CHANGED));
  assert.ok(reasons({ ...s, streams: { ...s.streams, 'd-close1-flow': { lastOkAt: iso(NOW), lastGap: { at: iso(NOW - 60_000) } } } }).includes(REASON.STREAM_GAP));
  assert.ok(reasons({ ...s, streams: { ...s.streams, 'd-close1-price': { lastOkAt: iso(NOW - 3600_000) } } }).includes(REASON.READ_STALE));
});

test('the gate holds: insufficient funds, a pending trade, an unconfirmed mint, size over policy', () => {
  const s = healthy();
  const reasons = (snap, p = proposalFor()) => approveTrade(snap, p, DEFAULT_POLICY, NOW).reasons;
  assert.ok(reasons({ ...s, ledger: { ...s.ledger, exposure: { ...s.ledger.exposure, worstFreePolf: 50 } } }).includes(REASON.FUNDS));
  const pendingLedger = buildLedger({ trades: [offer('mfk-open', 39)], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(40)), prices: prices(40), ourDid: OUR });
  assert.ok(reasons({ ...s, ledger: pendingLedger }).includes(REASON.PENDING_TRADE));
  const unminted = buildLedger({ trades: [], registration, flows: flowsOf(flow(40)), prices: prices(40), ourDid: OUR });
  assert.ok(reasons({ ...s, ledger: unminted }).includes(REASON.MINT_NOT_CONFIRMED));
  const big = proposalFor(s, { terms: { ...proposalFor().terms, qty: '5.00' } });
  assert.ok(reasons(s, big).includes(REASON.QTY));
  const far = proposalFor(s, { terms: { ...proposalFor().terms, px: '230.00' } });
  assert.ok(reasons(s, far).includes(REASON.PRICE_POLICY));
  assert.ok(reasons({ ...s, ledger: { ...s.ledger, exposure: { ...s.ledger.exposure, worstAbs: 9.8 } } }).includes(REASON.EXPOSURE));
});

test('a probe is allowed only once it can no longer settle, and only with both signatures valid', () => {
  const s = healthy();
  const ex = new Executor({ loadIdentity: () => me, client: null });
  const own = ex.probeText({ terms: checkedTerms({ id: 'mfk-p', maker: OUR, px: '224.00', qty: '0.50', side: 'buy', taker: 'any', until: 39 }) });
  assert.equal(approveProbe(s, own, DEFAULT_POLICY, NOW).ok, true);
  const early = ex.probeText({ terms: checkedTerms({ id: 'mfk-q', maker: OUR, px: '224.00', qty: '0.50', side: 'buy', taker: 'any', until: 40 }) });
  assert.ok(approveProbe(s, early, DEFAULT_POLICY, NOW).reasons.includes(REASON.NOT_AFTER_UNTIL));
  assert.ok(approveProbe(s, { ...own, takerSig: own.makerSig }, DEFAULT_POLICY, NOW).reasons.includes(REASON.SIGNATURE));
});

test('policy qty is separate from protocol: the rules have no max, our default is small', () => {
  assert.ok(DEFAULT_POLICY.maxTakeQty <= 1);
  assert.ok(checkedTerms({ id: 'x', maker: OUR, px: '224.00', qty: '9999.00', side: 'buy', taker: 'any', until: 5 }), 'protocol accepts it');
  assert.equal(decide({ ourDid: OUR, ref: 224, nextSweep: 5, netPosition: 0, candidate: null, idHint: 'x' }, { ...DEFAULT_POLICY, mode: 'take' }).action, ACTION.NO_ACTION);
});

// ---------------------------------------------------------------- snapshot & alerts

test('alerts fire on changes only; a healthy unchanged run sends nothing', () => {
  const s = healthy();
  const gate = { ok: true, reasons: [], kind: 'open' };
  const snap = buildSnapshot({ contest: { packageSha256: 'x', refereeDid: referee.did }, streams: {}, price: s.price, ledger: s.ledger, pnl: null, ourDid: OUR, trades: [], gate, nowMs: NOW });
  assert.deepEqual(alertsBetween(null, snap), [], 'first run is a baseline');
  assert.deepEqual(alertsBetween(snap, snap), []);
  const broken = { ...snap, contest_verified: false, contest_error: 'package_hash' };
  assert.deepEqual(alertsBetween(snap, broken).map((a) => a.kind), ['contest_verification_failed']);
  const halted = { ...snap, gate: { ok: false, kind: 'halt', reasons: ['reference_stale'] } };
  assert.deepEqual(alertsBetween(snap, halted).map((a) => a.kind).sort(), ['referee_stale', 'risk_gate_halt']);
  const settled = { ...snap, trades: [{ id: 'mfk-a', status: 'SETTLED', evidence: 'INFERRED_PROBE', attributed: true }] };
  assert.deepEqual(alertsBetween(snap, settled).map((a) => a.kind), ['trade_resolved']);
  const top = { ...snap, official_rank: 2 };
  assert.deepEqual(alertsBetween(snap, top).map((a) => a.kind), ['entered_top3']);
  for (const key of ['contest_verified', 'package_sha256', 'referee_did', 'current_sweep', 'reference_price', 'reference_age_seconds',
    'stream_cursor_by_room', 'stream_gap_by_room', 'owner_state', 'free_polf', 'collateral', 'net_position', 'average_entry', 'fees',
    'official_score', 'local_replay_score', 'official_rank', 'pending_trades', 'settled_count', 'void_count_by_reason',
    'maker_fill_latency_ms', 'read_errors_5m', 'write_errors_5m', 'last_successful_referee_read']) assert.ok(key in snap, key);
});
