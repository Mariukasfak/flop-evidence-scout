import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TclkPayer } from '../src/tclk-payer.mjs';
import { FlopRailClient } from '../src/flop-rail-client.mjs';
import { decodeFrame, encodeFrame, acceptFrameFor, generateHashLock, dealRoom } from '../src/tclk.mjs';

/**
 * The payer on the flop-htlc rail, against a fake venue and a fake rail service.
 * What matters here: the escrow exists and is verified before any frame says so,
 * an uncertain lock is never repeated, a policy refusal ends the deal, and the
 * refund waits for the chain instead of pretending.
 */

const PAYER = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const SIBLING = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const STRANGER = 'did:key:z6MkwBgTg4QUjvCR9hF6HEnA4hc68ug4gri6JjiN3sLzg7ws';
const AMOUNT = '100000000000000000';
const T0 = 1_700_000_000_000;

const BANK = [{
  key: 'api-board-reachability-2026-08',
  title: 'Does flop-kibble.onrender.com/api/board respond from your network?',
  body: 'Success: the HTTP status code and the elapsed time, and say so if it timed out.'
}];

class FakeVenue {
  constructor() { this.rooms = new Map(); this.notes = new Map(); this.posts = []; }
  seed(room, from, text) {
    if (!this.rooms.has(room)) this.rooms.set(room, []);
    this.rooms.get(room).push({ from, text, seq: this.rooms.get(room).length + 1 });
  }
  async readRoom(room) { return { messages: this.rooms.get(room) || [] }; }
  async postMessage(room, text, identity) { this.posts.push({ room, text, from: identity.did }); this.seed(room, identity.did, text); return true; }
  async readNote(ns, key) {
    const v = this.notes.get(`${ns}/${key}`);
    return v === undefined ? { reachable: true, found: false, value: null } : { reachable: true, found: true, value: v };
  }
  async setKv(ns, key, value) { this.notes.set(`${ns}/${key}`, value); return true; }
}

