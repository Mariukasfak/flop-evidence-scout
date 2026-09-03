import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { TclkEngine, publicDealView, secretOpens, githubRawUrl, MAX_CONTEXT_CHARS } from '../src/tclk-engine.mjs';
import {
  encodeFrame, decodeFrame, offerId, contractId, dealRoom, paperNote, encodePaperRecord,
  decodePaperRecord, opensStatement, OFFER_ROOM
} from '../src/tclk.mjs';

/**
 * A venue in memory: rooms of signed messages and notes with the server's CAS
 * semantics. `from` on a stored message is the transport-verified DID, which
 * is the one thing the spec lets a reader trust.
 */
function makeVenue() {
  const rooms = new Map();
  const notes = new Map();
  const posts = [];
  let seq = 0;
  const room = (name) => { if (!rooms.has(name)) rooms.set(name, []); return rooms.get(name); };
  return {
    rooms, notes, posts,
    baseUrl: 'https://test.example',
    /** A stranger writes a signed line. */
    say(name, did, text) { const m = { seq: ++seq, from: did, text, ts: new Date().toISOString() }; room(name).push(m); return m; },
    async readRoom(name, { limit = 50 } = {}) { return { messages: room(name).slice(-limit) }; },
    async postMessage(name, text, identity) { posts.push({ room: name, text, did: identity.did }); this.say(name, identity.did, text); },
    async readNote(ns, key) { return notes.has(`${ns}/${key}`) ? notes.get(`${ns}/${key}`) : null; },
    async getKv(ns, key) { return this.readNote(ns, key); },
    async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
      const k = `${ns}/${key}`; const cur = notes.get(k);
      if (ifAbsent && cur !== undefined) throw new Error('HTTP 409');
      if (ifValue !== null && cur !== ifValue) throw new Error('HTTP 409');
      notes.set(k, String(value)); return true;
    }
  };
}

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

/** A real-enough answer: over the eighty-character floor, no template phrase, no refusal. */
const GOOD_ANSWER = 'A hash time-locked contract guarantees the payee that funds locked under the '
  + 'statement cannot be pulled back before the refund deadline and are claimable by revealing the '
  + 'preimage; it guarantees the payer nothing about whether any work arrives, because the secret is '
  + 'a payment condition and not evidence of delivery.';

function makeBackend(text) {
  return { id: 'test-backend', simulated: false, async generate() { return { text, modelId: 'test' }; } };
}

function payerOffer(payer, { job, claimByMs = T0 + HOUR, refundAfterMs = T0 + 2 * HOUR, rails = ['flop-htlc', 'paper'], lock = 'hash', role = 'payer' } = {}) {
  const fields = {
    amount: '250', asset: 'FLOP', claimByMs, expiresMs: T0 + HOUR, from: payer.did,
    ...(job ? { job } : {}), lock, nonce: 'aa11bb22cc33dd44', rails, refundAfterMs, role, type: 'offer'
  };
  return { ...fields, id: offerId(fields) };
}

