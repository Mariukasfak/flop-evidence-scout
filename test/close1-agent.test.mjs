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
import { buildLedger, resolveTrade, flowCounts, STATUS, EVIDENCE, OWNERSHIP, OWNER, MAX_PROBES, PROBE_WAIT_SWEEPS } from '../src/close1/ledger.mjs';
import { upstreamAlerts, observeUpstream } from '../src/close1/upstream.mjs';
import { renderClose1Section } from '../src/close1/dashboard-section.mjs';
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
const flow = (n, { settled = [], voids = [], omitted = {}, mints = [], missed = [] } = {}) => [n, { t: 'flow', n, settled, void: voids, omitted, mints, missed }];
const flowsOf = (...entries) => {
  const m = new Map(entries);
  const top = Math.max(...m.keys());
  for (let n = 1; n <= top; n++) if (!m.has(n)) m.set(n, { t: 'flow', n, settled: [], void: [], omitted: {}, mints: [], missed: [] });
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
/** A referee record naming the copy that settled — the provenance no public source offers today. */
const provenanceFor = (id, { maker = OUR, countersigner = stranger.did, sweep = 12 } = {}) => new Map([[id, { sweep, maker, countersigner, source: 'REFEREE_SIGNED' }]]);

test('a settled id is NOT our settlement: our own offer id listed settled stays ID_SETTLED, ownership UNPROVEN', () => {
  const flows = flowsOf(flow(12, { settled: ['mfk-a'] }), flow(20));
  const r = resolveTrade(offer('mfk-a', 10), { flows, latest: 20, ourDid: OUR });
  assert.deepEqual([r.status, r.evidence, r.ownership], [STATUS.ID_SETTLED, EVIDENCE.OFFICIAL, OWNERSHIP.UNPROVEN]);
  const L = buildLedger({ trades: [offer('mfk-a', 10)], registration, flows, prices: prices(20), ourDid: OUR });
  assert.equal(L.exposure.definite, 0, 'not in the proven position');
  assert.deepEqual([L.exposure.low, L.exposure.high], [0, 0.5], 'only in the possible range');
  assert.equal(L.settledProvenCount, 0);
  assert.equal(L.idSettledCount, 1);
});

test('with copy provenance naming our key, the same listing becomes SETTLED_PROVEN; naming another, NOT_OURS', () => {
  const flows = flowsOf(flow(12, { settled: ['mfk-a'] }), flow(20));
  const ours = buildLedger({ trades: [offer('mfk-a', 10)], registration, flows, prices: prices(20), ourDid: OUR, provenance: provenanceFor('mfk-a') });
  const r = ours.resolutions.get('mfk-a');
  assert.deepEqual([r.status, r.ownership], [STATUS.SETTLED_PROVEN, OWNERSHIP.PROVEN]);
  assert.equal(ours.exposure.definite, 0.5);
  assert.equal(ours.settledProvenCount, 1);
  // A copy with our id but another maker (the fold keys `settled` on the id alone).
  const theirs = resolveTrade(offer('mfk-a', 10), { flows, latest: 20, ourDid: OUR, provenance: provenanceFor('mfk-a', { maker: stranger.did }) });
  assert.equal(theirs.status, STATUS.NOT_OURS);
  // Provenance from anything but a verified referee record is ignored.
  const hearsay = new Map([['mfk-a', { maker: OUR, countersigner: stranger.did, source: 'PEER_CLAIM' }]]);
  assert.equal(resolveTrade(offer('mfk-a', 10), { flows, latest: 20, ourDid: OUR, provenance: hearsay }).status, STATUS.ID_SETTLED);
});

test('REGRESSION: a re-post-confirmed settlement is tracked in exposure (as a range until proven ours)', () => {
  // The old maker code summed `outcome === "settled"` and skipped "settled (confirmed by re-post)".
  const t = { ...offer('mfk-aaa', 10), outcome: 'settled (confirmed by re-post)', probe: { sweep: 20 } };
  const flows = flowsOf(flow(21, { voids: [['mfk-aaa', 'settled']] }), flow(24));
  const L = buildLedger({ trades: [t], registration, flows, prices: prices(24), ourDid: OUR });
  const r = L.resolutions.get('mfk-aaa');
  assert.deepEqual([r.status, r.evidence, r.ownership], [STATUS.ID_SETTLED, EVIDENCE.INFERRED_PROBE, OWNERSHIP.UNPROVEN]);
  assert.equal(L.exposure.high, 0.5, 'counted in the worst case, not dropped');
  const proven = buildLedger({ trades: [t], registration, flows, prices: prices(24), ourDid: OUR, provenance: provenanceFor('mfk-aaa', { sweep: 12 }) });
  assert.equal(proven.replay.netPosition, 0.5, 'and in the net position once provenance names our copy');
  assert.equal(decide({ ourDid: OUR, ref: 224, nextSweep: 25, netPosition: proven.replay.netPosition, idHint: 'mfk-next' }, DEFAULT_POLICY).terms.side, 'sell');
});

test('official vs inferred evidence is a field: listing, probe, fold order', () => {
  const probed = resolveTrade({ ...offer('mfk-b', 10), probes: [{ sweep: 18 }] }, { flows: flowsOf(flow(19, { voids: [['mfk-b', 'expired']] }), flow(22)), latest: 22, ourDid: OUR });
  assert.deepEqual([probed.status, probed.evidence, probed.ownership], [STATUS.NOT_SETTLED, EVIDENCE.INFERRED_PROBE, OWNERSHIP.NOT_APPLICABLE]);
  const L = buildLedger({ trades: [{ ...offer('mfk-b', 10), probes: [{ sweep: 18 }] }], registration, flows: flowsOf(flow(19, { voids: [['mfk-b', 'expired']] }), flow(22)), prices: prices(22), ourDid: OUR });
  assert.deepEqual([L.owner.state, L.owner.evidence, L.owner.assumption], [OWNER.MINT_CONFIRMED, EVIDENCE.INFERRED_FOLD_ORDER, 'ID_UNIQUE_TO_US']);
  const listed = buildLedger({ trades: [], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(5)), prices: prices(5), ourDid: OUR });
  assert.deepEqual([listed.owner.state, listed.owner.evidence], [OWNER.MINT_CONFIRMED, EVIDENCE.OFFICIAL]);
});

