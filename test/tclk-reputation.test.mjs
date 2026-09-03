import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emptyReputation, loadReputation, saveReputation, recordOutcome,
  isBurned, isTrusted, offerLooksAlive, DEAD_PROTOS
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