/** The rail service as the payer sees it; each method can be told to fail once. */
class FakeRail {
  constructor() { this.locks = []; this.verifies = 0; this.refunds = []; this.fail = {}; this.onChain = true; }
  #maybeFail(op) {
    const f = this.fail[op];
    if (!f) return;
    delete this.fail[op];
    const e = new Error(f.message || `${op} failed`);
    Object.assign(e, f);
    throw e;
  }
  async lock(terms) { this.locks.push(terms); this.#maybeFail('lock'); return `flop1.ref-${this.locks.length}`; }
  async verifyLock() { this.verifies += 1; this.#maybeFail('verify'); return this.onChain; }
  async refund(ref) { this.refunds.push(ref); this.#maybeFail('refund'); }
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-flop-')), 'state.json');

function makePayer(venue, rail, { now = () => T0, statePath = tmpState() } = {}) {
  return new TclkPayer({
    identity: { did: PAYER, privateKeyPem: 'x' }, client: venue, statePath,
    otherDids: [SIBLING], questionBank: BANK, now, minOfferGapMs: 0,
    rail: 'flop-htlc', railClient: rail, asset: 'FLOP', amount: AMOUNT
  });
}

async function acceptedDeal({ now } = {}) {
  const venue = new FakeVenue();
  const rail = new FakeRail();
  const payer = makePayer(venue, rail, { now });
  await payer.runTurn();
  const offer = decodeFrame(venue.posts.at(-1).text);
  const { secret, statement } = generateHashLock();
  venue.seed('tclk-offers', STRANGER, encodeFrame(acceptFrameFor(offer, { from: STRANGER, statement })));
  assert.equal((await payer.runTurn()).action, 'offer_accepted_by');
  return { venue, rail, payer, offer, secret, statement, contract: payer.state.deal.contract };
}

describe('the flop-htlc payer', () => {
  test('refuses to start without a rail client, FLOP and base units', () => {
    const base = { identity: { did: PAYER }, client: new FakeVenue(), statePath: tmpState(), rail: 'flop-htlc' };
    assert.throws(() => new TclkPayer({ ...base, asset: 'FLOP', amount: AMOUNT }), /railClient/);
    assert.throws(() => new TclkPayer({ ...base, railClient: new FakeRail(), asset: 'PAPER', amount: AMOUNT }), /asset FLOP/);
    assert.throws(() => new TclkPayer({ ...base, railClient: new FakeRail(), asset: 'FLOP', amount: '0.1' }), /base units/);
    assert.throws(() => new TclkPayer({ ...base, rail: 'lightning' }), /unknown rail/);
  });

  test('the offer advertises flop-htlc and real FLOP in base units', async () => {
    const venue = new FakeVenue();
    await makePayer(venue, new FakeRail()).runTurn();
    const offer = decodeFrame(venue.posts[0].text);
    assert.deepEqual(offer.rails, ['flop-htlc']);
    assert.equal(offer.asset, 'FLOP');
    assert.equal(offer.amount, AMOUNT);
  });

  test('locks the exact deal terms, verifies on chain, then announces the ref', async () => {
    const { venue, rail, payer, contract, statement, offer } = await acceptedDeal();
    const r = await payer.runTurn();
    assert.equal(r.action, 'locked');
    assert.equal(rail.locks.length, 1);
    assert.deepEqual(rail.locks[0], {
      contract, lock: 'hash', statement, amount: AMOUNT, asset: 'FLOP',
      payer: PAYER, payee: STRANGER, claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs
    });
    assert.equal(rail.verifies, 1);
    const frame = decodeFrame(venue.posts.at(-1).text);
    assert.equal(frame.type, 'lock');
    assert.equal(frame.rail, 'flop-htlc');
    assert.equal(frame.ref, 'flop1.ref-1');
    assert.equal(venue.posts.at(-1).room, dealRoom(contract));
  });

  test('an escrow the chain does not confirm is never announced, and never re-locked', async () => {
    const { venue, rail, payer } = await acceptedDeal();
    rail.onChain = false;
    assert.equal((await payer.runTurn()).action, 'lock_not_on_rail');
    assert.ok(!venue.posts.some((p) => decodeFrame(p.text)?.type === 'lock'));
    rail.onChain = true;
    assert.equal((await payer.runTurn()).action, 'locked');
    assert.equal(rail.locks.length, 1, 'the second turn re-verifies the same ref');
  });

  test('a lock whose answer was lost is parked for good, across a restart', async () => {
    const { rail, payer, venue } = await acceptedDeal();
    rail.fail.lock = { uncertain: true, message: 'socket hang up' };
    assert.equal((await payer.runTurn()).action, 'lock_uncertain');
    const again = makePayer(venue, rail, { statePath: payer.statePath });
    again.load();
    assert.equal((await again.runTurn()).action, 'lock_uncertain_parked');
    assert.equal(rail.locks.length, 1);
  });

  test('a policy refusal (403) ends the deal instead of retrying', async () => {
    const { rail, payer } = await acceptedDeal();
    rail.fail.lock = { status: 403, message: 'amount above the per-deal cap' };
    assert.equal((await payer.runTurn()).action, 'lock_refused_by_policy');
    assert.equal(payer.state.deal, null);
    assert.match(payer.state.abandoned.at(-1).reason, /flop rail refused/);
  });

  test('a plain failure before submission leaves the deal to retry', async () => {
    const { rail, payer } = await acceptedDeal();
    rail.fail.lock = { status: 502, message: 'chain not ready' };
    assert.equal((await payer.runTurn()).action, 'lock_write_failed');
    assert.equal(payer.state.deal.status, 'accepted');
    assert.equal((await payer.runTurn()).action, 'locked');
  });

  test('no reveal: waits for the chain, then refunds the same ref and posts a refund frame', async () => {
    let clock = T0;
    const { venue, rail, payer } = await acceptedDeal({ now: () => clock });
    await payer.runTurn();
    clock += 151 * 60_000;
    rail.fail.refund = { waiting: true, message: 'refund window not open on chain' };
    assert.equal((await payer.runTurn()).action, 'refund_waiting_for_chain');
    assert.equal(payer.state.deal.status, 'locked');
    const r = await payer.runTurn();
    assert.equal(r.action, 'refunded');
    assert.deepEqual(rail.refunds, ['flop1.ref-1', 'flop1.ref-1']);
    const frame = decodeFrame(venue.posts.at(-1).text);
    assert.equal(frame.type, 'refund');
    assert.equal(frame.ref, 'flop1.ref-1');
    assert.match(payer.state.abandoned.at(-1).reason, /FLOP refunded/);
  });

  test('a valid reveal closes the deal; the payee claims, we never touch the secret', async () => {
    const { venue, rail, payer, contract, secret } = await acceptedDeal();
    await payer.runTurn();
    venue.seed(dealRoom(contract), STRANGER, 'HTTP 200 in 0.4s from Nuremberg.');
    venue.seed(dealRoom(contract), STRANGER, encodeFrame({ type: 'reveal', from: STRANGER, contract, secret }));
    const r = await payer.runTurn();
    assert.equal(r.action, 'deal_claimed_by_payee');
    assert.equal(rail.refunds.length, 0);
    assert.doesNotMatch(venue.posts.at(-1).text, /paper rail/);
  });
});

describe('FlopRailClient', () => {
  const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

  test('returns the ref and the verify verdict', async () => {
    assert.equal(await new FlopRailClient({ fetchImpl: reply(200, { ref: 'flop1.x' }) }).lock({}), 'flop1.x');
    assert.equal(await new FlopRailClient({ fetchImpl: reply(200, { ok: true }) }).verifyLock({}, 'r'), true);
    assert.equal(await new FlopRailClient({ fetchImpl: reply(200, {}) }).verifyLock({}, 'r'), false);
  });

  test('carries status, uncertain and waiting from the service', async () => {
    await assert.rejects(new FlopRailClient({ fetchImpl: reply(403, { error: 'cap' }) }).lock({}), (e) => e.status === 403 && !e.uncertain);
    await assert.rejects(new FlopRailClient({ fetchImpl: reply(409, { error: 'w', waiting: true }) }).refund('r'), (e) => e.waiting);
  });

  test('a lost answer to a lock is uncertain; to anything else it is not', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(new FlopRailClient({ fetchImpl: boom }).lock({}), (e) => e.uncertain === true);
    await assert.rejects(new FlopRailClient({ fetchImpl: boom }).refund('r'), (e) => !e.uncertain);
  });
});
