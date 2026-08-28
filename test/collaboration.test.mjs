import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity } from '../src/identity.mjs';
import {
  signExchange, verifyExchange, emptyRecord, addExchange, summariseRecord,
  pairKey, hashContent, recordExchange, readRecord, COLLAB_NS, MAX_NOTE_CHARS
} from '../src/collaboration.mjs';

const scout = generateIdentity();
const scribe = generateIdentity();
const stranger = generateIdentity();

const sync = (seq = 1, content = 'Sentinel active | events seq #33810 | faucet radar: clear') => ({
  fromDid: scribe.did,
  toDid: scout.did,
  room: 'mb-p-scout-852d0b660964458e',
  seq,
  content
});

describe('A collaboration record a stranger can check', () => {
  test('an acknowledgement verifies against the key that made it', () => {
    const exchange = signExchange(sync(), scout);
    const verdict = verifyExchange(exchange, { pair: [scout.did, scribe.did] });
    assert.equal(verdict.ok, true, verdict.reason || '');
    assert.equal(exchange.ackBy, scout.did);
  });

  /**
   * Every field that gives the exchange its meaning is inside the signature.
   * Notes on this service are world-writable, so an unsigned field is a field
   * anyone can rewrite.
   */
  test('changing any signed field breaks the signature', () => {
    const base = signExchange(sync(7), scout);
    const pair = [scout.did, scribe.did];

    for (const [field, value] of [
      ['seq', 99],
      ['contentHash', hashContent('a different message entirely')],
      ['roomHash', hashContent('mb-p-someone-else')],
      ['at', '2020-01-01T00:00:00.000Z'],
      ['fromDid', stranger.did]
    ]) {
      const tampered = { ...base, [field]: value };
      const verdict = verifyExchange(tampered, { pair });
      assert.equal(verdict.ok, false, `${field} was not covered by the signature`);
    }
  });

  test('a key outside the pair cannot acknowledge into the record', () => {
    const outsider = signExchange(sync(3), stranger);
    const verdict = verifyExchange(outsider, { pair: [scout.did, scribe.did] });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'acknowledged by a key outside the pair');
  });

  /**
   * The point of the whole record. One agent producing many signatures is one
   * agent, and a summary that called that "collaboration" would be the kind of
   * number this project exists to argue against.
   */
  test('one key signing everything is reported as not mutual', () => {
    let record = emptyRecord(scout.did, scribe.did);
    for (let i = 1; i <= 4; i++) record = addExchange(record, signExchange(sync(i), scout));

    const summary = summariseRecord(record);
    assert.equal(summary.verified, 4);
    assert.equal(summary.distinctAcknowledgers, 1);
    assert.equal(summary.mutual, false, 'four signatures from one key is not two agents');
  });

  test('both keys acknowledging is reported as mutual', () => {
    let record = emptyRecord(scout.did, scribe.did);
    record = addExchange(record, signExchange(sync(1), scout));
    record = addExchange(record, signExchange({
      fromDid: scout.did, toDid: scribe.did, room: 'mb-p-scribe-x', seq: 2, content: 'ack'
    }, scribe));

    const summary = summariseRecord(record);
    assert.equal(summary.mutual, true);
    assert.equal(summary.distinctAcknowledgers, 2);
    assert.equal(summary.rejected, 0);
  });

  /**
   * A room name IS the capability on this service — `mb-` only requires that a
   * write be signed, which any spammer with a key can do. Publishing the mailbox
   * to prove we use it would have given it away.
   */
  test('the private mailbox name never reaches the record', () => {
    const exchange = signExchange(sync(5), scout);
    const record = addExchange(emptyRecord(scout.did, scribe.did), exchange);
    const serialised = JSON.stringify(record);

    assert.equal(serialised.includes('mb-p-scout-852d0b660964458e'), false, 'the mailbox name leaked');
    assert.equal(exchange.roomHash, hashContent('mb-p-scout-852d0b660964458e'));
    assert.equal(exchange.room, undefined);
  });

  test('both agents derive the same note key, whichever order they hold the pair in', () => {
    assert.equal(pairKey(scout.did, scribe.did), pairKey(scribe.did, scout.did));
    assert.match(pairKey(scout.did, scribe.did), /^pair-[0-9a-f]{24}$/);
  });
});

/**
 * State persistence in this project has already failed outright by growing past
 * the 8192-character note limit while every write returned 400 and the logs
 * scrolled past it. This record is capped by count AND measured.
 */
describe('The record stays inside the note limit', () => {
  test('the ring is bounded however many exchanges arrive', () => {
    let record = emptyRecord(scout.did, scribe.did);
    for (let i = 1; i <= 200; i++) record = addExchange(record, signExchange(sync(i), scout));

    assert.ok(record.exchanges.length <= 12, `kept ${record.exchanges.length}`);
    assert.ok(JSON.stringify(record).length < MAX_NOTE_CHARS,
      `record is ${JSON.stringify(record).length} characters`);
  });

  test('lifetime totals survive a trim, because they are the claim', () => {
    let record = emptyRecord(scout.did, scribe.did);
    for (let i = 1; i <= 50; i++) record = addExchange(record, signExchange(sync(i), scout));

    const direction = `${scribe.did} -> ${scout.did}`;
    assert.equal(record.totals[direction], 50, 'the count is not limited by the ring');
    assert.ok(record.exchanges.length < 50, 'but only a sample is re-verifiable');
  });

  test('an oversized entry still cannot push the note past the limit', () => {
    let record = emptyRecord(scout.did, scribe.did);
    const huge = 'x'.repeat(4000);
    for (let i = 1; i <= 6; i++) record = addExchange(record, signExchange(sync(i, huge), scout));
    assert.ok(JSON.stringify(record).length < MAX_NOTE_CHARS);
  });
});

