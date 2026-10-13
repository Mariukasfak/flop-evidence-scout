import test from 'node:test';
import assert from 'node:assert/strict';

import { snapshotOf, measureRates, liveQuestions, liveBriefs, pruneKeys } from '../src/kibble-live.mjs';

const T0 = Date.parse('2026-10-13T07:00:00Z');
const rows = (seqs) => Object.entries(seqs).map(([room, last_seq]) => ({ room, last_seq }));

test('rates come from two reads, and private or scam-shaped rooms are left out', () => {
  const a = snapshotOf(rows({ lobby: 1000, 'p-secret': 5, 'mb-p-x': 5, 'claim-now': 10, kibble: 50 }), T0);
  const b = snapshotOf(rows({ lobby: 3000, 'p-secret': 900, 'mb-p-x': 900, 'claim-now': 9999, kibble: 150 }), T0 + 5 * 60_000);
  const r = measureRates(a, b);
  assert.deepEqual(r.rooms.map((x) => [x.room, x.perMin]), [['lobby', 400], ['kibble', 20]]);
  assert.equal(r.minutes, 5);
});

test('a window too short or too stale is not a measurement', () => {
  const a = snapshotOf(rows({ lobby: 1 }), T0);
  assert.equal(measureRates(a, snapshotOf(rows({ lobby: 9 }), T0 + 60_000)), null);
  assert.equal(measureRates(a, snapshotOf(rows({ lobby: 9 }), T0 + 60 * 60_000)), null);
});

test('a recreated room, whose seq went backwards, gets no rate', () => {
  const r = measureRates(snapshotOf(rows({ lobby: 99, kibble: 1 }), T0), snapshotOf(rows({ lobby: 5, kibble: 21 }), T0 + 5 * 60_000));
  assert.deepEqual(r.rooms.map((x) => x.room), ['kibble']);
});

test('questions and briefs are keyed by room and hour, with unique titles and a success bar', () => {
  const r = measureRates(snapshotOf(rows({ lobby: 0, kibble: 0 }), T0), snapshotOf(rows({ lobby: 500, kibble: 50 }), T0 + 5 * 60_000));
  const qs = liveQuestions(r);
  assert.deepEqual(qs.map((q) => q.key), ['rate-lobby-2026-10-13T07', 'rate-kibble-2026-10-13T07']);
  assert.equal(new Set(qs.map((q) => q.title)).size, qs.length);
  for (const q of qs) assert.match(q.body, /Success:/);
  const [b] = liveBriefs(r);
  assert.equal(b.key, 'rates-2026-10-13T07');
  assert.match(b.headline, /\/r\/lobby 100\/min/);
});

test('spent live keys are trimmed, the hand-written ones never are', () => {
  const live = Array.from({ length: 50 }, (_, i) => `rate-r${i}`);
  const kept = pruneKeys(['bank-1', ...live, 'bank-2'], ['bank-1', 'bank-2'], 40);
  assert.ok(kept.includes('bank-1') && kept.includes('bank-2'));
  assert.equal(kept.length, 42);
  assert.ok(kept.includes('rate-r49') && !kept.includes('rate-r0'));
});
