import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { simulatedBackend } from '../src/inference-backends.mjs';
import { ledgerTotals } from '../src/inference-ledger.mjs';
import {
  affordableSessions, prioritise, runWorkload, runBurst,
  DEFAULT_CONCURRENCY, TASK_PRIORITY, KNOWN_TASKS
} from '../src/workload-runner.mjs';
import { planWorkload, jobKey } from '../src/workload.mjs';
import { loadSeen, saveSeen } from '../src/seen-work.mjs';

const identity = generateIdentity();

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-runner-'));
  return path.join(dir, 'receipts.jsonl');
}

const classifyJobs = (n) => Array.from({ length: n }, (_, i) => ({
  taskId: 'classify-message',
  input: { text: `message ${i}`, room: 'lobby' }
}));

test('a budget buys a whole number of sessions, rounded down', () => {
  assert.equal(affordableSessions(10, 3), 3);      // never 3.33
  assert.equal(affordableSessions(9, 3), 3);
  assert.equal(affordableSessions(2, 3), 0);
  assert.equal(affordableSessions(0, 3), 0);
  assert.equal(affordableSessions(-5, 3), 0);
  // Free work is not budget-limited.
  assert.equal(affordableSessions(0, 0), Infinity);
});

test('the runner cannot spend more than its budget', async () => {
  const ledgerPath = tempLedger();
  const outcome = await runWorkload({
    plan: classifyJobs(20),
    backend: simulatedBackend,
    identity,
    budget: 10,
    costPerSession: 3,
    ledgerPath
  });

  // 10 / 3 = 3 sessions, 9 spent. Never 12.
  assert.equal(outcome.scheduled, 3);
  assert.equal(outcome.completed, 3);
  assert.equal(outcome.spend, 9);
  assert.ok(outcome.spend <= 10, 'the budget is a hard ceiling');
  assert.equal(outcome.stoppedBecause, 'budget');
});

test('a zero budget runs nothing at all', async () => {
  const outcome = await runWorkload({
    plan: classifyJobs(5),
    backend: simulatedBackend,
    identity,
    budget: 0,
    costPerSession: 1,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.scheduled, 0);
  assert.equal(outcome.completed, 0);
  assert.equal(outcome.spend, 0);
});

test('with no cost the whole plan runs', async () => {
  const outcome = await runWorkload({
    plan: classifyJobs(6),
    backend: simulatedBackend,
    identity,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.scheduled, 6);
  assert.equal(outcome.completed, 6);
  assert.equal(outcome.stoppedBecause, 'plan exhausted');
});

test('scarce budget is spent on the most perishable work first', () => {
  const mixed = [
    { taskId: 'classify-message', input: {} },
    { taskId: 'explain-measurement', input: {} },
    { taskId: 'summarise-source-change', input: {} },
    { taskId: 'draft-answer', input: {} }
  ];
  const order = prioritise(mixed).map((j) => j.taskId);

  // A protocol change decays fastest; classification is the endless filler.
  assert.equal(order[0], 'summarise-source-change');
  assert.equal(order[1], 'draft-answer');
  assert.equal(order[order.length - 1], 'classify-message');

  // prioritise must not mutate the caller's plan.
  assert.equal(mixed[0].taskId, 'classify-message');
});

test('an unknown task sorts last rather than crashing the sort', () => {
  const order = prioritise([
    { taskId: 'not-a-real-task', input: {} },
    { taskId: 'draft-answer', input: {} }
  ]).map((j) => j.taskId);
  assert.deepEqual(order, ['draft-answer', 'not-a-real-task']);
});

test('every known task has an explicit priority', () => {
  // A task added later without a priority would silently become filler.
  for (const id of KNOWN_TASKS) {
    assert.ok(TASK_PRIORITY[id] != null, `${id} has no priority and would sort last by accident`);
  }
});

test('a job that cannot be built is counted as failed, not silently dropped', async () => {
  const outcome = await runWorkload({
    plan: [{ taskId: 'no-such-task', input: {} }, ...classifyJobs(2)],
    backend: simulatedBackend,
    identity,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.scheduled, 3);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.completed, 2);
});

test('a backend failure is counted and costs no spend', async () => {
  const broken = {
    id: 'broken',
    simulated: false,
    available: async () => true,
    generate: async () => { throw new Error('model unreachable'); }
  };
  const outcome = await runWorkload({
    plan: classifyJobs(4),
    backend: broken,
    identity,
    costPerSession: 5,
    budget: 100,
    ledgerPath: tempLedger()
  });

  assert.equal(outcome.failed, 4);
  assert.equal(outcome.completed, 0);
  // Nothing was produced, so nothing is claimed as spend.
  assert.equal(outcome.spend, 0);
});

test('output that fails its own validator is recorded, not counted as clean', async () => {
  const outcome = await runWorkload({
    plan: classifyJobs(3),
    backend: simulatedBackend,      // returns a digest, never a CATEGORY|CONFIDENCE label
    identity,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.completed, 3);
  assert.equal(outcome.invalidOutput, 3, 'the stand-in cannot satisfy the classifier shape');
});

test('every receipt reaches the ledger, including simulated ones', async () => {
  const ledgerPath = tempLedger();
  await runWorkload({
    plan: classifyJobs(5),
    backend: simulatedBackend,
    identity,
    ledgerPath
  });

  const totals = ledgerTotals(ledgerPath);
  assert.equal(totals.receiptsOnDisk, 5);
  assert.equal(totals.simulated, 5);
  // Recorded as history, counted as nothing.
  assert.equal(totals.counted, 0);
  assert.equal(totals.spendFlop, 0);
});

test('concurrency never exceeds the number of jobs', async () => {
  const outcome = await runWorkload({
    plan: classifyJobs(1),
    backend: simulatedBackend,
    identity,
    concurrency: 8,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.concurrency, 1);
});

test('jobs really do overlap rather than running one at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = {
    id: 'slow',
    simulated: true,
    available: async () => true,
    async generate() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: 'ok', modelId: 'slow', parameters: null };
    }
  };

  await runWorkload({
    plan: classifyJobs(6),
    backend: slow,
    identity,
    concurrency: 3,
    ledgerPath: tempLedger()
  });

  assert.equal(peak, 3, `expected 3 sessions in flight at once, saw ${peak}`);
});