test('a take of an open offer: listed settled or void-settled is id-level only; an expired probe proves none', () => {
  const t = takeOf('open1', 10);
  const listed = resolveTrade(t, { flows: flowsOf(flow(10, { settled: ['open1'] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([listed.status, listed.ownership], [STATUS.ID_SETTLED, OWNERSHIP.UNPROVEN]);
  const L = buildLedger({ trades: [t], registration, flows: flowsOf(flow(10, { settled: ['open1'] }), flow(30)), prices: prices(30), ourDid: OUR });
  assert.equal(L.replay.netPosition, 0, 'not counted as ours');
  assert.deepEqual([L.exposure.low, L.exposure.high], [-1, 0], 'but inside the worst case');
  const lost = resolveTrade(t, { flows: flowsOf(flow(10, { voids: [['open1', 'settled']] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([lost.status, lost.voidReason, lost.ownership], [STATUS.ID_SETTLED, 'settled', OWNERSHIP.UNPROVEN]);
  const expired = resolveTrade({ ...t, probes: [{ sweep: 25 }] }, { flows: flowsOf(flow(26, { voids: [['open1', 'expired']] }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([expired.status, expired.ownership], [STATUS.NOT_SETTLED, OWNERSHIP.NOT_APPLICABLE]);
  // A named-taker offer to us is still id-level: someone may reuse the id with other keys.
  const named = resolveTrade(takeOf('named1', 10, { taker: OUR }), { flows: flowsOf(flow(10, { settled: ['named1'] }), flow(30)), latest: 30, ourDid: OUR });
  assert.equal(named.ownership, OWNERSHIP.UNPROVEN);
});

test('UNKNOWN_OMITTED: aggregate activity the referee did not list is a terminal evidence state', () => {
  const { text: _gone, ...old } = takeOf('open2', 10);    // a take from before we stored its text: not probeable
  const hidden = resolveTrade(old, { flows: flowsOf(flow(10, { voids: [['open2', 'funds']], omitted: { settled: 351, void: 22 } }), flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([hidden.status, hidden.evidence, hidden.basis, hidden.voidReason], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN_OMITTED, 'NOT_PROBEABLE', 'funds']);
  const quiet = resolveTrade(old, { flows: flowsOf(flow(30)), latest: 30, ourDid: OUR });
  assert.deepEqual([quiet.status, quiet.evidence], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN], 'no omissions: plain UNKNOWN');
  // Probes whose voids are omitted: retried, then terminal — never NOT_SETTLED.
  const t = offer('mfk-quiet', 10);
  const probes = Array.from({ length: MAX_PROBES }, (_, i) => ({ sweep: 18 + i * 5 }));
  const end = 18 + MAX_PROBES * 5 + PROBE_WAIT_SWEEPS;
  const gone = resolveTrade({ ...t, probes }, { flows: flowsOf(flow(19, { omitted: { void: 40 } }), flow(end)), latest: end, ourDid: OUR });
  assert.deepEqual([gone.status, gone.evidence, gone.basis], [STATUS.UNKNOWN, EVIDENCE.UNKNOWN_OMITTED, 'PROBES_EXHAUSTED']);
});

test('listed and omitted counts are tracked; an empty list with omissions is not an empty sweep', () => {
  const c = flowCounts({ n: 312, mints: [], settled: [], void: [['x', 'funds']], omitted: { mints: 3230, settled: 1375, void: 146 }, missed: [[1, 5]] });
  assert.deepEqual(c, { n: 312, listed: { mints: 0, settled: 0, void: 1 }, omitted: { mints: 3230, settled: 1375, void: 146 }, missed: 1 });
  const t = offer('mfk-c', 10);
  const r = resolveTrade(t, { flows: flowsOf(flow(12, { omitted: { settled: 900 } }), flow(14)), latest: 14, ourDid: OUR });
  assert.equal(r.status, STATUS.PENDING);
  assert.ok(r.flowCounts.some((x) => x.n === 12 && x.omitted.settled === 900), 'the counts behind the verdict travel with it');
  const L = buildLedger({ trades: [], registration, flows: flowsOf(flow(14, { omitted: { settled: 900, void: 3 } })), prices: prices(14), ourDid: OUR });
  assert.deepEqual(L.latestFlowCounts.omitted, { mints: 0, settled: 900, void: 3 });
});

test('the probe for our newest offer is not starved: a listed expired void settles it as NOT_SETTLED', () => {
  const r = resolveTrade(offer('mfk-77', 312, { until: 318 }), { flows: flowsOf(flow(320, { voids: [['mfk-77', 'expired']] }), flow(322)), latest: 322, ourDid: OUR });
  assert.deepEqual([r.status, r.evidence, r.basis], [STATUS.NOT_SETTLED, EVIDENCE.OFFICIAL, 'FLOW_VOID_EXPIRED']);
});

test('owner states: unregistered, posted, mint unknown', () => {
  const none = buildLedger({ trades: [], registration: null, flows: flowsOf(flow(5)), prices: prices(5), ourDid: OUR });
  assert.equal(none.owner.state, OWNER.UNREGISTERED);
  const posted = buildLedger({ trades: [], registration: { did: OUR, postedAt: at(9) }, flows: flowsOf(flow(5)), prices: prices(5), ourDid: OUR });
  assert.equal(posted.owner.state, OWNER.REGISTRATION_POSTED);
  const unknown = buildLedger({ trades: [], registration, flows: flowsOf(flow(9, { omitted: { mints: 3000 } })), prices: prices(9), ourDid: OUR });
  assert.equal(unknown.owner.state, OWNER.MINT_UNKNOWN);
  const takesOnly = buildLedger({ trades: [takeOf('t1', 3)], registration, flows: flowsOf(flow(3, { voids: [['t1', 'funds']] }), flow(9)), prices: prices(9), ourDid: OUR });
  assert.equal(takesOnly.owner.state, OWNER.MINT_UNKNOWN, 'a void on a take is some copy\'s, not proof of our mint');
});

test('the POLF balance is shown only when provable: official mint and no trade of unknown effect', () => {
  const clean = buildLedger({ trades: [], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(9)), prices: prices(9), ourDid: OUR });
  assert.deepEqual([clean.balance.provable, clean.balance.polf], [true, 10000]);
  const murky = buildLedger({ trades: [offer('mfk-u', 3)], registration, flows: flowsOf(flow(3, { mints: [OUR] }), flow(20)), prices: prices(20), ourDid: OUR });
  assert.deepEqual([murky.balance.provable, murky.balance.polf], [false, null]);
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
const withQty = (q) => proposalFor(null, { terms: { ...proposalFor().terms, qty: q } });

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
  assert.ok(reasons(s, withQty('5.00')).includes(REASON.QTY));
  const far = proposalFor(s, { terms: { ...proposalFor().terms, px: '230.00' } });
  assert.ok(reasons(s, far).includes(REASON.PRICE_POLICY));
  assert.ok(reasons({ ...s, ledger: { ...s.ledger, exposure: { ...s.ledger.exposure, worstAbs: 9.8 } } }).includes(REASON.EXPOSURE));
});

test('quantity stays at 0.50 or below until one of our trades is SETTLED_PROVEN', () => {
  const s = healthy();
  const reasons = (snap, q) => approveTrade(snap, withQty(q), DEFAULT_POLICY, NOW).reasons;
  assert.ok(!reasons(s, '0.50').includes(REASON.QTY));
  assert.ok(reasons(s, '0.51').includes(REASON.QTY));
  assert.ok(reasons(s, '1.00').includes(REASON.QTY));
  const proven = { ...s, ledger: { ...s.ledger, settledProvenCount: 1 } };
  assert.ok(!reasons(proven, '1.00').includes(REASON.QTY));
  assert.ok(reasons(proven, '1.01').includes(REASON.QTY));
  assert.equal(DEFAULT_POLICY.offerQty, 0.5, 'the strategy offers half a contract');
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

// ---------------------------------------------------------------- snapshot, alerts, upstream, dashboard

function snapOf(over = {}) {
  const s = healthy();
  const gate = { ok: true, reasons: [], kind: 'open' };
  return { ...buildSnapshot({ contest: { packageSha256: 'x', refereeDid: referee.did }, streams: {}, price: s.price, ledger: s.ledger, pnl: null, ourDid: OUR, trades: [], gate, nowMs: NOW, integrity: { seedRecords: 1, foreignAuthors: [], sigFailures: 0 } }), ...over };
}

test('alerts fire on changes only; a healthy unchanged run sends nothing', () => {
  const snap = snapOf();
  assert.deepEqual(alertsBetween(null, snap), [], 'first run is a baseline');
  assert.deepEqual(alertsBetween(snap, snap), []);
  assert.deepEqual(alertsBetween(snap, { ...snap, contest_verified: false, contest_error: 'package_hash' }).map((a) => a.kind), ['contest_verification_failed']);
  assert.deepEqual(alertsBetween(snap, { ...snap, gate: { ok: false, kind: 'halt', reasons: ['reference_stale'] } }).map((a) => a.kind).sort(), ['referee_stale', 'risk_gate_halt']);
  const idSettled = { ...snap, trades: [{ id: 'mfk-a', status: STATUS.ID_SETTLED, evidence: 'INFERRED_PROBE', ownership: 'UNPROVEN', terminal: true }] };
  const a = alertsBetween(snap, idSettled);
  assert.deepEqual(a.map((x) => x.kind), ['trade_resolved']);
  assert.match(a[0].text, /not proven/);
  assert.deepEqual(alertsBetween(snap, { ...snap, official_rank: 2 }).map((x) => x.kind), ['entered_top3']);
  for (const key of ['contest_verified', 'package_sha256', 'referee_did', 'current_sweep', 'reference_price', 'reference_age_seconds',
    'stream_cursor_by_room', 'stream_gap_by_room', 'owner_state', 'free_polf', 'collateral', 'net_position', 'proven_position', 'average_entry', 'fees',
    'official_score', 'local_replay_score', 'official_rank', 'pending_trades', 'open_offers', 'settled_count', 'settled_proven_count', 'void_count_by_reason',
    'flow_counts', 'evidence_confidence', 'latest_trade', 'balance_provable', 'polf_balance',
    'maker_fill_latency_ms', 'read_errors_5m', 'write_errors_5m', 'last_successful_referee_read']) assert.ok(key in snap, key);
});

test('alerts: a second seed record, or a foreign author or bad signature in a referee room', () => {
  const snap = snapOf();
  assert.deepEqual(alertsBetween(snap, { ...snap, integrity: { ...snap.integrity, seed_records: 2 } }).map((a) => a.kind), ['seed_changed']);
  assert.deepEqual(alertsBetween(snap, { ...snap, integrity: { ...snap.integrity, foreign_referee_authors: [stranger.did] } }).map((a) => a.kind), ['referee_key_changed']);
  assert.deepEqual(alertsBetween(snap, { ...snap, integrity: { ...snap.integrity, referee_signature_failures: 1 } }).map((a) => a.kind), ['referee_key_changed']);
});

const PIN = { packageSha256: PINNED.packageSha256 };
const obs = (over = {}) => ({
  treeSha: 't1', files: { 'contest.json': 'a', 'manifest.json': 'b' }, manifestSha256: PINNED.packageSha256, manifestStatus: 'draft', rulesVersion: '0.1-draft',
  headCommit: { sha: '66c1da3653', title: 'Rules' }, issues: { 10: { title: 'Mint flow stalled', state: 'open', comments: 2 } },
  watched: { 10: { state: 'open', comments: 2, latest: [] } }, ...over
});

test('upstream: quiet when nothing changed; alerts on rules, draft status, launch record, issue #10', () => {
  assert.deepEqual(upstreamAlerts(null, obs(), PIN), [], 'first look at an unchanged repo');
  assert.deepEqual(upstreamAlerts(obs(), obs(), PIN), []);
  const kinds = (next) => upstreamAlerts(obs(), next, PIN).map((a) => a.kind).sort();
  assert.deepEqual(kinds(obs({ treeSha: 't2', files: { 'contest.json': 'c', 'manifest.json': 'd' }, manifestSha256: 'e'.repeat(64) })), ['package_changed_upstream', 'rules_repo_changed']);
  assert.deepEqual(kinds(obs({ manifestStatus: 'final' })), ['package_not_draft']);
  assert.deepEqual(kinds(obs({ rulesVersion: '1.0' })), ['rules_version_final']);
  assert.deepEqual(kinds(obs({ treeSha: 't3', files: { ...obs().files, 'launch-record.json.sig': 'f' } })), ['launch_record_published', 'rules_repo_changed']);
  const reply = obs({ issues: { 10: { title: 'x', state: 'open', comments: 3 } }, watched: { 10: { state: 'open', comments: 3, latest: [{ author: 'ktrxktr', text: '5/5 settled' }] } } });
  const a = upstreamAlerts(obs(), reply, PIN);
  assert.deepEqual(a.map((x) => x.kind), ['watched_issue_update']);
  assert.match(a[0].text, /ktrxktr: 5\/5 settled/);
  assert.deepEqual(kinds(obs({ issues: { ...obs().issues, 11: { title: 'new', state: 'open', comments: 0 } } })), ['new_issue']);
});

test('upstream: an unchanged tree reuses the last manifest read; comments are fetched only when the count moves', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const body = url.includes('/git/trees/') ? { sha: 't1', tree: [{ type: 'blob', path: 'manifest.json', sha: 'b' }] }
      : url.includes('/issues?') ? [{ number: 10, title: 'Mint flow stalled', state: 'open', comments: 2, updated_at: 'x' }]
        : null;
    return { ok: true, json: async () => body, text: async () => '' };
  };
  const next = await observeUpstream({ prev: obs(), fetchFn, nowMs: NOW });
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.equal(next.manifestSha256, PINNED.packageSha256);
});

test('the dashboard section shows proven vs possible, listed vs omitted, and escapes what it prints', () => {
  const html = renderClose1Section(snapOf({
    flow_counts: { n: 312, listed: { mints: 0, settled: 0, void: 1 }, omitted: { mints: 3230, settled: 1375, void: 146 }, missed: 0 },
    exposure_low: -4.5, exposure_high: 6.92, balance_provable: false, free_polf_worst_case: 7304.57,
    latest_trade: { id: '<script>', status: 'ID_SETTLED', evidence: 'OFFICIAL', ownership: 'UNPROVEN' }
  }));
  for (const s of ['Proven position', '-4.5 … 6.92', 'not provable', 'omitted</strong> settled 1375', 'Gate', 'Evidence confidence', 'Open offers', 'Latest trade']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('<script>'));
  assert.equal(renderClose1Section(null), '');
});

test('the close-1 timer is a real unit, installed and enabled by the updater, at the same 20-minute cadence', () => {
  const timer = fs.readFileSync('deploy/close1-take.timer', 'utf8');
  assert.match(timer, /OnCalendar=\*:03\/20/);
  assert.match(timer, /WantedBy=timers.target/);
  const svc = fs.readFileSync('deploy/close1-take.service', 'utf8');
  assert.match(svc, /ExecStart=\/usr\/bin\/node tools\/close1-take.mjs --go/);
  const installer = fs.readFileSync('deploy/reinstall-units.sh', 'utf8');
  assert.match(installer, /close1-take.service close1-take.timer/);
  assert.match(installer, /enable --now close1-take.timer/);
});