function engineFor(venue, identity, { otherDids = [], now = () => T0, ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-'));
  return new TclkEngine({ identity, client: venue, statePath: path.join(dir, 'tclk-state.json'), otherDids, now, ...rest });
}

describe('tclk payee lane: accepting', () => {
  test('accepts a valid paper hash-lock offer from a stranger, and the contract id is the reference one', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    const offer = payerOffer(payer, { job: { proto: 'a2a', id: 'task-7' } });
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    const engine = engineFor(venue, me);

    const result = await engine.runTurn();

    assert.equal(result.action, 'offer_accepted');
    assert.equal(result.payer, payer.did);
    assert.equal(venue.posts.length, 1);
    assert.equal(venue.posts[0].room, OFFER_ROOM);
    assert.equal(venue.posts[0].did, me.did, 'signed by Scout');

    const accept = decodeFrame(venue.posts[0].text);
    assert.equal(accept.type, 'accept');
    assert.equal(accept.ref, offer.id);
    const expected = contractId(offer, { from: me.did, ref: offer.id, statement: accept.statement, paymentKey: undefined, nonce: accept.nonce });
    assert.equal(accept.contract, expected, 'both sides must derive the same contract');
    assert.equal(result.room, dealRoom(expected));

    const state = engine.load();
    assert.equal(state.deal.status, 'accepted');
    assert.equal(secretOpens(state), true, 'the secret we keep opens the statement we published');
    assert.equal(venue.posts[0].text.includes(state.deal.secret), false, 'the secret never goes on the tape at accept');
    assert.equal(publicDealView(state).contract, expected);
    assert.equal('secret' in publicDealView(state), false);
  });

  test('prefers an offer that names a job over one that does not', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const a = generateIdentity(); const b = generateIdentity();
    venue.say(OFFER_ROOM, a.did, encodeFrame(payerOffer(a)));                                   // no job, newer wins on ties
    venue.say(OFFER_ROOM, b.did, encodeFrame(payerOffer(b, { job: { proto: 'a2a', id: 'x' } })));
    venue.say(OFFER_ROOM, a.did, encodeFrame({ ...payerOffer(a), nonce: 'ff11bb22cc33dd44', id: undefined }));
    const engine = engineFor(venue, me);
    const result = await engine.runTurn();
    assert.equal(result.payer, b.did);
  });

  test('refuses everything the spec or the three-party rule says it must', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const sibling = generateIdentity(); const stranger = generateIdentity();
    const bad = [
      payerOffer(me),                                                       // our own
      payerOffer(sibling),                                                  // Scribe's
      payerOffer(stranger, { rails: ['flop-htlc'] }),                       // no paper rail
      payerOffer(stranger, { lock: 'point' }),                              // unaudited path
      payerOffer(stranger, { role: 'payee' }),                              // they want to be payee; we would be payer
      payerOffer(stranger, { claimByMs: T0 - 1, refundAfterMs: T0 + HOUR }), // expired
      payerOffer(stranger, { claimByMs: T0 + 5 * 60_000 }),                 // window shorter than our floor
      { ...payerOffer(stranger), id: '0x' + 'ab'.repeat(32) }               // lies about its own id
    ];
    for (const o of bad) venue.say(OFFER_ROOM, o.from, encodeFrame(o));
    // And one already accepted by somebody else.
    const taken = payerOffer(stranger, { claimByMs: T0 + HOUR + 1 });
    venue.say(OFFER_ROOM, stranger.did, encodeFrame(taken));
    // Accepted by a stranger whose accept is transport-verified: `from` inside
    // the frame is the key that signed it. An accept that fails that check is
    // data, not a commitment, and must NOT count as taken - that case is below.
    const rival = generateIdentity();
    venue.say(OFFER_ROOM, rival.did, encodeFrame({ type: 'accept', from: rival.did, ref: taken.id, statement: '0x' + '1'.repeat(64), nonce: '0000000000000000', contract: '0x' + '2'.repeat(64) }));

    const engine = engineFor(venue, me, { otherDids: [sibling.did] });
    const result = await engine.runTurn();

    assert.equal(result.action, 'no_acceptable_offer');
    assert.equal(venue.posts.length, 0);
  });

  test('an accept that is not transport-verified does not take an offer off the table', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    const offer = payerOffer(payer);
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    // Somebody posts an accept claiming to be a third key. The spec: an unsigned
    // frame is data, not a commitment - readers drop it.
    venue.say(OFFER_ROOM, generateIdentity().did, encodeFrame({ type: 'accept', from: generateIdentity().did, ref: offer.id, statement: '0x' + '1'.repeat(64), nonce: '0000000000000000', contract: '0x' + '2'.repeat(64) }));
    const engine = engineFor(venue, me);
    assert.equal((await engine.runTurn()).action, 'offer_accepted');
  });

  test('a frame whose signed sender is not its own `from` is not an offer', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity(); const forger = generateIdentity();
    venue.say(OFFER_ROOM, forger.did, encodeFrame(payerOffer(payer)));  // forger posts a frame claiming to be payer
    const engine = engineFor(venue, me);
    assert.equal((await engine.runTurn()).action, 'no_acceptable_offer');
  });
});

