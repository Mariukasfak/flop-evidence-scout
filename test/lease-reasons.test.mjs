import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { Lease } from '../src/lease.mjs';
import { TechnocoreClient } from '../src/technocore-client.mjs';

/**
 * On 2026-09-02, right after a restart, the agent stood down its writes for
 * one cycle with the reason "renewal did not reach the server" and nothing
 * else. Reconstructing that the rule had applied correctly — the note had
 * under a third of its TTL left — took four reads of two files and the audit.
 * The number that decides a stand-down belongs in the sentence that reports it.
 */
describe('A lease stand-down says how much time was left', () => {
  const TTL = 480_000;
  const holder = 'local-test';
  const now = 1_800_000_000_000;

  function clientWith({ readReachable = true, value = null, writeError = null } = {}) {
    return {
      async readNote() {
        return readReachable
          ? { reachable: true, found: value !== null, value }
          : { reachable: false, error: 'HTTP 503 Service Unavailable' };
      },
      async setKv() {
        if (writeError) throw new Error(writeError);
        return true;
      }
    };
  }

  test('an unreachable read with too little left names the seconds and the floor', async () => {
    const lease = new Lease({ client: clientWith({ readReachable: false }), name: 'l', holder, ttlMs: TTL, now: () => now, readAttempts: 1 });
    lease.resume({ value: `${holder}|${now + 100_000}`, heldUntil: now + 100_000 });   // 100 s left, floor is 160 s

    const attempt = await lease.acquire();

    assert.equal(attempt.acquired, false);
    assert.equal(attempt.transient, true);
    assert.match(attempt.reason, /only 100s remain on ours/);
    assert.match(attempt.reason, /below the 160s floor/);
  });

  test('an unreachable read with enough left keeps working on trust', async () => {
    const lease = new Lease({ client: clientWith({ readReachable: false }), name: 'l', holder, ttlMs: TTL, now: () => now, readAttempts: 1 });
    lease.resume({ value: `${holder}|${now + 300_000}`, heldUntil: now + 300_000 });

    const attempt = await lease.acquire();

    assert.equal(attempt.acquired, true);
    assert.equal(attempt.degraded, true);
    assert.match(attempt.reason, /runs for another 300s/);
  });

  test('a renewal that did not arrive, with too little left, says so in seconds', async () => {
    const value = `${holder}|${now + 100_000}`;
    const lease = new Lease({
      client: clientWith({ value, writeError: 'Technocore note write failed: HTTP 503 Service Unavailable' }),
      name: 'l', holder, ttlMs: TTL, now: () => now, readAttempts: 1
    });
    lease.resume({ value, heldUntil: now + 100_000 });

    const attempt = await lease.acquire();

    assert.equal(attempt.acquired, false);
    assert.equal(attempt.transient, true);
    assert.match(attempt.reason, /^renewal did not reach the server/);
    assert.match(attempt.reason, /only 100s remain on ours, below the 160s floor/);
  });
});

describe('A refused write says why, not "dry run"', () => {
  test('the daemon-set reason reaches the error a lane records', async () => {
    const client = new TechnocoreClient({ baseUrl: 'https://test.example' });
    client.readOnly = true;
    client.readOnlyReason = 'writes suppressed this cycle, lease unconfirmed (renewal did not reach the server)';

    await assert.rejects(
      () => client.postMessage('tclk-offers', 'tclk1 {}', { did: 'did:key:z6Mk' + 'a'.repeat(44), privateKeyPem: 'x' }),
      (err) => /refusing to post to \/r\/tclk-offers: writes suppressed this cycle, lease unconfirmed/.test(err.message)
    );
  });

  test('a real dry run still says dry run', async () => {
    const client = new TechnocoreClient({ baseUrl: 'https://test.example', readOnly: true });
    await assert.rejects(
      () => client.setKv('ns', 'key', 'v'),
      (err) => /refusing to write the note \/kv\/ns\/key: dry run/.test(err.message)
    );
  });
});