describe('Writing the record', () => {
  const stubClient = ({ note = null, onWrite = () => {}, readStatus = 'ok' } = {}) => ({
    stored: note,
    async readNote() {
      if (readStatus === 'unreachable') return { reachable: false, found: null, value: null, error: 'HTTP 503' };
      if (this.stored === null) return { reachable: true, found: false, value: null, error: null };
      return { reachable: true, found: true, value: this.stored, error: null };
    },
    async setKv(ns, key, value, opts) {
      onWrite({ ns, key, value, opts });
      this.stored = value;
    }
  });

  test('a first write is conditional on absence, not on a value', async () => {
    let seen = null;
    const client = stubClient({ onWrite: (w) => { seen = w; } });
    const result = await recordExchange(client, { didA: scout.did, didB: scribe.did, exchange: signExchange(sync(), scout) });

    assert.equal(result.recorded, true);
    assert.equal(seen.ns, COLLAB_NS);
    assert.equal(seen.opts.ifAbsent, true, 'a create must not clobber a note that appeared meanwhile');
    assert.equal(result.summary.verified, 1);
  });

  test('a later write is conditional on exactly what was read', async () => {
    let last = null;
    const client = stubClient({ onWrite: (w) => { last = w; } });
    await recordExchange(client, { didA: scout.did, didB: scribe.did, exchange: signExchange(sync(1), scout) });
    const before = client.stored;
    await recordExchange(client, { didA: scout.did, didB: scribe.did, exchange: signExchange(sync(2), scout) });

    assert.equal(last.opts.ifValue, before, 'the write rebases on what is actually there');
    assert.equal(JSON.parse(client.stored).exchanges.length, 2);
  });

  /**
   * The lease learned this the hard way: a 503 read as "nothing is there" turns
   * an outage into a story about a record that was never written.
   */
  test('an unreachable server is transient, not a refusal', async () => {
    const client = stubClient({ readStatus: 'unreachable' });
    const result = await recordExchange(client, { didA: scout.did, didB: scribe.did, exchange: signExchange(sync(), scout) });

    assert.equal(result.recorded, false);
    assert.equal(result.transient, true);
    assert.match(result.reason, /503/);
  });

  test('a corrupt note is re-founded rather than silently trusted', async () => {
    const client = stubClient({ note: 'this is not json' });
    const read = await readRecord(client, scout.did, scribe.did);

    assert.equal(read.reachable, true);
    assert.match(read.error, /unparseable/);
    assert.deepEqual(read.record.exchanges, [], 'a fresh record, and the loss is reported');
  });
});

/**
 * The end the whole mechanism exists for. Before this, the Scribe pinged and the
 * Scout stayed silent, so the record could only ever carry one acknowledging key
 * — which is one agent, not two working together.
 */
describe('The handshake closes', () => {
  test('both halves of an exchange make the record mutual', async () => {
    const scoutId = generateIdentity();
    const scribeId = generateIdentity();

    let stored = null;
    const client = {
      async readNote() {
        return stored === null
          ? { reachable: true, found: false, value: null, error: null }
          : { reachable: true, found: true, value: stored, error: null };
      },
      async setKv(ns, key, value) { stored = value; }
    };

    // Scribe pings the Scout's mailbox; the Scout signs what it received.
    const scoutAck = signExchange({
      fromDid: scribeId.did, toDid: scoutId.did,
      room: 'mb-p-scout-aaa', seq: 11, content: 'Sentinel active | events seq #33810'
    }, scoutId);
    const first = await recordExchange(client, { didA: scoutId.did, didB: scribeId.did, exchange: scoutAck });
    assert.equal(first.recorded, true);
    assert.equal(first.summary.mutual, false, 'one key signing is not yet collaboration');

    // The Scout replies into the Scribe's mailbox; the Scribe signs that.
    const scribeAck = signExchange({
      fromDid: scoutId.did, toDid: scribeId.did,
      room: 'mb-p-scribe-bbb', seq: 12, content: 'received your sync at seq #11'
    }, scribeId);
    const second = await recordExchange(client, { didA: scribeId.did, didB: scoutId.did, exchange: scribeAck });

    assert.equal(second.recorded, true);
    assert.equal(second.summary.mutual, true, 'both keys have now signed');
    assert.equal(second.summary.distinctAcknowledgers, 2);
    assert.equal(second.summary.rejected, 0);

    // Both directions are counted, and both halves still verify from the note.
    const record = JSON.parse(stored);
    assert.equal(Object.keys(record.totals).length, 2, 'one tally per direction');
    for (const exchange of record.exchanges) {
      assert.equal(verifyExchange(exchange, { pair: record.pair }).ok, true);
    }
  });

  test('both agents write to the same note whichever of them goes first', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    // The Scout passes (self, peer); the Scribe passes (self, peer) — reversed.
    assert.equal(pairKey(a.did, b.did), pairKey(b.did, a.did));
  });
});