describe('tclk payee lane: lock, verify, reveal', () => {
  async function acceptedDeal({ job } = {}) {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    const offer = payerOffer(payer, { job });
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    let clock = T0;
    const engine = engineFor(venue, me, { now: () => clock });
    await engine.runTurn();
    const deal = engine.load().deal;
    return { venue, me, payer, offer, engine, deal, tick: (ms) => { clock += ms; } };
  }

  test('waits for a lock, ignores a lock from the wrong key, and will not reveal on an unverified rail', async () => {
    const { venue, payer, engine, deal } = await acceptedDeal();

    assert.equal((await engine.runTurn()).action, 'waiting_for_lock');

    venue.say(deal.room, generateIdentity().did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    assert.equal((await engine.runTurn()).action, 'waiting_for_lock', 'a lock frame not signed by the payer is noise');

    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const unverified = await engine.runTurn();
    assert.equal(unverified.action, 'lock_not_verified', 'the frame proves a message was posted and nothing more');
    assert.equal(unverified.railRecord, 'absent');

    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: '0x' + '9'.repeat(64), refundAfterMs: deal.offer.refundAfterMs }));
    assert.equal((await engine.runTurn()).action, 'lock_not_verified', 'a record under a different statement is not our lock');
    assert.equal(venue.posts.filter((p) => p.text.includes('"type":"reveal"')).length, 0, 'no reveal while unverified');
  });

  test('a verified lock is followed by work, reveal, a CAS claim against the exact bytes, and a receipt', async () => {
    const { venue, me, payer, engine, deal } = await acceptedDeal();
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    const locked = encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs });
    venue.notes.set(`${ns}/${key}`, locked);

    assert.equal((await engine.runTurn()).action, 'lock_verified');
    assert.equal(engine.load().deal.status, 'locked');

    const claimed = await engine.runTurn();
    assert.equal(claimed.action, 'deal_claimed');
    assert.equal(claimed.railClaimed, true);

    const inRoom = venue.rooms.get(deal.room).filter((m) => m.from === me.did).map((m) => m.text);
    assert.ok(inRoom.some((t) => t.startsWith('tclk-work | ') && t.includes('rehearsal')), 'says plainly there was no work attached');
    const reveal = inRoom.map(decodeFrame).find((f) => f?.type === 'reveal');
    assert.ok(reveal);
    assert.equal(opensStatement(reveal.secret, deal.statement), true, 'the published secret opens the statement');
    const receipt = inRoom.map(decodeFrame).find((f) => f?.type === 'receipt');
    assert.equal(receipt.outcome, 'claimed');

    const record = decodePaperRecord(venue.notes.get(`${ns}/${key}`));
    assert.equal(record.status, 'claimed');
    assert.equal(record.secret, reveal.secret);

    const state = engine.load();
    assert.equal(state.deal, null);
    assert.equal(state.completed.length, 1);
    assert.equal(state.completed[0].payer, payer.did);
  });

  test('a rail record that moved under us loses the CAS but the reveal still stands', async () => {
    const { venue, payer, engine, deal } = await acceptedDeal();
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    await engine.runTurn();
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'refunded', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));

    const result = await engine.runTurn();
    assert.equal(result.action, 'deal_claimed');
    assert.equal(result.railClaimed, false);
    assert.ok(venue.posts.some((p) => p.text.includes('"type":"reveal"')));
    assert.match(engine.load().completed[0].reason, /CAS lost/);
  });

  test('a payer who never locks is cancelled at claimByMs, and the deal is not counted as done', async () => {
    const { venue, engine, deal, tick } = await acceptedDeal();
    tick(HOUR);
    const result = await engine.runTurn();
    assert.equal(result.action, 'deal_cancelled');
    const cancel = venue.rooms.get(deal.room).map((m) => decodeFrame(m.text)).find((f) => f?.type === 'cancel');
    assert.equal(cancel.contract, deal.contract);
    const state = engine.load();
    assert.equal(state.deal, null);
    assert.equal(state.completed.length, 0);
    assert.equal(state.abandoned.length, 1);
  });

  test('a lock that is only verified after the refund window opens is not revealed against', async () => {
    const { venue, payer, engine, deal, tick } = await acceptedDeal();
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    await engine.runTurn();
    tick(2 * HOUR);
    assert.equal((await engine.runTurn()).action, 'deal_expired');
    assert.equal(venue.posts.filter((p) => p.text.includes('"type":"reveal"')).length, 0);
  });

  test('a deal in flight survives a restart from the state file', async () => {
    const { engine, deal } = await acceptedDeal();
    const again = new TclkEngine({ identity: engine.identity, client: engine.client, statePath: engine.statePath, now: () => T0 });
    const state = again.load();
    assert.equal(state.deal.contract, deal.contract);
    assert.equal(secretOpens(state), true);
    assert.equal((await again.runTurn()).action, 'waiting_for_lock');
  });
});

