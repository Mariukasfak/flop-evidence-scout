import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emptyReputation, loadReputation, saveReputation, recordOutcome,
  isBurned, isTrusted, offerLooksAlive, DEAD_PROTOS, SEEN_LIMIT
} from '../src/tclk-reputation.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tclk-rep-'));
const rep = (payers) => ({ updatedAt: null, payers });

describe('who is worth a deal slot', () => {
  test('a payer who tried and never finished is burned', () => {
    assert.equal(isBurned(rep({ a: { tried: 3, done: 0 } }), 'a'), true);
  });

  test('a payer nobody has seen is not burned — an unknown payer is the second-best signal', () => {
    assert.equal(isBurned(rep({}), 'stranger'), false);
    assert.equal(isTrusted(rep({}), 'stranger'), false);
  });

  test('one finished deal clears a payer, however many they abandoned around it', () => {
    const r = rep({ a: { tried: 9, done: 1 } });
    assert.equal(isBurned(r, 'a'), false);
    assert.equal(isTrusted(r, 'a'), true);
  });

  test('an outcome is counted whichever way it went', () => {
    let r = emptyReputation();
    r = recordOutcome(r, 'a', false);
    assert.deepEqual(r.payers.a, { tried: 1, done: 0 });
    assert.equal(isBurned(r, 'a'), true);
    r = recordOutcome(r, 'a', true);
    assert.deepEqual(r.payers.a, { tried: 2, done: 1 });
    assert.equal(isBurned(r, 'a'), false, 'a payer who finally finishes is not burned');
  });

  test('an outcome without a payer changes nothing', () => {
    const r = emptyReputation();
    assert.deepEqual(recordOutcome(r, null, true), r);
  });
});

describe('counting the same deal twice', () => {
  const C = '0x' + 'ab'.repeat(32);

  test('a contract already counted does not move the numbers again', () => {
    let r = recordOutcome(emptyReputation(), 'payer', false, C);
    assert.deepEqual(r.payers.payer, { tried: 1, done: 0 });
    const again = recordOutcome(r, 'payer', false, C);
    assert.equal(again, r, 'the same object comes back, so a caller can see nothing happened');
    assert.deepEqual(again.payers.payer, { tried: 1, done: 0 });
  });

  test('a different contract from the same payer does count', () => {
    let r = recordOutcome(emptyReputation(), 'payer', false, C);
    r = recordOutcome(r, 'payer', true, '0x' + 'cd'.repeat(32));
    assert.deepEqual(r.payers.payer, { tried: 2, done: 1 });
  });

  test('without a contract it still counts, because old callers and tests pass none', () => {
    let r = recordOutcome(emptyReputation(), 'payer', false);
    r = recordOutcome(r, 'payer', false);
    assert.deepEqual(r.payers.payer, { tried: 2, done: 0 });
  });

  test('the seen list is bounded, oldest dropped first', () => {
    let r = emptyReputation();
    for (let i = 0; i < SEEN_LIMIT + 5; i++) r = recordOutcome(r, 'p', false, 'c' + i);
    assert.equal(r.seen.length, SEEN_LIMIT);
    assert.equal(r.seen.includes('c0'), false, 'the oldest fell off');
    assert.equal(r.seen.includes('c' + (SEEN_LIMIT + 4)), true, 'the newest is kept');
  });

  test('a file written before seen existed loads as having seen nothing', () => {
    const file = path.join(tmp(), 'old.json');
    fs.writeFileSync(file, JSON.stringify({ updatedAt: null, payers: { a: { tried: 3, done: 1 } } }));
    const r = loadReputation(file);
    assert.deepEqual(r.seen, []);
    assert.deepEqual(r.payers.a, { tried: 3, done: 1 }, 'and the payers it did hold survive');
  });

  test('seen survives a round trip, so a scan does not recount after a restart', () => {
    const file = path.join(tmp(), 'rt.json');
    saveReputation(recordOutcome(emptyReputation(), 'p', true, C), file);
    const back = loadReputation(file);
    assert.equal(recordOutcome(back, 'p', true, C), back, 'still deduplicated');
  });
});

describe('the reputation file', () => {
  test('survives a round trip', () => {
    const file = path.join(tmp(), 'payers.json');
    const written = recordOutcome(emptyReputation(), 'a', true);
    saveReputation(written, file);
    const read = loadReputation(file);
    assert.deepEqual(read.payers, written.payers);
    assert.equal(typeof read.updatedAt, 'string');
  });

  test('a missing file is an empty reputation, not a crash — the lane runs on day one', () => {
    assert.deepEqual(loadReputation(path.join(tmp(), 'nope.json')), emptyReputation());
    assert.deepEqual(loadReputation(null), emptyReputation());
  });

  test('a corrupt file is an empty reputation, never a half-trusted one', () => {
    const file = path.join(tmp(), 'bad.json');
    fs.writeFileSync(file, '{ not json at all');
    assert.deepEqual(loadReputation(file), emptyReputation());
    fs.writeFileSync(file, JSON.stringify({ payers: 'nonsense' }));
    assert.deepEqual(loadReputation(file), emptyReputation());
  });

  test('saving into a directory that does not exist yet works', () => {
    const file = path.join(tmp(), 'deep', 'deeper', 'payers.json');
    saveReputation(recordOutcome(emptyReputation(), 'a', true), file);
    assert.equal(loadReputation(file).payers.a.done, 1);
  });
});

describe('offer shapes that have never settled', () => {
  const offer = (job) => ({ amount: '1000000', job });

  test('a protocol with a real sample and no claims ever is refused', () => {
    for (const proto of DEAD_PROTOS) {
      assert.equal(offerLooksAlive(offer({ proto, id: 'x' })), false, proto);
    }
  });

  test('an offer naming no protocol at all is refused — 98 of them, none claimed', () => {
    assert.equal(offerLooksAlive(offer(undefined)), false);
    assert.equal(offerLooksAlive(offer({ id: 'x' })), false);
    assert.equal(offerLooksAlive({}), false);
  });

  test('the protocols that do settle are kept', () => {
    assert.equal(offerLooksAlive(offer({ proto: 'a2a', id: 'x' })), true);
    assert.equal(offerLooksAlive(offer({ proto: 'echo', id: 'x' })), true);
  });

  test('the amount is not judged: the dead band was a proxy for one spammer', () => {
    assert.equal(offerLooksAlive({ amount: '250', job: { proto: 'a2a', id: 'x' } }), true);
    assert.equal(offerLooksAlive({ amount: '5000', job: { proto: 'a2a', id: 'x' } }), true);
  });
});
