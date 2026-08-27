import test from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity } from '../src/identity.mjs';
import {
  holderCode, activityKey, emptyRecord, withCycle, recordCycle,
  readActivity, summariseActivity, MAX_CYCLES, ACTIVITY_NS
} from '../src/shared-state.mjs';
import { isValidTechnocoreName } from '../src/identity.mjs';

const identity = generateIdentity();

/** Note store with real conditional-write semantics, as the server has them. */
class FakeKv {
  constructor() { this.store = new Map(); this.down = false; }

  async readNote(ns, key) {
    if (this.down) return { reachable: false, found: null, value: null, status: 503, error: 'HTTP 503' };
    const raw = this.store.get(`${ns}/${key}`);
    if (raw === undefined) return { reachable: true, found: false, value: null, status: 404, error: null };
    return { reachable: true, found: true, value: raw, status: 200, error: null };
  }

  async getKv(ns, key) {
    const raw = this.store.get(`${ns}/${key}`);
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
    if (this.down) throw new Error('Technocore note write failed: HTTP 503');
    const k = `${ns}/${key}`;
    const current = this.store.get(k);
    if (ifAbsent && current !== undefined) throw new Error('HTTP 409 note exists');
    if (ifValue !== null && current !== ifValue) throw new Error('HTTP 409 precondition failed');
    this.store.set(k, String(value));
    return true;
  }
}

test('the activity key is a legal Technocore name', () => {
  const key = activityKey(identity.did);
  assert.equal(isValidTechnocoreName(key), true, `${key} would be rejected with 400 bad name`);
  assert.equal(isValidTechnocoreName(ACTIVITY_NS), true);
});

test('holders compress to two characters', () => {
  assert.equal(holderCode('github-a1b2c3'), 'gh');
  assert.equal(holderCode('local-x9y8z7'), 'lo');
  assert.equal(holderCode('something-else'), 'xx');
  assert.equal(holderCode(undefined), 'xx');
});

test('a cycle adds to the ring and to the totals', () => {
  let record = emptyRecord();
  record = withCycle(record, { holder: 'github-a1', at: 60_000, sessions: 2, spendFlop: 6 });
  record = withCycle(record, { holder: 'local-b2', at: 120_000, sessions: 1, spendFlop: 3 });

  assert.equal(record.cycles.length, 2);
  assert.deepEqual(record.totals, { gh: 1, lo: 1 });
  assert.equal(record.spend.sessions, 3);
  assert.equal(record.spend.flop, 9);
});

test('the ring is capped so the note can never outgrow the 8192-char limit', () => {
  let record = emptyRecord();
  for (let i = 0; i < MAX_CYCLES + 200; i++) {
    record = withCycle(record, { holder: i % 2 ? 'github-a1' : 'local-b2', at: i * 60_000 });
  }
  assert.equal(record.cycles.length, MAX_CYCLES);
  // Totals keep counting past the ring — history is trimmed, the count is not.
  assert.equal(record.totals.gh + record.totals.lo, MAX_CYCLES + 200);
  assert.ok(JSON.stringify(record).length < 8192, 'a full ring must fit in one note');
});

test('two machines both appear in one record', async () => {
  const client = new FakeKv();
  await recordCycle(client, identity.did, { holder: 'github-a1', at: 60_000, sessions: 1, spendFlop: 3 });
  await recordCycle(client, identity.did, { holder: 'local-b2', at: 120_000, sessions: 2, spendFlop: 6 });
  await recordCycle(client, identity.did, { holder: 'github-a1', at: 180_000, sessions: 1, spendFlop: 3 });

  const { record } = await readActivity(client, identity.did);
  assert.deepEqual(record.totals, { gh: 2, lo: 1 });
  assert.equal(record.spend.sessions, 4);
  assert.equal(record.spend.flop, 12);
  assert.equal(record.cycles.length, 3);
});