/**
 * The first offer this lane accepted carried `context: "/kv/tclk-job-02/deal-10650402"`
 * - a note path with the task in it. Read it, answer it, and say where it came from.
 */
describe('tclk payee lane: a job whose context is a note path', () => {
  const TASK = 'Explain in two sentences what a hash time-locked contract guarantees to the payee and what it does not guarantee to the payer.';

  async function lockedDealWithKvJob() {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    venue.notes.set('tclk-job-02/deal-1', TASK);
    const offer = payerOffer(payer, { job: { proto: 'a2a', id: 'deal-1', context: '/kv/tclk-job-02/deal-1' } });
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    const engine = engineFor(venue, me);
    await engine.runTurn();
    const deal = engine.load().deal;
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    await engine.runTurn();
    return { venue, me, engine, deal };
  }

  test('the note is read as the task, answered by the model, and the source is named', async () => {
    const { venue, me, engine, deal } = await lockedDealWithKvJob();
    let prompted = '';
    const backend = { id: 'test', simulated: false, async generate({ prompt }) { prompted = String(prompt || ''); return { text: GOOD_ANSWER }; } };

    const result = await engine.runTurn({ backend, real: true });

    assert.equal(result.action, 'deal_claimed');
    assert.ok(prompted.includes('hash time-locked contract'), 'the model saw the task text from the note, not the path');
    const work = venue.rooms.get(deal.room).filter((m) => m.from === me.did).map((m) => m.text).find((t) => t.startsWith('tclk-work | '));
    assert.ok(work.includes('(kv:tclk-job-02/deal-1)'), 'the work line says where the task came from');
    assert.ok(work.includes(GOOD_ANSWER.slice(0, 40)), 'and carries the answer');
    assert.equal(work.includes('rehearsal'), false);
  });

  test('an unreadable note is said to be unreadable, not dressed as a rehearsal with no job', async () => {
    const { venue, me, engine, deal } = await lockedDealWithKvJob();
    venue.notes.delete('tclk-job-02/deal-1');
    const result = await engine.runTurn({ backend: makeBackend(GOOD_ANSWER), real: true });
    assert.equal(result.action, 'deal_claimed');
    const work = venue.rooms.get(deal.room).filter((m) => m.from === me.did).map((m) => m.text).find((t) => t.startsWith('tclk-work | '));
    assert.ok(work.includes('task (kv-empty) could not be answered'), work);
  });

  test('a context that is not a note path is used as inline text', async () => {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    const inline = 'Inline task text long enough to clear the forty character floor for a real answer.';
    const offer = payerOffer(payer, { job: { proto: 'a2a', id: 'x', context: inline } });
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    const engine = engineFor(venue, me);
    await engine.runTurn();
    const deal = engine.load().deal;
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    await engine.runTurn();
    let prompted = '';
    const backend = { id: 'test', simulated: false, async generate({ prompt }) { prompted = String(prompt || ''); return { text: GOOD_ANSWER }; } };
    await engine.runTurn({ backend, real: true });
    assert.ok(prompted.includes('forty character floor'));
    const work = venue.rooms.get(deal.room).filter((m) => m.from === me.did).map((m) => m.text).find((t) => t.startsWith('tclk-work | '));
    // The first version of this assertion passed while the model path was
    // throwing: the fallback line also says "(inline)". Both halves, always.
    assert.ok(work.includes('(inline)'));
    assert.ok(work.includes(GOOD_ANSWER.slice(0, 40)), 'the answer, not the fallback, is what went out');
    assert.equal(work.includes('could not be answered'), false);
  });
});

