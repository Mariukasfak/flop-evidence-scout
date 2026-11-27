import test from 'node:test';
import assert from 'node:assert/strict';

import { checkLock, checkClaim, checkFunds, lockedInDay, FLOP } from '../chain/rail-policy.mjs';

const SCRIBE = 'did:key:z6MkfbpY47z3CaScribeXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const SCOUT = 'did:key:z6MkfbpY47z3CaScoutXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const STRANGER = 'did:key:z6MkvZ9AqfStrangerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const NOW = Date.parse('2026-11-27T12:00:00Z');
const HEX = (c) => `0x${c.repeat(64)}`;

const terms = (over = {}) => ({
  contract: HEX('a'), lock: 'hash', statement: HEX('b'), amount: String(FLOP / 10n), asset: 'FLOP',
  payer: SCRIBE, payee: STRANGER, claimByMs: NOW + 90 * 60_000, refundAfterMs: NOW + 150 * 60_000, ...over,
});
const ctx = (over = {}) => ({ payerDid: SCRIBE, ownDids: [SCRIBE, SCOUT], journal: [], now: NOW, ...over });

test('checkLock: a small FLOP hash lock from the Scribe to a stranger passes', () => {
  assert.deepEqual(checkLock(terms(), ctx()), { ok: true, why: 'within policy' });
});

test('checkLock: never a deal between our own keys, never another payer', () => {
  assert.match(checkLock(terms({ payee: SCOUT }), ctx()).why, /our own keys/);
  assert.match(checkLock(terms({ payer: SCOUT }), ctx()).why, /not the Scribe/);
});

test('checkLock: only native FLOP, hash locks, sane ids and amounts', () => {
  assert.match(checkLock(terms({ asset: 'PAPER' }), ctx()).why, /not FLOP/);
  assert.match(checkLock(terms({ lock: 'point' }), ctx()).why, /not hash/);
  assert.match(checkLock(terms({ contract: 'a'.repeat(64) }), ctx()).why, /contract/);
  assert.match(checkLock(terms({ amount: '0' }), ctx()).why, /positive/);
  assert.match(checkLock(terms({ amount: String(FLOP) }), ctx()).why, /per-deal cap/);
});

test('checkLock: windows must give the payee time and bring the refund back soon', () => {
  assert.match(checkLock(terms({ claimByMs: NOW + 60_000 }), ctx()).why, /too short/);
  assert.match(checkLock(terms({ refundAfterMs: NOW + 5 * 3600_000 }), ctx()).why, /too far/);
  assert.match(checkLock(terms({ refundAfterMs: NOW + 90 * 60_000 }), ctx()).why, /must follow/);
});

test('checkLock: one attempt per contract, even an uncertain one', () => {
  const journal = [{ kind: 'lock-pending', contract: HEX('a'), amount: '1', at: new Date(NOW - 1000).toISOString() }];
  assert.match(checkLock(terms(), ctx({ journal })).why, /already locked or attempted/);
});

test('lockedInDay and the rolling cap: a contract counts once; old locks drop out', () => {
  const q = String(FLOP / 4n);
  const at = new Date(NOW - 3600_000).toISOString();
  const journal = [
    { kind: 'lock-pending', contract: HEX('1'), amount: q, at }, { kind: 'lock', contract: HEX('1'), amount: q, at },
    { kind: 'lock-pending', contract: HEX('2'), amount: q, at },
    { kind: 'lock', contract: HEX('3'), amount: q, at },
    { kind: 'lock', contract: HEX('4'), amount: q, at: new Date(NOW - 25 * 3600_000).toISOString() },
  ];
  assert.equal(lockedInDay(journal, NOW), 3n * (FLOP / 4n));
  assert.equal(checkLock(terms({ amount: q }), ctx({ journal })).ok, true);
  const more = [...journal, { kind: 'lock', contract: HEX('5'), amount: q, at }];
  assert.match(checkLock(terms({ amount: q }), ctx({ journal: more })).why, /rolling 24 h cap/);
});

test('checkClaim: the Scout claims only escrows that pay the Scout', () => {
  assert.equal(checkClaim(terms({ payee: SCOUT }), { payeeDid: SCOUT }).ok, true);
  assert.equal(checkClaim(terms(), { payeeDid: SCOUT }).ok, false);
});

test('checkLock: a refused attempt is not an attempt; a lock error is', () => {
  const at = new Date(NOW - 1000).toISOString();
  assert.equal(checkLock(terms(), ctx({ journal: [{ kind: 'lock-refused', contract: HEX('a'), at }] })).ok, true);
  assert.equal(checkLock(terms(), ctx({ journal: [{ kind: 'lock-error', contract: HEX('a'), at }] })).ok, false);
});

test('checkLock: a lock that failed before signing (lock-unsent) voids the attempt and the cap', () => {
  const at = new Date(NOW - 1000).toISOString();
  const journal = [
    { kind: 'lock-pending', contract: HEX('a'), amount: String(FLOP / 4n), at },
    { kind: 'lock-unsent', contract: HEX('a'), at },
  ];
  assert.equal(checkLock(terms(), ctx({ journal })).ok, true);
  assert.equal(lockedInDay(journal, NOW), 0n);
  const again = [...journal, { kind: 'lock-pending', contract: HEX('a'), amount: '1', at }];
  assert.equal(checkLock(terms(), ctx({ journal: again })).ok, false, 'a fresh pending entry counts again');
});

test('checkFunds: the amount plus a 2 FLOP fee reserve must be free', () => {
  assert.equal(checkFunds(10n * FLOP, String(FLOP / 4n)).ok, true);
  assert.equal(checkFunds(2n * FLOP, String(FLOP / 4n)).ok, false);
  assert.equal(checkFunds(0n, '1').ok, false);
});
