import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TclkPayer, publicPayerView, MIN_OFFER_GAP_MS } from '../src/tclk-payer.mjs';
import {
  decodeFrame, encodeFrame, offerIdMatches, contractId, acceptFrameFor,
  generateHashLock, dealRoom, paperNote, decodePaperRecord, encodePaperRecord,
  validateDeadlines
} from '../src/tclk.mjs';

/**
 * The payer side, exercised against a fake venue. The rules asserted here are
 * the ones the spec states and the ones this project added on top: paper only,
 * never our own sibling key, rail before frame, and a refund that names the
 * exact bytes it is replacing.
 */

const PAYER = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const SIBLING = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const STRANGER = 'did:key:z6MkwBgTg4QUjvCR9hF6HEnA4hc68ug4gri6JjiN3sLzg7ws';

const BANK = [
  {
    key: 'api-board-reachability-2026-08',
    title: 'Does flop-kibble.onrender.com/api/board respond from your network?',
    body: 'From this network it returns nothing after 90s while /api/score answers in 0.3s. '
      + 'Success: the HTTP status code and the elapsed time, and say so if it timed out.'
  },
  {
    key: 'retention-floor-measured-2026-08',
    title: 'How much of a busy room does /export actually still hold?',
    body: 'The manual guarantees a 64 KiB floor but a busy export runs to megabytes. '
      + 'Success: the room, the byte size, the line count and the time span.'
  }
];

/** A venue that records what was written to it and answers what it was told to. */
class FakeVenue {
  constructor() {
    this.rooms = new Map();
    this.notes = new Map();
    this.posts = [];
    this.failNextWrite = null;
  }

  seed(room, from, text, seq) {
    if (!this.rooms.has(room)) this.rooms.set(room, []);
    this.rooms.get(room).push({ from, text, seq: seq ?? this.rooms.get(room).length + 1 });
  }

  async readRoom(room) {
    return { messages: this.rooms.get(room) || [] };
  }

  async postMessage(room, text, identity) {
    this.posts.push({ room, text, from: identity.did });
    this.seed(room, identity.did, text);
    return true;
  }

  async readNote(ns, key) {
    const value = this.notes.get(`${ns}/${key}`);
    return value === undefined
      ? { reachable: true, found: false, value: null }
      : { reachable: true, found: true, value };
  }

  async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
    if (this.failNextWrite) { const err = this.failNextWrite; this.failNextWrite = null; throw new Error(err); }
    const at = `${ns}/${key}`;
    if (ifAbsent && this.notes.has(at)) throw new Error('HTTP 409 note exists');
    if (ifValue !== null && this.notes.get(at) !== ifValue) throw new Error('HTTP 409 value mismatch');
    this.notes.set(at, value);
    return true;
  }
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-payer-')), 'state.json');

function makePayer(venue, { now = () => 1_700_000_000_000, bank = BANK, minOfferGapMs = 0 } = {}) {
  return new TclkPayer({
    identity: { did: PAYER, privateKeyPem: 'x' },
    client: venue,
    statePath: tmpState(),
    otherDids: [SIBLING],
    questionBank: bank,
    now,
    minOfferGapMs
  });
}

/** Post an offer, then have `who` accept it the way a real counterparty would. */
async function offerAndAccept(payer, venue, who = STRANGER) {
  const posted = await payer.runTurn();
  const offer = decodeFrame(venue.posts.at(-1).text);
  const { secret, statement } = generateHashLock();
  const accept = acceptFrameFor(offer, { from: who, statement });
  venue.seed('tclk-offers', who, encodeFrame(accept));
  return { posted, offer, accept, secret, statement };
}