/**
 * The second offer this lane accepted (2026-09-02, contract 0x476cfe24af79cd89…)
 * pointed at https://github.com/<owner>/<repo>/blob/main/lobby-analysis.md — an
 * article asking for its lobby throughput count to be re-run. Before this block
 * the lane would have handed the model the link as an 84-character task.
 */
describe('tclk payee lane: a job whose context is a GitHub URL', () => {
  const BLOB = 'https://github.com/o/r/blob/main/lobby-analysis.md';
  const RAW = 'https://raw.githubusercontent.com/o/r/main/lobby-analysis.md';
  const ARTICLE = 'Read /r/lobby?format=json twice, subtract the last_seq values, divide by the time between '
    + 'reads. That is the whole method. If your numbers disagree with mine, publish them.';

  function measurementsDirWith(measurement) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-measurements-'));
    if (measurement) fs.writeFileSync(path.join(dir, '2026-09-02.json'), JSON.stringify(measurement));
    return dir;
  }

  async function lockedDealWithUrlJob(context, engineOpts = {}) {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    const offer = payerOffer(payer, { job: { proto: 'a2a', id: 'lobby-throughput-replication', context } });
    venue.say(OFFER_ROOM, payer.did, encodeFrame(offer));
    const engine = engineFor(venue, me, { measurementsDir: measurementsDirWith(null), ...engineOpts });
    await engine.runTurn();
    const deal = engine.load().deal;
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    await engine.runTurn();
    return { venue, me, engine, deal };
  }

  function workLine(venue, me, deal) {
    return venue.rooms.get(deal.room).filter((m) => m.from === me.did).map((m) => m.text).find((t) => t.startsWith('tclk-work | '));
  }

  function recordingBackend() {
    const seen = { prompt: '' };
    const backend = { id: 'test', simulated: false, async generate({ prompt }) { seen.prompt = String(prompt || ''); return { text: GOOD_ANSWER }; } };
    return { backend, seen };
  }

  test('a github.com page URL is read from the raw host, and the model sees the article, not the link', async () => {
    const fetched = [];
    const { venue, me, engine, deal } = await lockedDealWithUrlJob(BLOB, { fetchText: async (url) => { fetched.push(url); return ARTICLE; } });
    const { backend, seen } = recordingBackend();

    const result = await engine.runTurn({ backend, real: true });

    assert.equal(result.action, 'deal_claimed');
    assert.deepEqual(fetched, [RAW], 'the page is rewritten to the raw file and fetched once');
    assert.ok(seen.prompt.includes('subtract the last_seq values'), 'the model saw the article text');
    assert.equal(seen.prompt.includes(BLOB), false, 'and not the link as the task');
    const work = workLine(venue, me, deal);
    assert.ok(work.includes('(url:github.com/o/r/blob/main/lobby-analysis.md)'), work);
    assert.ok(work.includes(GOOD_ANSWER.slice(0, 40)), 'the answer, not the fallback, is what went out');
    assert.equal(work.includes('could not be answered'), false);
  });

  test('a throughput task is answered from our own measurement, named as the board', async () => {
    const measurementsDir = measurementsDirWith({
      measuredAt: '2026-09-02T09:38:42.777Z', server: 'https://technocore.chat',
      throughput: [{ room: 'lobby', seqDelta: 958, elapsedSeconds: 22.1, messagesPerMinute: 2596.9 }]
    });
    const { engine } = await lockedDealWithUrlJob(RAW, { fetchText: async () => ARTICLE, measurementsDir });
    const { backend, seen } = recordingBackend();

    await engine.runTurn({ backend, real: true });

    assert.ok(seen.prompt.includes('STATUS BOARD'), 'the grounded prompt, not the open-knowledge one');
    assert.ok(seen.prompt.includes('room "lobby" on technocore.chat advanced 958 sequence numbers in 22.1 s: 43.3 messages/second (2596.9/minute)'), seen.prompt);
    assert.ok(seen.prompt.includes('source: docs/measurements/2026-09-02.json'));
  });

  test('a task about something else gets no board, so the open-knowledge prompt still applies', async () => {
    const measurementsDir = measurementsDirWith({ measuredAt: '2026-09-02T09:38:42.777Z', throughput: [{ room: 'lobby', seqDelta: 1, elapsedSeconds: 1 }] });
    const essay = 'Explain in two sentences what a hash time-locked contract guarantees to the payee and what it does not guarantee to the payer.';
    const { engine } = await lockedDealWithUrlJob(RAW, { fetchText: async () => essay, measurementsDir });
    const { backend, seen } = recordingBackend();

    await engine.runTurn({ backend, real: true });

    assert.equal(seen.prompt.includes('STATUS BOARD'), false);
    assert.ok(seen.prompt.includes('hash time-locked contract'));
  });

  test('a host that is not GitHub is never fetched, and the work line says so', async () => {
    let calls = 0;
    const { venue, me, engine, deal } = await lockedDealWithUrlJob('https://example.com/task.txt', { fetchText: async () => { calls += 1; return ARTICLE; } });

    const result = await engine.runTurn({ backend: makeBackend(GOOD_ANSWER), real: true });

    assert.equal(result.action, 'deal_claimed');
    assert.equal(calls, 0);
    assert.ok(workLine(venue, me, deal).includes('task (url-unsupported) could not be answered'));
  });

  test('a file that cannot be read is said to be unreachable, not dressed as a job with no text', async () => {
    const { venue, me, engine, deal } = await lockedDealWithUrlJob(BLOB, { fetchText: async () => { throw new Error('HTTP 404'); } });
    await engine.runTurn({ backend: makeBackend(GOOD_ANSWER), real: true });
    assert.ok(workLine(venue, me, deal).includes('task (url-unreachable) could not be answered'));
  });

  test('a page longer than the cap is cut at the cap, not refused', async () => {
    const long = ARTICLE + ' x'.repeat(MAX_CONTEXT_CHARS);
    const { engine } = await lockedDealWithUrlJob(RAW, { fetchText: async () => long });
    const { backend, seen } = recordingBackend();

    await engine.runTurn({ backend, real: true });

    assert.ok(seen.prompt.includes('subtract the last_seq values'));
    assert.ok(seen.prompt.length < MAX_CONTEXT_CHARS + 4000, `the prompt is the cap plus the template, not the page (${seen.prompt.length})`);
  });

  test('githubRawUrl accepts only https GitHub file URLs', () => {
    assert.equal(githubRawUrl(BLOB).url, RAW);
    assert.equal(githubRawUrl(RAW).url, RAW);
    assert.equal(githubRawUrl('http://github.com/o/r/blob/main/x.md'), null);
    assert.equal(githubRawUrl('https://github.com/o/r'), null);
    assert.equal(githubRawUrl('https://github.com.evil.example/o/r/blob/main/x.md'), null);
    assert.equal(githubRawUrl('https://example.com/x.md'), null);
    assert.equal(githubRawUrl('not a url'), null);
  });
});

