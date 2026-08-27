import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Lease, withLease, encodeLease, decodeLease, makeHolderId,
  DEFAULT_TTL_MS
} from '../src/lease.mjs';

/**
 * A stand-in for the note store that enforces the same conditional-write rules
 * the server does. The point of these tests is the race, so the fake has to be
 * strict about `if_absent` and `if=` — a permissive fake would pass everything
 * and prove nothing.
 */
class FakeKv {
  constructor() { this.store = new Map(); this.writes = 0; this.down = false; }

  /** Mirrors the real client: absence and unreachability are different answers. */
  async readNote(ns, key) {
    if (this.down) return { reachable: false, found: null, value: null, status: 503, error: 'HTTP 503' };
    const raw = this.store.get(`${ns}/${key}`);
    if (raw === undefined) return { reachable: true, found: false, value: null, status: 404, error: null };
    return { reachable: true, found: true, value: raw, status: 200, error: null };
  }

  async getKv(ns, key) {
    const raw = this.store.get(`${ns}/${key}`);
    if (raw === undefined) return null;
    // Mirror the real client: JSON when it parses, the string otherwise.
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
    if (this.down) throw new Error('Technocore note write failed: HTTP 503 Service Unavailable');
    const k = `${ns}/${key}`;
    const current = this.store.get(k);
    if (ifAbsent && current !== undefined) throw new Error('HTTP 409 note exists');
    if (ifValue !== null && current !== ifValue) throw new Error('HTTP 409 precondition failed');
    this.store.set(k, String(value));
    this.writes++;
    return true;
  }
}

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test('a lease token round-trips exactly', () => {
  const encoded = encodeLease('local-abc123', 1_700_000_000_000);
  assert.equal(encoded, 'local-abc123|1700000000000');
  assert.deepEqual(decodeLease(encoded), { holder: 'local-abc123', expiresAt: 1_700_000_000_000 });
});

test('a lease token is never valid JSON', () => {
  // This is load-bearing: getKv JSON-parses anything that parses, and a parsed
  // value could not be handed back to `if=` verbatim.
  assert.throws(() => JSON.parse(encodeLease('local-a1', Date.now())));
});

test('a malformed lease value decodes to null rather than a wrong holder', () => {
  assert.equal(decodeLease('garbage'), null);
  assert.equal(decodeLease('holder|notanumber'), null);
  assert.equal(decodeLease(''), null);
  assert.equal(decodeLease(null), null);
  assert.equal(decodeLease({ holder: 'x' }), null);
});

test('a holder id with unsafe characters is refused', () => {
  assert.throws(() => encodeLease('Bad Holder!', Date.now()), /must match/);
  assert.throws(() => encodeLease('has|pipe', Date.now()), /must match/);
  assert.throws(() => encodeLease('', Date.now()), /must match/);
});

test('generated holder ids are always safe and always distinct', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = makeHolderId('GitHub Actions Runner!');
    assert.doesNotThrow(() => encodeLease(id, Date.now()));
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'two processes must never share a holder id');
});

test('an unheld lease is acquired', async () => {
  const client = new FakeKv();
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  const result = await lease.acquire();
  assert.equal(result.acquired, true);
  assert.match(result.reason, /unheld/);
  assert.equal(lease.isHeld(), true);
});

test('a second process cannot take a live lease', async () => {
  const client = new FakeKv();
  const c = clock();

  const first = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', now: c.now });
  const second = new Lease({ client, name: 'scout-cycle', holder: 'github-b2', now: c.now });

  assert.equal((await first.acquire()).acquired, true);

  const denied = await second.acquire();
  assert.equal(denied.acquired, false);
  assert.equal(denied.heldBy, 'local-a1');
  assert.match(denied.reason, /held by local-a1/);
  assert.equal(second.isHeld(), false);
});

test('two processes racing from empty: exactly one wins', async () => {
  const client = new FakeKv();
  const a = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  const b = new Lease({ client, name: 'scout-cycle', holder: 'github-b2' });

  const [ra, rb] = await Promise.all([a.acquire(), b.acquire()]);
  const winners = [ra, rb].filter((r) => r.acquired);
  assert.equal(winners.length, 1, 'exactly one process may hold the lease');
});

test('an expired lease is taken over', async () => {
  const client = new FakeKv();
  const c = clock();

  const first = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, now: c.now });
  await first.acquire();

  c.advance(61_000);   // the PC went to sleep

  const second = new Lease({ client, name: 'scout-cycle', holder: 'github-b2', ttlMs: 60_000, now: c.now });
  const taken = await second.acquire();
  assert.equal(taken.acquired, true);
  assert.match(taken.reason, /took over from local-a1/);
});

test('renewing keeps the lease and pushes the expiry out', async () => {
  const client = new FakeKv();
  const c = clock();
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, now: c.now });

  await lease.acquire();
  const firstExpiry = lease.heldUntil;

  c.advance(20_000);
  assert.equal((await lease.renew()).renewed, true);
  assert.ok(lease.heldUntil > firstExpiry);
  assert.equal(lease.isHeld(), true);
});

test('a lease stolen while we held it cannot be silently renewed back', async () => {
  const client = new FakeKv();
  const c = clock();

  const local = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, now: c.now });
  await local.acquire();

  // The PC stalled long enough for the lease to lapse and GitHub to take it.
  c.advance(61_000);
  const gh = new Lease({ client, name: 'scout-cycle', holder: 'github-b2', ttlMs: 60_000, now: c.now });
  assert.equal((await gh.acquire()).acquired, true);

  // The local process wakes up and tries to carry on as if nothing happened.
  const renewed = await local.renew();
  assert.equal(renewed.renewed, false);
  assert.match(renewed.reason, /taken while we held it/);
  assert.equal(local.isHeld(), false, 'a process that lost the lease must know it');
});