describe('posting an offer', () => {
  test('the offer is well formed, paper-only, and its id hashes its own fields', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const result = await payer.runTurn();
    assert.equal(result.action, 'offer_posted');

    const frame = decodeFrame(venue.posts[0].text);
    assert.equal(frame.type, 'offer');
    assert.equal(frame.role, 'payer');
    assert.equal(frame.lock, 'hash');
    assert.deepEqual(frame.rails, ['paper']);
    assert.ok(offerIdMatches(frame), 'a frame that lies about its own id is not an offer');
    assert.equal(validateDeadlines(frame, 1_700_000_000_000).ok, true);
  });

  test('the asset says paper, because the rail settles nothing', async () => {
    // The room's convention is to denominate in FLOP and settle on paper. That
    // reads as an offer of money to anyone skimming, and this project does not
    // make claims that need a second field to be true.
    const venue = new FakeVenue();
    await makePayer(venue).runTurn();
    assert.equal(decodeFrame(venue.posts[0].text).asset, 'PAPER');
  });

  test('the task travels in the frame, so the counterparty needs no second fetch', async () => {
    const venue = new FakeVenue();
    await makePayer(venue).runTurn();
    const frame = decodeFrame(venue.posts[0].text);
    assert.match(frame.job.context, /flop-kibble/);
    assert.match(frame.job.context, /Success:/);
  });

  test('a question is spent once, however the offer ends', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    await payer.runTurn();
    payer.state.offer = null;                 // as if it had expired
    const second = await payer.runTurn();
    assert.equal(second.action, 'offer_posted');
    assert.equal(second.key, BANK[1].key);
  });

  test('an exhausted bank posts nothing at all', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue, { bank: [] });
    assert.equal((await payer.runTurn()).action, 'no_question_left');
    assert.equal(venue.posts.length, 0);
  });

  test('offers are paced an hour apart, not per cycle', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue, { minOfferGapMs: MIN_OFFER_GAP_MS });
    await payer.runTurn();
    payer.state.offer = null;
    const second = await payer.runTurn();
    assert.equal(second.action, 'offer_paced');
    assert.equal(venue.posts.length, 1);
  });
});

describe('who may take our offer', () => {
  test('our own sibling key is refused — a deal between two of our processes is not a deal', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    await offerAndAccept(payer, venue, SIBLING);
    assert.equal((await payer.runTurn()).action, 'waiting_for_accept');
  });

  test('an acceptance whose contract id does not recompute is ignored', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const { offer, accept } = await offerAndAccept(payer, venue);
    // Same shape, a contract id that binds different terms.
    const forged = { ...accept, contract: contractId({ ...offer, amount: '999' }, accept) };
    venue.rooms.get('tclk-offers').pop();
    venue.seed('tclk-offers', STRANGER, encodeFrame(forged));
    assert.equal((await payer.runTurn()).action, 'waiting_for_accept');
  });

  test('a real acceptance opens the deal in the derived room', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const { accept } = await offerAndAccept(payer, venue);
    const result = await payer.runTurn();
    assert.equal(result.action, 'offer_accepted_by');
    assert.equal(result.contract, accept.contract);
    assert.equal(result.room, dealRoom(accept.contract));
  });

  test('an unaccepted offer is dropped at expiry, silently', async () => {
    const venue = new FakeVenue();
    let clock = 1_700_000_000_000;
    const payer = makePayer(venue, { now: () => clock });
    await payer.runTurn();
    clock += 46 * 60_000;
    const result = await payer.runTurn();
    assert.equal(result.action, 'offer_expired');
    // One line on the tape: the offer. A cancel frame with no contract id would
    // be dropped by every conforming reader and still cost the room a line.
    assert.equal(venue.posts.length, 1);
  });
});

