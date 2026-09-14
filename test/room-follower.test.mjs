import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RoomFollower } from '../src/room-follower.mjs';

/**
 * A client that answers from a scripted head position, the way the venue does:
 * the newest `limit` records with seq > since, never the oldest. Every one of
 * these tests would pass against a client that walked forward instead, which is
 * exactly the behaviour upstream #481 says does not exist.
 */
function fakeClient(script) {
  let call = 0;
  return {
    calls: () => call,
    async readRoom(room, { since, limit }) {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step.throws) throw new Error('read failed');
      const head = step.head;
      const floor = Math.max((since || 0) + 1, head - limit + 1);
      const messages = [];
      for (let seq = floor; seq <= head; seq += 1) {
        messages.push({ seq, from: step.from || 'did:key:other', text: `m${seq}` });
      }
      return {
        room,
        messages,
        first_seq: messages.length ? messages[0].seq : head,
        last_seq: head,
        generation: step.generation ?? 0
      };
    }
  };
}

describe('RoomFollower', () => {
  test('sizes the interval off the peak rate, so a quiet room that burst stays fast', async () => {
    let clock = 0;
    const client = fakeClient([
      { head: 1000 }, { head: 1100 }, { head: 6100 }, { head: 6110 }, { head: 6120 }
    ]);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });

    for (let i = 0; i < 5; i += 1) {
      clock += 60_000;
      await follower.pollOnce('r');
    }

    const { r } = follower.stats();
    // The burst minute moved the head 5,000, so the peak must dominate the
    // average of a room that is now doing ~10/min.
    assert.ok(r.ratePerMin < 1000, `average should have decayed, got ${r.ratePerMin}`);
    assert.equal(r.intervalMs, 3000, 'peak sizing should hold the floor interval after a burst');
  });

  test('a full response marks saturation, which shortens the interval further', async () => {
    let clock = 0;
    // Head moves by exactly the window, so every response comes back full.
    const client = fakeClient([{ head: 400 }, { head: 600 }, { head: 800 }]);
    const follower = new RoomFollower({ client, rooms: ['a', 'b', 'c'], readWindow: 200, now: () => clock });
    for (let i = 0; i < 3; i += 1) {
      clock += 60_000;
      await follower.pollOnce('a');
    }
    const stats = follower.stats();
    assert.ok(stats.a.reads === 3);
    // 200/min against a 200 window would otherwise buy 36 s; saturation must cut it.
    assert.ok(stats.a.intervalMs < 36_000, `expected a shortened interval, got ${stats.a.intervalMs}`);
  });

  test('drain returns what arrived since the last drain, not a running total', async () => {
    let clock = 0;
    const client = fakeClient([{ head: 10 }, { head: 20 }, { head: 30 }]);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });

    clock += 1000; await follower.pollOnce('r');
    const first = follower.drain('r');
    assert.equal(first.messages.length, 10, 'first drain carries the opening window');

    clock += 1000; await follower.pollOnce('r');
    const second = follower.drain('r');
    assert.equal(second.messages.length, 10, 'second drain carries only the new records');
    assert.equal(second.messages[0].seq, 11);

    const third = follower.drain('r');
    assert.equal(third.messages.length, 0, 'draining twice yields nothing the second time');
  });

  test('a gap is counted per drain and the total is kept separately', async () => {
    let clock = 0;
    // 5,000 records past a 200 window: 4,800 fall between cursor and first_seq.
    const client = fakeClient([{ head: 200 }, { head: 5200 }]);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });

    clock += 1000; await follower.pollOnce('r');
    follower.drain('r');
    clock += 1000; await follower.pollOnce('r');

    const drained = follower.drain('r');
    assert.equal(drained.gapRecords, 4800, 'the drain reports the gap it saw');
    assert.equal(follower.stats().r.gapRecords, 4800, 'the total survives the drain');

    const after = follower.drain('r');
    assert.equal(after.gapRecords, 0, 'the per-drain counter resets');
    assert.equal(follower.stats().r.gapRecords, 4800, 'the total still does not');
  });

  test('a new generation resets instead of reporting a million lost records', async () => {
    let clock = 0;
    const client = fakeClient([
      { head: 900_000, generation: 0 },
      { head: 50, generation: 1 }
    ]);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });

    clock += 1000; await follower.pollOnce('r');
    follower.drain('r');
    clock += 1000; await follower.pollOnce('r');

    // A reaped-and-recreated room shares only its name. Counting the distance
    // between the old seq and the new one invents a number for messages that
    // were never ours to read.
    assert.equal(follower.drain('r').gapRecords, 0);
  });

  test('our own posts never come back as something to answer', async () => {
    let clock = 0;
    const client = fakeClient([{ head: 20, from: 'did:key:self' }]);
    const follower = new RoomFollower({
      client, rooms: ['r'], readWindow: 200, selfDid: 'did:key:self', now: () => clock
    });
    clock += 1000; await follower.pollOnce('r');
    assert.equal(follower.drain('r').messages.length, 0);
  });

  test('a failed read is counted and does not move the cursor', async () => {
    let clock = 0;
    const client = fakeClient([{ head: 20 }, { throws: true }]);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });
    clock += 1000; await follower.pollOnce('r');
    const before = follower.drain('r').cursor;
    clock += 1000; await follower.pollOnce('r');
    const stats = follower.stats();
    assert.equal(stats.r.errors, 1);
    assert.equal(follower.drain('r').cursor, before, 'a failure must not advance the cursor');
  });

  test('the buffer is bounded, and what it drops is counted rather than silent', async () => {
    let clock = 0;
    const script = [];
    for (let i = 1; i <= 30; i += 1) script.push({ head: i * 200 });
    const client = fakeClient(script);
    const follower = new RoomFollower({ client, rooms: ['r'], readWindow: 200, now: () => clock });
    for (let i = 0; i < 30; i += 1) {
      clock += 1000;
      await follower.pollOnce('r');
    }
    const drained = follower.drain('r');
    assert.ok(drained.messages.length <= 3000, 'the buffer holds its bound');
    assert.ok(drained.dropped > 0, 'and says how much it had to drop');
  });
});