test('releasing hands the lease over immediately', async () => {
  const client = new FakeKv();
  const c = clock();

  const local = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 600_000, now: c.now });
  await local.acquire();
  assert.equal((await local.release()).released, true);
  assert.equal(local.isHeld(), false);

  // No waiting out a ten-minute TTL.
  const gh = new Lease({ client, name: 'scout-cycle', holder: 'github-b2', ttlMs: 600_000, now: c.now });
  assert.equal((await gh.acquire()).acquired, true);
});

test('isHeld refuses to say yes near the expiry', async () => {
  const client = new FakeKv();
  const c = clock();
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, now: c.now });
  await lease.acquire();

  c.advance(45_000);                       // 15s left
  assert.equal(lease.isHeld(30_000), false, 'a 30s margin must reject 15s remaining');
  assert.equal(lease.isHeld(5_000), true);
});

test('a note holding something that is not a lease is not overwritten', async () => {
  const client = new FakeKv();
  await client.setKv('lease', 'scout-cycle', 'someone-elses-data');

  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  const result = await lease.acquire();
  assert.equal(result.acquired, false);
  assert.match(result.reason, /not a lease/);
  // And it is still there.
  assert.equal(await client.getKv('lease', 'scout-cycle'), 'someone-elses-data');
});

test('withLease runs the work once and always hands the lease back', async () => {
  const client = new FakeKv();
  let ran = 0;

  const outcome = await withLease({ client, name: 'scout-cycle', holder: 'local-a1' }, async () => {
    ran++;
    return 'done';
  });

  assert.equal(outcome.ran, true);
  assert.equal(outcome.result, 'done');
  assert.equal(ran, 1);

  // Released, so the other machine is not locked out.
  const next = new Lease({ client, name: 'scout-cycle', holder: 'github-b2' });
  assert.equal((await next.acquire()).acquired, true);
});

test('withLease does not run the work when another process holds it', async () => {
  const client = new FakeKv();
  const holder = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  await holder.acquire();

  let ran = 0;
  const outcome = await withLease({ client, name: 'scout-cycle', holder: 'github-b2' }, async () => { ran++; });

  assert.equal(outcome.ran, false);
  assert.equal(outcome.heldBy, 'local-a1');
  assert.equal(ran, 0, 'the second writer must not act');
});

test('the lease is released even when the work throws', async () => {
  const client = new FakeKv();
  await assert.rejects(
    () => withLease({ client, name: 'scout-cycle', holder: 'local-a1' }, async () => { throw new Error('boom'); }),
    /boom/
  );

  // A crash must not lock the other machine out for a full TTL.
  const next = new Lease({ client, name: 'scout-cycle', holder: 'github-b2' });
  assert.equal((await next.acquire()).acquired, true);
});

test('the default TTL outlives a missed renewal', () => {
  // Renewal is every 2 minutes; a 10-minute TTL survives four missed ones.
  assert.ok(DEFAULT_TTL_MS >= 5 * 60 * 1000);
});

test('an outage is reported as an outage, not as a lost race', async () => {
  // The bug this fixes: getKv returned null for a missing note AND for a 503, so
  // a blip read as "the lease is free", the claim failed on the same blip, and
  // the daemon printed "lost the race to claim it". Nobody was racing.
  const client = new FakeKv();
  client.down = true;

  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  const result = await lease.acquire();

  assert.equal(result.acquired, false);
  assert.equal(result.transient, true, 'an outage must be marked transient');
  assert.match(result.reason, /unreachable/);
  assert.doesNotMatch(result.reason, /race/, 'an outage must never be described as contention');
});

test('an unreachable server never causes a false claim', async () => {
  const client = new FakeKv();
  client.down = true;
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });

  await lease.acquire();
  assert.equal(lease.isHeld(), false);
  assert.equal(lease.currentValue, null, 'we must not believe we hold a lease we never wrote');
});

test('the lease recovers by itself once the server returns', async () => {
  const client = new FakeKv();
  client.down = true;
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });

  assert.equal((await lease.acquire()).acquired, false);
  client.down = false;
  const second = await lease.acquire();
  assert.equal(second.acquired, true, 'a transient failure must not be sticky');
  assert.equal(lease.isHeld(), true);
});

test('a 5xx on the write is transient, a 409 is a genuine race', async () => {
  // Genuine race: another holder claimed it first, server answers 409.
  const contended = new FakeKv();
  await contended.setKv('lease', 'scout-cycle', encodeLease('other-x1', Date.now() + 60_000));
  const loser = new Lease({ client: contended, name: 'scout-cycle', holder: 'local-a1' });
  const denied = await loser.acquire();
  assert.equal(denied.acquired, false);
  assert.notEqual(denied.transient, true, 'a real conflict is not transient');

  // Outage on the write path specifically.
  const flaky = new FakeKv();
  const lease = new Lease({ client: flaky, name: 'scout-cycle', holder: 'local-a1' });
  flaky.setKv = async () => { throw new Error('Technocore note write failed: HTTP 503 Service Unavailable'); };
  const failed = await lease.acquire();
  assert.equal(failed.acquired, false);
  assert.equal(failed.transient, true);
});