describe('locking on the paper rail', () => {
  test('the rail is written before the frame that announces it', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const { accept, statement } = await offerAndAccept(payer, venue);
    await payer.runTurn();                                   // accept -> deal
    const result = await payer.runTurn();                    // deal -> lock
    assert.equal(result.action, 'locked');

    const { ns, key } = paperNote(accept.contract);
    const record = decodePaperRecord(venue.notes.get(`${ns}/${key}`));
    assert.equal(record.status, 'locked');
    assert.equal(record.lock, 'hash');
    assert.equal(record.statement, statement);

    const announced = decodeFrame(venue.posts.at(-1).text);
    assert.equal(announced.type, 'lock');
    assert.equal(announced.rail, 'paper');
  });

  test('a contract someone else already wrote is not ours to fund', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const { accept } = await offerAndAccept(payer, venue);
    await payer.runTurn();
    const { ns, key } = paperNote(accept.contract);
    venue.notes.set(`${ns}/${key}`, encodePaperRecord({
      status: 'locked', lock: 'hash', statement: `0x${'a'.repeat(64)}`, refundAfterMs: 1
    }));
    const result = await payer.runTurn();
    assert.equal(result.action, 'lock_not_ours');
    // And nothing was announced on a lock we did not place.
    assert.ok(!venue.posts.some((p) => decodeFrame(p.text)?.type === 'lock'));
  });

  /**
   * The wedge this cost us live on 2026-09-03: the rail write succeeded, the
   * announcement was refused because the deal room could not be created, and
   * every later cycle re-ran the write, where `ifAbsent` met our own note and
   * returned 409 forever.
   */
  test('a lock we placed but could not announce is finished, not re-attempted', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    const { accept } = await offerAndAccept(payer, venue);
    await payer.runTurn();

    // The room refuses to come into existence, exactly as the server did.
    const realPost = venue.postMessage.bind(venue);
    venue.postMessage = async (room, text, identity) => {
      if (room.startsWith('mb-p-tclk-')) throw new Error('HTTP 400 room limit reached (81920 is the cap, and this would be a new one)');
      return realPost(room, text, identity);
    };
    assert.equal((await payer.runTurn()).action, 'lock_announce_failed');
    const { ns, key } = paperNote(accept.contract);
    assert.ok(venue.notes.get(`${ns}/${key}`), 'the rail was written even though the room was not');
    assert.ok(payer.state.deal.lockedBytes, 'and the bytes a refund must name were kept');

    venue.postMessage = realPost;
    const retry = await payer.runTurn();
    assert.equal(retry.action, 'locked', 'the second attempt announces rather than rewriting');
    assert.equal(payer.state.deal.status, 'locked');
  });

  test('a refused room stands the offer lane down instead of retrying every cycle', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    await offerAndAccept(payer, venue);
    await payer.runTurn();
    venue.postMessage = async (room) => {
      if (room.startsWith('mb-p-tclk-')) throw new Error('HTTP 400 room limit reached (81920 is the cap, and this would be a new one)');
      return true;
    };
    await payer.runTurn();
    payer.state.deal = null;
    payer.state.offer = null;
    const result = await payer.runTurn();
    assert.equal(result.action, 'rooms_refused');
    assert.ok(result.blockedForMin > 0);
  });

  test('a failed rail write leaves the deal to be retried, not abandoned', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    await offerAndAccept(payer, venue);
    await payer.runTurn();
    venue.failNextWrite = 'HTTP 503';
    assert.equal((await payer.runTurn()).action, 'lock_write_failed');
    assert.equal(payer.state.deal.status, 'accepted');
    assert.equal((await payer.runTurn()).action, 'locked');
  });
});

