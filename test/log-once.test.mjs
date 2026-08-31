import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { sayOnce, clearOnce, resetLogOnce } from '../src/log-once.mjs';

/**
 * The log has to stay readable while something is broken for hours.
 *
 * Technocore refused writes all day on 2026-08-31 and the daemon printed the
 * same five lines a minute — about three hundred an hour, all true, all the
 * same fact. The operator was looking at an agent completing twenty inference
 * sessions per cycle and could not see it under the repetition.
 */
describe('saying a recurring thing once', () => {
  const collect = () => {
    const lines = [];
    return { lines, out: (m) => lines.push(m) };
  };

  test('the first occurrence is printed, because a new failure is news', () => {
    resetLogOnce();
    const { lines, out } = collect();
    sayOnce('k', 'server refused the write', { out });
    assert.deepEqual(lines, ['server refused the write']);
  });

  test('repeats are counted, not printed', () => {
    resetLogOnce();
    const { lines, out } = collect();
    for (let i = 0; i < 50; i++) sayOnce('k', 'server refused the write', { out });
    assert.equal(lines.length, 1, '50 identical failures, one line');
  });

  test('a long-running problem reports its own count on a timer', () => {
    resetLogOnce();
    const { lines, out } = collect();
    let clock = 0;
    const now = () => clock;

    sayOnce('k', 'refused', { out, now, summaryMs: 1000 });
    for (let i = 0; i < 9; i++) sayOnce('k', 'refused', { out, now, summaryMs: 1000 });
    clock = 1000;
    sayOnce('k', 'refused', { out, now, summaryMs: 1000 });

    assert.equal(lines.length, 2);
    assert.match(lines[1], /still happening/);
    assert.match(lines[1], /10 times/);
  });

  test('different text is a different fact and is never suppressed', () => {
    resetLogOnce();
    const { lines, out } = collect();
    sayOnce('k', 'HTTP 503', { out });
    sayOnce('k', 'HTTP 503', { out });
    sayOnce('k', 'HTTP 400 text too long', { out });

    assert.equal(lines.length, 3, 'the new failure printed at once');
    assert.match(lines[1], /and 1 more like it/, 'and the old one reported its tail');
    assert.equal(lines[2], 'HTTP 400 text too long');
  });

  test('recovery is announced, because silence looks like death', () => {
    resetLogOnce();
    const { lines, out } = collect();
    let clock = 0;
    const now = () => clock;

    sayOnce('scout:state-write', '[Scout] write failed: 503', { out, now });
    for (let i = 0; i < 30; i++) sayOnce('scout:state-write', '[Scout] write failed: 503', { out, now });
    clock = 6 * 60_000;

    const said = clearOnce('scout:state-write', { now, out });
    assert.equal(said, true);
    assert.match(lines[lines.length - 1], /recovered after 30 more failure/);
  });

  test('clearing something that never failed says nothing', () => {
    resetLogOnce();
    const { lines, out } = collect();
    assert.equal(clearOnce('never-failed', { out }), false);
    assert.equal(lines.length, 0);
  });
});