test('the backend decides its own concurrency ceiling', async () => {
  // One local GPU is not four GPUs. A backend that says so is believed.
  const single = { ...simulatedBackend, maxConcurrency: 1 };
  const outcome = await runWorkload({
    plan: classifyJobs(4),
    backend: single,
    identity,
    ledgerPath: tempLedger()
  });
  assert.equal(outcome.concurrency, 1);
});

test('a deadline stops the run and says so', async () => {
  let clock = 0;
  const outcome = await runWorkload({
    plan: classifyJobs(10),
    backend: simulatedBackend,
    identity,
    concurrency: 1,
    deadlineMs: 100,
    ledgerPath: tempLedger(),
    // Each call advances 40ms, so the deadline trips partway through.
    now: () => (clock += 40)
  });

  assert.equal(outcome.stoppedBecause, 'deadline');
  assert.ok(outcome.completed < 10, 'the deadline must actually stop work');
});

test('a burst with nothing to do runs nothing and says why', async () => {
  const outcome = await runBurst({ state: {}, backend: simulatedBackend, identity, ledgerPath: tempLedger() });
  assert.equal(outcome.planned, 0);
  assert.equal(outcome.stoppedBecause, 'nothing to do');
  assert.equal(outcome.spend, 0);
});

test('a burst plans from state and spends within budget', async () => {
  const outcome = await runBurst({
    state: {
      sourceChange: { changes: [{ id: 'openapi', was: 'a', now: 'b' }] },
      unclassified: Array.from({ length: 30 }, (_, i) => ({ text: `m${i}`, room: 'lobby' }))
    },
    backend: simulatedBackend,
    identity,
    budget: 12,
    costPerSession: 4,
    ledgerPath: tempLedger()
  });

  assert.equal(outcome.scheduled, 3);
  assert.equal(outcome.spend, 12);
  // The perishable source-change summary must have made the cut.
  assert.equal(outcome.receipts[0].request.task, 'summarise-source-change');
});

test('the runner refuses to start without a backend', async () => {
  await assert.rejects(() => runWorkload({ plan: classifyJobs(1), identity }), /needs a backend/);
});

test('the default concurrency is conservative', () => {
  // Bursts share one machine and, for now, one local model server.
  assert.ok(DEFAULT_CONCURRENCY >= 1 && DEFAULT_CONCURRENCY <= 4);
});

test('genuine counters exclude simulated work, which is what reaches the shared total', async () => {
  // The daemon feeds genuineSessions/genuineSpend into the cross-machine record.
  // If simulated runs leaked into that figure, a machine with no model installed
  // would silently inflate the number the airdrop is scored on.
  const outcome = await runWorkload({
    plan: classifyJobs(5),
    backend: simulatedBackend,
    identity,
    costPerSession: 3,
    budget: 100,
    ledgerPath: tempLedger()
  });

  assert.equal(outcome.completed, 5, 'the loop did run');
  assert.equal(outcome.genuineSessions, 0, 'but none of it counts as work');
  assert.equal(outcome.genuineSpend, 0);
});

test('an empty burst still reports the counters the shared record reads', async () => {
  // Missing fields would record NaN into a cumulative total on the server.
  const outcome = await runBurst({ state: {}, backend: simulatedBackend, identity, ledgerPath: tempLedger() });
  assert.equal(outcome.genuineSessions, 0);
  assert.equal(outcome.genuineSpend, 0);
  assert.ok(Number.isFinite(outcome.genuineSessions));
  assert.ok(Number.isFinite(outcome.genuineSpend));
});