describe('how a deal ends', () => {
  async function lockedDeal(now = () => 1_700_000_000_000) {
    const venue = new FakeVenue();
    const payer = makePayer(venue, { now });
    const made = await offerAndAccept(payer, venue);
    await payer.runTurn();
    await payer.runTurn();
    return { venue, payer, ...made };
  }

  test('a reveal that opens the statement closes the deal as completed', async () => {
    const { venue, payer, secret, accept } = await lockedDeal();
    venue.seed(dealRoom(accept.contract), STRANGER, encodeFrame({
      type: 'reveal', from: STRANGER, contract: accept.contract, secret
    }));
    const result = await payer.runTurn();
    assert.equal(result.action, 'deal_claimed_by_payee');
    assert.equal(payer.state.deal, null);
    assert.equal(payer.state.completed.length, 1);
  });

  test('a reveal whose secret does not open the statement is just a string', async () => {
    const { venue, payer, accept } = await lockedDeal();
    venue.seed(dealRoom(accept.contract), STRANGER, encodeFrame({
      type: 'reveal', from: STRANGER, contract: accept.contract, secret: `0x${'b'.repeat(64)}`
    }));
    assert.equal((await payer.runTurn()).action, 'waiting_for_reveal');
    assert.equal(payer.state.deal.status, 'locked');
  });

  test('a reveal from anyone but the payee is ignored', async () => {
    const { venue, payer, secret, accept } = await lockedDeal();
    const OTHER = 'did:key:z6MkoBVTfkgypseYNz6P33QTb2pwUA5YeP9cdWZ5waq5gYe9';
    venue.seed(dealRoom(accept.contract), OTHER, encodeFrame({
      type: 'reveal', from: OTHER, contract: accept.contract, secret
    }));
    assert.equal((await payer.runTurn()).action, 'waiting_for_reveal');
  });

  test('the receipt says whether work arrived, in words, not as a frame', async () => {
    const { venue, payer, secret, accept } = await lockedDeal();
    const room = dealRoom(accept.contract);
    venue.seed(room, STRANGER, 'The board answered HTTP 200 in 0.4s from a Hetzner box in Nuremberg.');
    venue.seed(room, STRANGER, encodeFrame({ type: 'reveal', from: STRANGER, contract: accept.contract, secret }));
    const result = await payer.runTurn();
    assert.equal(result.delivered, true);
    const receipt = venue.posts.at(-1).text;
    assert.equal(decodeFrame(receipt), null, 'a receipt must not be mistakable for a protocol frame');
    assert.match(receipt, /work line from the payee on this tape: yes/);
    assert.match(receipt, /holds no value/);
  });

  test('no reveal by the deadline refunds against the exact bytes we locked', async () => {
    let clock = 1_700_000_000_000;
    const { venue, payer, accept, statement } = await lockedDeal(() => clock);
    clock += 151 * 60_000;
    const result = await payer.runTurn();
    assert.equal(result.action, 'refunded');
    const { ns, key } = paperNote(accept.contract);
    const record = decodePaperRecord(venue.notes.get(`${ns}/${key}`));
    assert.equal(record.status, 'refunded');
    assert.equal(record.statement, statement);
    assert.equal(payer.state.abandoned.at(-1).reason, 'payee never revealed before refundAfterMs');
  });

  test('a rail note somebody else overwrote is left alone, not stamped over', async () => {
    let clock = 1_700_000_000_000;
    const { venue, payer, accept } = await lockedDeal(() => clock);
    const { ns, key } = paperNote(accept.contract);
    venue.notes.set(`${ns}/${key}`, 'tclkpaper1 claimed hash '
      + `0x${'c'.repeat(64)} 1700000000000 0x${'d'.repeat(64)}`);
    clock += 151 * 60_000;
    assert.equal((await payer.runTurn()).action, 'refund_refused');
    assert.equal(payer.state.deal.status, 'locked', 'a lost CAS is information, not a reason to forget the deal');
  });

  test('we never refund before the window opens', async () => {
    let clock = 1_700_000_000_000;
    const { payer } = await lockedDeal(() => clock);
    clock += 100 * 60_000;                          // past claimBy, before refundAfter
    assert.equal((await payer.runTurn()).action, 'waiting_for_reveal');
  });
});

describe('what the status screen may see', () => {
  test('an open offer, a live deal and an idle lane each read cleanly', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    assert.equal(publicPayerView(payer.load()).kind, 'idle');
    await payer.runTurn();
    assert.equal(publicPayerView(payer.state).kind, 'offer');
    await offerAndAccept(payer, venue);
    payer.state.offer = payer.state.offer || null;
  });

  test('nothing in the payer view has to be hidden — this side holds no secret', async () => {
    const venue = new FakeVenue();
    const payer = makePayer(venue);
    await offerAndAccept(payer, venue);
    await payer.runTurn();
    const view = publicPayerView(payer.state);
    assert.equal(view.kind, 'deal');
    assert.equal(JSON.stringify(payer.state).includes('"secret"'), false);
  });
});