/**
 * Measured in `tclk-offers` on 2026-09-03, over one 200-message window: eleven
 * locks, every one of them within **31 seconds** of its accept, median **one
 * second**. Meanwhile this lane was holding a dead offer from the previous
 * afternoon until its `claimByMs` — nearly a full day — and could accept none
 * of the live ones on the morning Hayes named agent deals as an airdrop
 * criterion.
 */
describe('tclk payee lane: a payer who does not lock loses the slot', () => {
  async function accepted() {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    venue.say(OFFER_ROOM, payer.did, encodeFrame(payerOffer(payer)));
    let clock = T0;
    const engine = engineFor(venue, me, { now: () => clock });
    await engine.runTurn();
    return { venue, me, payer, engine, deal: engine.load().deal, tick: (ms) => { clock += ms; } };
  }

  test('the deal is dropped minutes after the accept, not a day later at claimBy', async () => {
    const { venue, engine, deal, tick } = await accepted();

    tick(4 * 60_000);
    assert.equal((await engine.runTurn()).action, 'waiting_for_lock', 'four minutes is still within the window');

    tick(2 * 60_000);
    const done = await engine.runTurn();

    assert.equal(done.action, 'deal_cancelled');
    assert.match(done.reason, /did not lock within/);
    assert.ok(deal.offer.claimByMs - T0 > 30 * 60_000, 'and claimBy was still far away');
    const cancel = venue.rooms.get(deal.room).map((m) => decodeFrame(m.text)).find((f) => f?.type === 'cancel');
    assert.ok(cancel, 'the counterparty is told, not just dropped silently');
    assert.equal(engine.load().deal, null, 'the lane is free for a live offer');
  });

  test('a lock that arrives inside the window is still taken', async () => {
    const { venue, payer, engine, deal, tick } = await accepted();
    tick(31_000);                                   // the slowest lock actually measured
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));

    assert.equal((await engine.runTurn()).action, 'lock_verified');
  });

  test('a payer who already failed to lock is not accepted again', async () => {
    const { venue, payer, engine, tick } = await accepted();
    tick(6 * 60_000);
    await engine.runTurn();                          // cancels, records the payer

    venue.say(OFFER_ROOM, payer.did, encodeFrame(payerOffer(payer, { claimByMs: T0 + 4 * HOUR, refundAfterMs: T0 + 5 * HOUR })));
    const again = await engine.runTurn();

    assert.equal(again.action, 'no_acceptable_offer', 'their next offer is skipped');
  });

  test('a stranger is still accepted after another payer went quiet', async () => {
    const { venue, engine, tick } = await accepted();
    tick(6 * 60_000);
    await engine.runTurn();

    const fresh = generateIdentity();
    venue.say(OFFER_ROOM, fresh.did, encodeFrame(payerOffer(fresh, { claimByMs: T0 + 4 * HOUR, refundAfterMs: T0 + 5 * HOUR })));
    const next = await engine.runTurn();

    assert.equal(next.action, 'offer_accepted');
    assert.equal(next.payer, fresh.did, 'one bad payer does not close the lane');
  });
});