test('classification keys on the template, so one spam campaign costs one session', async () => {
  const { jobKey } = await import('../src/workload.mjs');

  // The real pattern our template analysis found: one opening phrase repeated
  // 55-64 times across four rooms, differing only in identifiers.
  const campaign = Array.from({ length: 50 }, (_, i) => ({
    room: 'lobby',
    text: `FLOP fleet presence did:key:z6Mk${i}aaaa | note /kv/did-c${i}/1111${i}`
  }));
  const keys = new Set(campaign.map((m) => jobKey('classify-message', m)));
  assert.equal(keys.size, 1, 'fifty instances of one template must cost one classification');

  // A genuine question must not collapse into the campaign.
  const question = { room: 'lobby', text: 'Has anyone actually seen the faucet go live?' };
  assert.notEqual(jobKey('classify-message', question), [...keys][0]);
});

test('a seen-set stops the planner re-doing work across cycles', async () => {
  const { planWorkload } = await import('../src/workload.mjs');
  const messages = Array.from({ length: 5 }, (_, i) => ({
    room: 'lobby',
    text: `a genuinely distinct message number ${i} about validators and staking`
  }));

  const seen = new Set();
  const first = planWorkload({ unclassified: messages, seen });
  assert.equal(first.length, 5);

  // Simulate the burst marking them done.
  const { jobKey } = await import('../src/workload.mjs');
  for (const job of first) seen.add(jobKey(job.taskId, job.input));

  const second = planWorkload({ unclassified: messages, seen });
  assert.equal(second.length, 0, 'the same messages must not be planned twice');

  // A new message still gets through.
  const third = planWorkload({
    unclassified: [...messages, { room: 'lobby', text: 'a brand new observation about halving schedules' }],
    seen
  });
  assert.equal(third.length, 1);
});

test('without a seen-set the planner behaves as it always did', async () => {
  const { planWorkload } = await import('../src/workload.mjs');
  const messages = Array.from({ length: 3 }, (_, i) => ({ room: 'lobby', text: `distinct message ${i} validators` }));
  assert.equal(planWorkload({ unclassified: messages }).length, 3);
  assert.equal(planWorkload({ unclassified: messages }).length, 3);
});

/**
 * The seen-set used to live only in memory. Seven restarts appear in one day of
 * audit log, and each one made the agent forget everything it had done and
 * re-classify whatever the next room read returned. Free with a simulated
 * backend; the airdrop budget, once a session costs $FLOP.
 */
test('what has been done survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-seen-'));
  const file = path.join(dir, 'seen-work.json');

  const before = new Set(['job-a', 'job-b', 'job-c']);
  assert.equal(saveSeen(before, file).saved, true);

  // A new process, with nothing but the file.
  const after = loadSeen(file);
  assert.deepEqual([...after], ['job-a', 'job-b', 'job-c']);
});

test('a corrupt seen-file costs repeated work, never the daemon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-seen-'));
  const file = path.join(dir, 'seen-work.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const seen = loadSeen(file);
  assert.equal(seen.size, 0, 'an unreadable cache reads as empty rather than throwing');
  assert.equal(loadSeen(path.join(dir, 'absent.json')).size, 0);
});

test('the persisted set is capped, keeping the newest keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-seen-'));
  const file = path.join(dir, 'seen-work.json');

  const seen = new Set(Array.from({ length: 50 }, (_, i) => `job-${i}`));
  saveSeen(seen, file, { cap: 10 });

  const loaded = [...loadSeen(file, { cap: 10 })];
  assert.equal(loaded.length, 10);
  assert.equal(loaded[0], 'job-40', 'the oldest keys were dropped, not the newest');
  assert.equal(loaded.at(-1), 'job-49');
});

/**
 * explain-measurement was the one task pushed without a seen-check. It never
 * showed up because nothing passed it a series — the moment the daemon did, it
 * would have re-run every cycle forever against a series that only moves once
 * a day.
 */
test('a measurement is explained once, not every cycle until it changes', () => {
  const series = Array.from({ length: 6 }, (_, i) => ({ at: `2026-08-2${i}`, sharded_did_estimate: 1000 + i }));
  const seen = new Set();

  const first = planWorkload({ measurements: series, seen });
  assert.equal(first.filter((j) => j.taskId === 'explain-measurement').length, 1);
  for (const job of first) seen.add(jobKey(job.taskId, job.input));

  const second = planWorkload({ measurements: series, seen });
  assert.equal(second.filter((j) => j.taskId === 'explain-measurement').length, 0, 'the same series is not re-explained');

  // A new observation is new work, which is exactly when it is worth having.
  const grown = [...series, { at: '2026-08-27', sharded_did_estimate: 1006 }];
  const third = planWorkload({ measurements: grown, seen });
  assert.equal(third.filter((j) => j.taskId === 'explain-measurement').length, 1);
});
