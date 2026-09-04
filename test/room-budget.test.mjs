import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isRoomCreationRefusal, nextDayBoundary, loadBudget, saveBudget,
  canOpenRoom, recordRefusal, minutesBlocked
} from '../src/room-budget.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-budget-'));
const T = Date.parse('2026-09-04T09:00:00Z');

describe('both ways a room is refused', () => {
  test('the service-wide 400 is a refusal', () => {
    assert.equal(isRoomCreationRefusal(
      new Error('HTTP 400 room limit reached (81920 is the cap, and this would be a new one)')), true);
  });

  test('the per-client 429 is a refusal too', () => {
    // Until 2026-09-04 this one was not recognised, so a budget refusal would
    // have been retried into every cycle -- the failure this module exists for.
    assert.equal(isRoomCreationRefusal(
      new Error('HTTP 429 room-creation budget spent: this IP has created its 20 rooms for the day')), true);
  });

  test('an unrelated failure is not a room refusal', () => {
    assert.equal(isRoomCreationRefusal(new Error('HTTP 503 upstream unavailable')), false);
    assert.equal(isRoomCreationRefusal(new Error('ECONNRESET')), false);
  });

  test('nothing at all is not a refusal', () => {
    assert.equal(isRoomCreationRefusal(null), false);
    assert.equal(isRoomCreationRefusal(undefined), false);
  });
});

describe('standing down until the day turns', () => {
  test('a fresh budget may open a room', () => {
    assert.equal(canOpenRoom({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T), true);
  });

  test('a refusal blocks until the next UTC midnight', () => {
    const after = recordRefusal({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T);
    assert.equal(canOpenRoom(after, T), false);
    assert.equal(after.blockedUntilMs, nextDayBoundary(T));
    assert.equal(new Date(after.blockedUntilMs).toISOString(), '2026-09-05T00:00:00.000Z');
  });

  test('the block lifts once the boundary passes', () => {
    const after = recordRefusal({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T);
    assert.equal(canOpenRoom(after, after.blockedUntilMs), true, 'at the boundary itself');
    assert.equal(canOpenRoom(after, after.blockedUntilMs + 1), true);
  });

  test('minutesBlocked counts down and never goes negative', () => {
    const after = recordRefusal({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T);
    assert.equal(minutesBlocked(after, T), 900, 'fifteen hours to midnight');
    assert.equal(minutesBlocked(after, after.blockedUntilMs + 60_000) <= 0, true);
  });

  test('refusals accumulate, so a log can say how often we hit it', () => {
    let b = recordRefusal({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T);
    b = recordRefusal(b, T + 1000);
    assert.equal(b.refusals, 2);
    assert.equal(typeof b.lastRefusalAt, 'string');
  });
});

describe('the budget file', () => {
  test('survives a round trip', () => {
    const file = path.join(tmp(), 'budget.json');
    const written = recordRefusal({ blockedUntilMs: 0, refusals: 0, lastRefusalAt: null }, T);
    saveBudget(written, file);
    assert.equal(loadBudget(file).blockedUntilMs, written.blockedUntilMs);
  });

  test('a missing file is an unblocked budget, not a crash', () => {
    const b = loadBudget(path.join(tmp(), 'nope.json'));
    assert.equal(canOpenRoom(b, T), true);
  });

  test('a corrupt file is an unblocked budget', () => {
    const file = path.join(tmp(), 'bad.json');
    fs.writeFileSync(file, 'not json');
    assert.equal(canOpenRoom(loadBudget(file), T), true);
  });
});
