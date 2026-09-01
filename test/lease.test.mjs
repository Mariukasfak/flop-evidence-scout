import test, { describe } from 'node:test';
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

/**
 * A single 503 used to cost a whole cycle.
 *
 * The lease gates everything the daemon does, and Technocore returns 503s in
 * bursts. Measured over one run: 141 of 570 cycles stood down on an unreadable
 * lease — a quarter of the agent's working time given up to a server that
 * answered on the next request.
 */
test('one bad read does not stand the agent down', async () => {
  const client = new FakeKv();
  let reads = 0;
  const realRead = client.readNote.bind(client);
  client.readNote = async (...args) => {
    reads += 1;
    // Fails once, exactly the shape of the bursts seen in production.
    if (reads === 1) return { reachable: false, found: null, value: null, status: 503, error: 'HTTP 503' };
    return realRead(...args);
  };

  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1' });
  const attempt = await lease.acquire();

  assert.equal(attempt.acquired, true, 'the retry recovered the cycle');
  assert.ok(reads >= 2, 'the read was actually retried');
});

test('a server that is genuinely down is still reported as down', async () => {
  const client = new FakeKv();
  client.down = true;
  // readAttempts: 1 keeps the test fast; the retry itself is covered above.
  const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', readAttempts: 1 });

  const attempt = await lease.acquire();
  assert.equal(attempt.acquired, false);
  assert.equal(attempt.transient, true, 'an outage is transient, not contention');
});

/**
 * Working through an outage on a lease we already hold.
 *
 * Measured 2026-08-31: 43 of 69 probes two seconds apart returned 503, with
 * failures in runs of up to 45 seconds. Overnight that cost 224 of 579 cycles.
 * An unreadable note is not evidence that our lease ended — we wrote it, and
 * nobody else may take it before it expires.
 *
 * The margin is the whole safety argument, so it is tested from both sides.
 */
describe('a lease we already hold, while the server is unreachable', () => {
  test('keeps working while a comfortable slice of the TTL remains', async () => {
    const client = new FakeKv();
    const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, readAttempts: 1 });

    assert.equal((await lease.acquire()).acquired, true, 'held it first');
    client.down = true;

    const during = await lease.acquire();
    assert.equal(during.acquired, true, 'still ours until it expires');
    assert.equal(during.degraded, true, 'and says it is running on trust');
  });

  test('stands down near expiry, when we no longer know', async () => {
    let clock = 1_000_000;
    const client = new FakeKv();
    const lease = new Lease({
      client, name: 'scout-cycle', holder: 'local-a1',
      ttlMs: 60_000, readAttempts: 1, now: () => clock
    });

    assert.equal((await lease.acquire()).acquired, true);
    client.down = true;
    // Past the one-third margin: two writers is the risk, so guessing is not on.
    clock += 55_000;

    const late = await lease.acquire();
    assert.equal(late.acquired, false, 'near expiry we stand down rather than guess');
    assert.equal(late.transient, true);
  });

  test('a process that never held it does not invent one', async () => {
    const client = new FakeKv();
    client.down = true;
    const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-b2', readAttempts: 1 });

    const attempt = await lease.acquire();
    assert.equal(attempt.acquired, false, 'no prior claim means no lease to fall back on');
  });
});

/**
 * The renewal path, which is the one that actually runs.
 *
 * The lease is claimed once and renewed every cycle, so a failed renewal is far
 * more common than a failed claim. Measured after the read-path fix shipped:
 * five standdowns from the read, four from the renewal write.
 */
describe('a renewal that does not reach the server', () => {
  test('keeps the lease we already hold', async () => {
    const client = new FakeKv();
    const lease = new Lease({ client, name: 'scout-cycle', holder: 'local-a1', ttlMs: 60_000, readAttempts: 1 });
    assert.equal((await lease.acquire()).acquired, true);

    // Reads fine, writes fail: exactly the shape of a 503 on the write lane.
    client.setKv = async () => { throw new Error('Technocore note write failed: HTTP 503 Service Unavailable'); };

    const during = await lease.acquire();
    assert.equal(during.acquired, true, 'a failed extension is not a lost lease');
    assert.equal(during.degraded, true);
  });

  test('does not let us take over somebody else on a failed write', async () => {
    const client = new FakeKv();
    const other = new Lease({ client, name: 'scout-cycle', holder: 'other-x1', ttlMs: 60_000, readAttempts: 1 });
    assert.equal((await other.acquire()).acquired, true);

    // Expire theirs so the takeover path is the one under test.
    const us = new Lease({
      client, name: 'scout-cycle', holder: 'local-a1',
      ttlMs: 60_000, readAttempts: 1, now: () => Date.now() + 120_000
    });
    client.setKv = async () => { throw new Error('Technocore note write failed: HTTP 503 Service Unavailable'); };

    const attempt = await us.acquire();
    assert.equal(attempt.acquired, false, 'a takeover that never landed is not a takeover');
  });
});

describe('a lease survives a restart', () => {
  // Observed 2026-09-01: the daemon restarted into a 503 and then logged
  // lease_unreachable every eighteen seconds for twelve minutes without running
  // a single cycle, while a lease it had held moments earlier was still valid.
  // The degraded path needs proof the lease is ours and a fresh process has
  // none, so it could neither acquire nor continue.
  const make = (holder) => new Lease({
    client: { async readNote() { return { reachable: false, error: 'HTTP 503' }; } },
    name: 'scout-cycle', holder, ttlMs: 300_000
  });

  test('resumes a lease this holder still has time on', () => {
    const lease = make('local-abc');
    const ok = lease.resume({ value: 'local-abc|1234', heldUntil: Date.now() + 200_000 });
    assert.equal(ok, true);
    assert.equal(lease.currentValue, 'local-abc|1234');
  });

  test('and then keeps working through an outage on it', async () => {
    // The whole point: with the lease restored, an unreachable server is a
    // reason to carry on rather than to stand down.
    const lease = make('local-abc');
    lease.resume({ value: 'local-abc|1234', heldUntil: Date.now() + 200_000 });
    const attempt = await lease.acquire();
    assert.equal(attempt.acquired, true);
    assert.equal(attempt.degraded, true);
  });

  test('refuses an expired one', () => {
    const lease = make('local-abc');
    assert.equal(lease.resume({ value: 'local-abc|1', heldUntil: Date.now() - 1000 }), false);
    assert.equal(lease.currentValue, null);
  });

  test('refuses one written by somebody else', () => {
    // Resuming another holder's lease would be a claim about ownership we have
    // no right to make, which is a different thing from surviving a restart.
    const lease = make('local-abc');
    assert.equal(lease.resume({ value: 'cloud-xyz|1', heldUntil: Date.now() + 200_000 }), false);
  });

  test('refuses nonsense rather than throwing', () => {
    const lease = make('local-abc');
    assert.equal(lease.resume({}), false);
    assert.equal(lease.resume({ value: 'local-abc|1', heldUntil: 'soon' }), false);
    assert.equal(lease.resume(), false);
  });

  test('snapshot round-trips through resume', () => {
    const a = make('local-abc');
    a.currentValue = 'local-abc|99';
    a.heldUntil = Date.now() + 100_000;

    const b = make('local-abc');
    assert.equal(b.resume(a.snapshot()), true);
    assert.equal(b.currentValue, a.currentValue);
  });

  test('a lease we do not hold has nothing to save', () => {
    assert.equal(make('local-abc').snapshot(), null);
  });
});