test('a concurrent write is merged, never clobbered', async () => {
  const client = new FakeKv();
  await recordCycle(client, identity.did, { holder: 'github-a1', at: 60_000, sessions: 1 });

  // Both machines record at once, from the same starting state.
  await Promise.all([
    recordCycle(client, identity.did, { holder: 'local-b2', at: 120_000, sessions: 1 }),
    recordCycle(client, identity.did, { holder: 'github-a1', at: 121_000, sessions: 1 })
  ]);

  const { record } = await readActivity(client, identity.did);
  // The loser re-read and re-applied, so all three cycles survive.
  assert.equal(record.cycles.length, 3, 'a lost race must retry, not overwrite');
  assert.equal(record.spend.sessions, 3);
});

test('an unreachable server is reported, not silently treated as empty', async () => {
  const client = new FakeKv();
  client.down = true;

  const read = await readActivity(client, identity.did);
  assert.equal(read.reachable, false);

  const written = await recordCycle(client, identity.did, { holder: 'local-b2' });
  assert.equal(written.recorded, false);
  assert.match(written.reason, /unreachable/);
});

test('a corrupt record is replaced rather than crashing the cycle', async () => {
  const client = new FakeKv();
  await client.setKv(ACTIVITY_NS, activityKey(identity.did), 'not json at all');

  const { record } = await readActivity(client, identity.did);
  assert.deepEqual(record.cycles, []);

  const written = await recordCycle(client, identity.did, { holder: 'local-b2', at: 60_000 });
  assert.equal(written.recorded, true);
});

test('the combined duty cycle counts both machines', () => {
  // Twelve cycles at a perfect 15-minute cadence, alternating machines.
  let record = emptyRecord();
  for (let i = 0; i < 12; i++) {
    record = withCycle(record, { holder: i % 2 ? 'local-b2' : 'github-a1', at: i * 15 * 60_000 });
  }

  const summary = summariseActivity(record, { cadenceMin: 15, now: 11 * 15 * 60_000 });
  assert.equal(summary.cycles, 12);
  assert.ok(summary.dutyCycle > 0.9, `expected near-full coverage, got ${summary.dutyCycle}`);
  assert.equal(summary.byHolder.gh, 6);
  assert.equal(summary.byHolder.lo, 6);
  assert.ok(Math.abs(summary.share.lo - 0.5) < 0.01);
});

test('local cycles covering a cloud gap actually raise the duty cycle', () => {
  // The point of the whole exercise: the file-based metric could not see this.
  const cadenceMin = 15;

  let cloudOnly = emptyRecord();
  for (const step of [0, 4, 9, 14]) {                    // GitHub dropping runs
    cloudOnly = withCycle(cloudOnly, { holder: 'github-a1', at: step * cadenceMin * 60_000 });
  }
  const before = summariseActivity(cloudOnly, { cadenceMin });

  let both = cloudOnly;
  for (const step of [1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13]) {   // the PC filling in
    both = withCycle(both, { holder: 'local-b2', at: step * cadenceMin * 60_000 });
  }
  const after = summariseActivity(both, { cadenceMin });

  assert.ok(before.dutyCycle < 0.4, `cloud alone should look poor, got ${before.dutyCycle}`);
  assert.ok(after.dutyCycle > 0.9, `both together should look good, got ${after.dutyCycle}`);
  assert.ok(after.dutyCycle > before.dutyCycle * 2);
});

test('a record with one cycle reports no duty cycle rather than a fake one', () => {
  const record = withCycle(emptyRecord(), { holder: 'local-b2', at: 60_000 });
  const summary = summariseActivity(record);
  assert.equal(summary.dutyCycle, null);
  assert.equal(summary.cycles, 1);
});

test('spend totals survive the ring being trimmed', () => {
  let record = emptyRecord();
  for (let i = 0; i < MAX_CYCLES + 50; i++) {
    record = withCycle(record, { holder: 'local-b2', at: i * 60_000, spendFlop: 3, sessions: 1 });
  }
  // The cumulative figure the airdrop is scored on must not be a rolling window.
  assert.equal(record.spend.sessions, MAX_CYCLES + 50);
  assert.equal(record.spend.flop, (MAX_CYCLES + 50) * 3);
});
