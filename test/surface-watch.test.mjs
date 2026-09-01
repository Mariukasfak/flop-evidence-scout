import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SURFACES, CAPABILITY_SIGNALS, digestOf, whatChanged, signalsIn, checkOneSurface
} from '../src/surface-watch.mjs';

/** A fetch that serves whatever text you hand it, or fails the way this origin does. */
const serving = (text) => async () => ({ ok: true, status: 200, async text() { return text; } });
const failing = (status = 503) => async () => ({ ok: false, status, async text() { return ''; } });

describe('Surface watch', () => {
  test('only ever reads paths the manual says are never rate limited', () => {
    // The same manual asks nobody to probe for unpublished routes, and a route
    // cannot ship without appearing in openapi.json, so guessing buys nothing.
    const neverRateLimited = [
      '/', '/llms.txt', '/skill.md', '/patterns.md', '/interop.md', '/auth.md',
      '/openapi.json', '/config', '/healthz'
    ];
    for (const surface of SURFACES) {
      const published = neverRateLimited.includes(surface) || surface.startsWith('/.well-known/');
      assert.equal(published, true, `${surface} is not on the published, unthrottled list`);
    }
  });

  test('a first sight is a baseline, not a change', async () => {
    const result = await checkOneSurface({ fetchFn: serving('hello'), state: {}, index: 1 });
    assert.equal(result.action, 'baseline');
    assert.equal(result.state[result.surface].digest, digestOf('hello'));
  });

  test('the same bytes twice is unchanged', async () => {
    const first = await checkOneSurface({ fetchFn: serving('hello'), state: {}, index: 1 });
    const second = await checkOneSurface({ fetchFn: serving('hello'), state: first.state, index: 1 });
    assert.equal(second.action, 'unchanged');
  });

  test('a failed fetch is a failure and never "unchanged"', async () => {
    // The point of the whole file. This origin served 503s for a third of our
    // requests on the day it was written, and a watcher that reports silence as
    // stability is worse than no watcher: it is a watcher you believe.
    const first = await checkOneSurface({ fetchFn: serving('hello'), state: {}, index: 1 });
    const blind = await checkOneSurface({ fetchFn: failing(503), state: first.state, index: 1 });

    assert.equal(blind.action, 'check_failed');
    assert.match(blind.error, /503/);
    assert.equal(blind.consecutiveFailures, 1);

    const again = await checkOneSurface({ fetchFn: failing(503), state: blind.state, index: 1 });
    assert.equal(again.consecutiveFailures, 2, 'a surface blind twice running says so');
    // And the last body we did read is not thrown away by a failure.
    assert.equal(blind.state[blind.surface].digest, digestOf('hello'));
  });

  test('an edit that names a capability is louder than one that does not', async () => {
    const before = 'READ GET /r/<room> last 50 messages\nLIMITS: two token buckets per client IP';
    const cosmetic = 'READ GET /r/<room>   last 50 messages\nLIMITS: two token buckets per client IP';
    const real = before + '\nFAUCET GET /faucet/<did> claim testnet tokens for inference spend';

    const baseline = await checkOneSurface({ fetchFn: serving(before), state: {}, index: 1 });

    // Rewrapped whitespace is not a new line, so this must not cry wolf.
    const reflowed = await checkOneSurface({ fetchFn: serving(cosmetic), state: baseline.state, index: 1 });
    assert.equal(reflowed.action, 'unchanged', 'collapsing whitespace is not a change');

    const shipped = await checkOneSurface({ fetchFn: serving(real), state: baseline.state, index: 1 });
    assert.equal(shipped.action, 'capability_signal');
    assert.equal(shipped.signals.length, 1);
    assert.match(shipped.signals[0], /FAUCET/);
  });

  test('a real edit with nothing named is reported, quietly', async () => {
    const before = 'CAPACITY: at most 81920 rooms';
    const after = 'CAPACITY: at most 99999 rooms';
    const baseline = await checkOneSurface({ fetchFn: serving(before), state: {}, index: 1 });
    const changed = await checkOneSurface({ fetchFn: serving(after), state: baseline.state, index: 1 });

    assert.equal(changed.action, 'changed');
    assert.deepEqual(changed.signals, [], 'a real edit naming nothing carries no signals');
    assert.deepEqual(changed.added, ['CAPACITY: at most 99999 rooms']);
    assert.deepEqual(changed.removed, ['CAPACITY: at most 81920 rooms']);
  });

  test('the signal words are bounded, because the sibling watcher learned that the hard way', () => {
    // `mission` once matched `room-permissions` in tools/watch-sources.mjs.
    for (const innocent of ['multitasking improves throughput', 'reclaimed disk space', 'a requested room']) {
      assert.equal(CAPABILITY_SIGNALS.test(innocent), false, `false positive on: ${innocent}`);
    }
    for (const real of ['claim a faucet drip', 'prove the task is complete', 'inference spend counts']) {
      assert.equal(CAPABILITY_SIGNALS.test(real), true, `missed: ${real}`);
    }
  });

  test('the rotation covers every surface and repeats in order', async () => {
    const seen = [];
    let state = {};
    for (let i = 0; i < SURFACES.length * 2; i += 1) {
      const result = await checkOneSurface({ fetchFn: serving('x'), state, index: i });
      state = result.state;
      seen.push(result.surface);
    }
    assert.deepEqual(seen.slice(0, SURFACES.length), SURFACES);
    assert.deepEqual(seen.slice(SURFACES.length), SURFACES, 'the second pass repeats the first');
  });

  test('whatChanged reports both sides of an edit', () => {
    const { added, removed } = whatChanged('one\ntwo\nthree', 'one\ntwo point five\nthree');
    assert.deepEqual(added, ['two point five']);
    assert.deepEqual(removed, ['two']);
    assert.deepEqual(signalsIn(added), []);
  });
});
