import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PAIR_CAP, RECIPROCAL_CAP, loadPairs, savePairs, usefulBudgetLeft,
  cappedWorkers, recordUseful, markPraisedUs, pairSummary
} from '../src/kibble-pairs.mjs';

/**
 * The numbers in these tests are the ones that made the file necessary: on
 * 2026-09-03 this validator had posted 1,489 attestations and the board counted
 * 404, because 103 useful verdicts in one 2.8-hour window went to 14 workers.
 */

const A = 'did:key:z6MkWorkerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'did:key:z6MkWorkerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kibble-pairs-')), 'pairs.json');

describe('the attestor→worker budget', () => {
  test('a fresh worker is worth the full cap', () => {
    const book = loadPairs(tmpFile());
    assert.equal(usefulBudgetLeft(book, A), PAIR_CAP);
  });

  test('spends down to zero and never below', () => {
    const book = loadPairs(tmpFile());
    recordUseful(book, A);
    assert.equal(usefulBudgetLeft(book, A), PAIR_CAP - 1);
    recordUseful(book, A);
    assert.equal(usefulBudgetLeft(book, A), 0);
    recordUseful(book, A);
    recordUseful(book, A);
    assert.equal(usefulBudgetLeft(book, A), 0);
  });

  test('a worker who endorsed us is worth only one, not two', () => {
    // "if B already scored useful on A, A→B scores at most 1" — llms.txt.
    const book = loadPairs(tmpFile());
    markPraisedUs(book, B);
    assert.equal(usefulBudgetLeft(book, B), RECIPROCAL_CAP);
    recordUseful(book, B);
    assert.equal(usefulBudgetLeft(book, B), 0);
  });

  test('a reciprocal pair discovered after we already spent two stays at zero', () => {
    // The order these arrive in is the room's, not ours: their endorsement can
    // land after our second verdict. It must not resurrect a budget.
    const book = loadPairs(tmpFile());
    recordUseful(book, A);
    recordUseful(book, A);
    markPraisedUs(book, A);
    assert.equal(usefulBudgetLeft(book, A), 0);
  });

  test('cappedWorkers is exactly what the picker must skip', () => {
    const book = loadPairs(tmpFile());
    recordUseful(book, A);
    recordUseful(book, A);
    recordUseful(book, B);
    const capped = cappedWorkers(book);
    assert.ok(capped.has(A));
    assert.ok(!capped.has(B));
  });
});

describe('the two views of one DID', () => {
  /**
   * What made the budget a no-op in production on 2026-09-03: the book was
   * seeded from an export (full DIDs) while the running engine read the room as
   * text (abbreviated `z6Mk<head>…<tail>`), so a worker with 53 verdicts
   * against it looked untouched and collected 13 more in the next hour.
   */
  const bare = A.replace('did:key:', '');
  const ABBREV = `${bare.slice(0, 8)}…${bare.slice(-4)}`;

  test('a full DID and its abbreviation are one worker, not two', () => {
    const book = loadPairs(tmpFile());
    recordUseful(book, A);
    recordUseful(book, ABBREV);
    assert.equal(usefulBudgetLeft(book, A), 0);
    assert.equal(usefulBudgetLeft(book, ABBREV), 0);
    assert.equal(book.workers.size, 1, 'one worker, one entry');
  });

  test('cappedWorkers reaches a worker banked under the other form', () => {
    const book = loadPairs(tmpFile());
    recordUseful(book, ABBREV);
    recordUseful(book, ABBREV);
    assert.equal(usefulBudgetLeft(book, A), 0, 'the full DID is the same worker');
  });

  test('a legacy file holding both forms is merged on load, never loosened', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      workers: {
        [A]: { given: 53, praisedUs: false },
        [ABBREV]: { given: 2, praisedUs: true }
      }
    }), 'utf8');
    const book = loadPairs(file);
    assert.equal(book.workers.size, 1);
    assert.equal(usefulBudgetLeft(book, A), 0);
    // The larger count and the stricter flag both survive.
    const entry = [...book.workers.values()][0];
    assert.equal(entry.given, 53);
    assert.equal(entry.praisedUs, true);
  });

  test('two different workers are never merged', () => {
    const book = loadPairs(tmpFile());
    recordUseful(book, A);
    recordUseful(book, B);
    assert.equal(book.workers.size, 2);
    assert.equal(usefulBudgetLeft(book, A), PAIR_CAP - 1);
    assert.equal(usefulBudgetLeft(book, B), PAIR_CAP - 1);
  });
});

describe('surviving a restart', () => {
  test('counts round-trip through the file', () => {
    const file = tmpFile();
    const book = loadPairs(file);
    recordUseful(book, A);
    recordUseful(book, A);
    markPraisedUs(book, B);
    assert.equal(savePairs(book, file).saved, true);

    const reloaded = loadPairs(file);
    assert.equal(usefulBudgetLeft(reloaded, A), 0);
    assert.equal(usefulBudgetLeft(reloaded, B), RECIPROCAL_CAP);
    assert.deepEqual(pairSummary(reloaded), { workers: 2, capped: 1, reciprocal: 1 });
  });

  test('a corrupt book costs verdicts, never the cycle', () => {
    // The daemon restarts often and this file is a cache, not evidence. An
    // unreadable one must come back empty rather than throw.
    const file = tmpFile();
    fs.writeFileSync(file, '{"workers": not json at all', 'utf8');
    const book = loadPairs(file);
    assert.equal(book.workers.size, 0);
    assert.equal(usefulBudgetLeft(book, A), PAIR_CAP);
  });

  test('a missing file is simply an empty book', () => {
    const book = loadPairs(path.join(os.tmpdir(), 'kibble-pairs-does-not-exist', 'x.json'));
    assert.equal(book.workers.size, 0);
  });

  test('garbage entries are dropped, good ones beside them survive', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      workers: { [A]: { given: 2, praisedUs: false }, [B]: 'not an object' }
    }), 'utf8');
    const book = loadPairs(file);
    assert.equal(usefulBudgetLeft(book, A), 0);
    assert.equal(usefulBudgetLeft(book, B), PAIR_CAP);
  });

  test('a negative or absurd count cannot hand out a bigger budget', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      workers: { [A]: { given: -5, praisedUs: false } }
    }), 'utf8');
    assert.equal(usefulBudgetLeft(loadPairs(file), A), PAIR_CAP);
  });

  test('the book is bounded, and the oldest entries are the ones that go', () => {
    const file = tmpFile();
    const book = loadPairs(file);
    for (let i = 0; i < 12; i += 1) recordUseful(book, `did:key:z6Mk${String(i).padStart(44, '0')}`);
    savePairs(book, file, { cap: 5 });
    const reloaded = loadPairs(file, { cap: 5 });
    assert.equal(reloaded.workers.size, 5);
    assert.ok(reloaded.workers.has(`did:key:z6Mk${String(11).padStart(44, '0')}`));
    assert.ok(!reloaded.workers.has(`did:key:z6Mk${String(0).padStart(44, '0')}`));
  });
});
