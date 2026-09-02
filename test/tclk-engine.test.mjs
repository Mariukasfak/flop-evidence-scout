import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { TclkEngine, publicDealView, secretOpens } from '../src/tclk-engine.mjs';
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

function payerOffer(payer, { job, claimByMs = T0 + HOUR, refundAfterMs = T0 + 2 * HOUR, rails = ['flop-htlc', 'paper'], lock = 'hash', role = 'payer' } = {}) {
  const fields = {
    amount: '250', asset: 'FLOP', claimByMs, expiresMs: T0 + HOUR, from: payer.did,
    ...(job ? { job } : {}), lock, nonce: 'aa11bb22cc33dd44', rails, refundAfterMs, role, type: 'offer'
  };
  return { ...fields, id: offerId(fields) };
}

function engineFor(venue, identity, { otherDids = [], now = () => T0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-'));
  return new TclkEngine({ identity, client: venue, statePath: path.join(dir, 'tclk-state.json'), otherDids, now });
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