/**
 * tclk shipped a check on 2026-09-02 rejecting "receipt frames whose claimed
 * outcome contradicts the contract's terminal state, preventing a later
 * reputation or spend-accounting consumer from accepting a false claimed /
 * refunded / cancelled acknowledgment."
 *
 * Ours was one of those frames. The claim CAS can lose — someone else writes
 * the note between our verify and our claim — and the code posted
 * `outcome: 'claimed'` regardless, while the rail still read `locked`.
 */
describe('tclk payee lane: the receipt may not contradict the rail', () => {
  async function lockVerified() {
    const venue = makeVenue(); const me = generateIdentity(); const payer = generateIdentity();
    venue.say(OFFER_ROOM, payer.did, encodeFrame(payerOffer(payer)));
    const engine = engineFor(venue, me);
    await engine.runTurn();
    const deal = engine.load().deal;
    venue.say(deal.room, payer.did, encodeFrame({ type: 'lock', from: payer.did, contract: deal.contract, rail: 'paper', ref: deal.contract }));
    const { ns, key } = paperNote(deal.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({ status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs }));
    assert.equal((await engine.runTurn()).action, 'lock_verified');
    return { venue, me, engine, deal, note: `${ns}/${key}` };
  }

  const framesFrom = (venue, deal, did) =>
    venue.rooms.get(deal.room).filter((m) => m.from === did).map((m) => decodeFrame(m.text)).filter(Boolean);

  test('when the claim CAS loses and the rail still reads locked, no receipt is posted', async () => {
    const { venue, me, engine, deal, note } = await lockVerified();

    // Somebody else writes the note between our verify and our claim, so the
    // CAS below cannot match the bytes we verified. It has to be a field the
    // record actually carries: the first version of this test added a `note`
    // key, which encodePaperRecord drops, so the bytes were identical and the
    // CAS won — the test passed against the very bug it was written for.
    venue.notes.set(note, encodePaperRecord({
      status: 'locked', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs + 1000
    }));

    const result = await engine.runTurn();

    assert.equal(result.action, 'deal_claimed');
    assert.equal(result.railClaimed, false, 'the CAS lost, as set up');
    assert.equal(result.receipt, false);

    const mine = framesFrom(venue, deal, me.did);
    assert.equal(mine.some((f) => f.type === 'receipt'), false,
      'a receipt saying "claimed" would contradict a rail that reads locked');
    assert.ok(mine.some((f) => f.type === 'reveal'), 'the reveal still stands — publishing the secret IS the claim');
    assert.equal(decodePaperRecord(venue.notes.get(note)).status, 'locked');
  });

  test('when the rail does read claimed, the receipt goes out as before', async () => {
    const { venue, me, engine, deal } = await lockVerified();

    const result = await engine.runTurn();

    assert.equal(result.railClaimed, true);
    assert.equal(result.receipt, true);
    const receipt = framesFrom(venue, deal, me.did).find((f) => f.type === 'receipt');
    assert.equal(receipt.outcome, 'claimed');
    assert.equal(receipt.rail, 'paper');
  });

  test('a rail settled as claimed by someone else still earns a truthful receipt', async () => {
    const { venue, me, engine, deal, note } = await lockVerified();

    // The CAS will lose, but the note ends up saying exactly what our receipt
    // would say — so the receipt is true and there is no reason to withhold it.
    // A `claimed` record must carry the secret: decodePaperRecord rejects one
    // without it, which is why the first draft of this test saw `null` here.
    venue.notes.set(note, encodePaperRecord({
      status: 'claimed', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs, secret: deal.secret
    }));

    const result = await engine.runTurn();

    assert.equal(result.railClaimed, false, 'our own write lost');
    assert.equal(result.receipt, true, 'but the rail agrees with what the receipt claims');
    assert.ok(framesFrom(venue, deal, me.did).some((f) => f.type === 'receipt'));
  });

  test('an unreadable rail is not treated as agreement', async () => {
    const { venue, me, engine, deal, note } = await lockVerified();
    venue.notes.set(note, 'ne tclk irasas');

    const result = await engine.runTurn();

    assert.equal(result.receipt, false);
    assert.equal(framesFrom(venue, deal, me.did).some((f) => f.type === 'receipt'), false);
  });
});
