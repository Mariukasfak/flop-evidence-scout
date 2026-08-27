/**
 * The engine that turns an available budget into spent budget.
 *
 * The airdrop scores cumulative inference spend, and the teaser does not say
 * whether the faucet is a one-time grant or refills. That ambiguity usually
 * paralyses a design; here it resolves cleanly, because one behaviour is optimal
 * under both regimes: *spend what you have, as fast as it arrives.*
 *
 *   fixed faucet   the budget arrives once, so drain it and stop
 *   drip faucet    the budget refills, so drain it and keep draining
 *
 * A scheduler driven by remaining budget does both without being told which it
 * is in. That is why this takes a budget rather than a task count.
 *
 * Concurrency is the other half. Without an always-on host the agent runs in
 * bursts, and a burst that issues one session at a time wastes most of its
 * window. Sessions run in parallel up to a limit the backend declares — one
 * local GPU is not four GPUs, and pretending otherwise just queues work inside
 * the model server while the run's clock expires.
 *
 * The hard invariant, tested: this can never spend more than the budget it was
 * given. Everything else here is an optimisation; that one is a promise.
 */

import { runSession } from './inference.mjs';
import { buildTask, planWorkload, TASKS } from './workload.mjs';
import { appendReceipt } from './inference-ledger.mjs';

/**
 * How much a session costs.
 *
 * Nothing published says how a session is priced — the teaser lists a fee field
 * and never a rate. Until the network quotes one, the cost is whatever the caller
 * says it is, and the default of zero means "no budget in play", which is the
 * honest state today.
 */
export const DEFAULT_SESSION_COST = 0;

/** Sessions in flight at once, unless the backend knows better. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * Run a list of jobs with bounded parallelism.
 *
 * A worker pool rather than chunked batches: batching stalls on the slowest job
 * in each chunk, and inference latency varies by more than an order of magnitude
 * between a short classification and a long summary.
 */
async function pool(jobs, limit, worker) {
  const results = new Array(jobs.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      results[index] = await worker(jobs[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Order the plan by what is worth spending a scarce budget on.
 *
 * When budget is abundant the order barely matters — everything runs. When it is
 * scarce the order is the whole decision, so it is explicit rather than emergent
 * from whatever planWorkload happened to append last.
 */
export const TASK_PRIORITY = Object.freeze({
  'summarise-source-change': 1,   // a protocol change decays fastest
  'draft-answer': 2,              // someone is waiting
  'extract-claims': 3,
  'explain-measurement': 4,
  'classify-message': 5           // useful, endless, and the natural filler
});

export function prioritise(plan) {
  return [...plan].sort(
    (a, b) => (TASK_PRIORITY[a.taskId] ?? 99) - (TASK_PRIORITY[b.taskId] ?? 99)
  );
}

/**
 * How many sessions a budget affords.
 *
 * Floor, never round: affording 3.9 sessions means affording 3. A scheduler that
 * rounds up overspends on its last job, which is exactly the bug that would be
 * hardest to notice and worst to have.
 */
export function affordableSessions(budget, costPerSession) {
  if (!(costPerSession > 0)) return Infinity;   // free work is not budget-limited
  if (!(budget > 0)) return 0;
  return Math.floor(budget / costPerSession);
}

/**
 * Run as much of the plan as the budget and the clock allow.
 *
 * Returns what actually happened rather than what was attempted: spend, receipts,
 * validation failures and the reason it stopped. A runner that reports its
 * intentions is how a spend total drifts away from reality.
 */
export async function runWorkload({
  plan = [],
  backend,
  identity,
  budget = Infinity,
  costPerSession = DEFAULT_SESSION_COST,
  concurrency = backend?.maxConcurrency ?? DEFAULT_CONCURRENCY,
  deadlineMs = null,
  model,
  ledgerPath = undefined,
  now = () => Date.now()
} = {}) {
  if (!backend) throw new Error('runWorkload needs a backend');

  const startedAt = now();
  const affordable = affordableSessions(budget, costPerSession);
  const ordered = prioritise(plan);

  // Trim to what is affordable BEFORE running anything. Deciding mid-flight
  // would let concurrent jobs race past the budget between checks.
  const scheduled = Number.isFinite(affordable) ? ordered.slice(0, affordable) : ordered;

  const outcome = {
    planned: plan.length,
    scheduled: scheduled.length,
    completed: 0,
    failed: 0,
    invalidOutput: 0,
    spend: 0,
    receipts: [],
    stoppedBecause: scheduled.length < ordered.length ? 'budget' : 'plan exhausted',
    concurrency: Math.max(1, Math.min(concurrency, Math.max(1, scheduled.length)))
  };

  let deadlineHit = false;

  await pool(scheduled, outcome.concurrency, async (job) => {
    // The deadline is checked per job rather than enforced by aborting one:
    // killing a session in flight still costs the fee without producing a
    // receipt, which is the worst of both.
    if (deadlineMs != null && now() - startedAt >= deadlineMs) {
      deadlineHit = true;
      return null;
    }

    let session;
    try {
      session = buildTask(job.taskId, job.input, {
        ...(model ? { model } : {}),
        feeFlop: costPerSession
      });
    } catch (err) {
      outcome.failed++;
      return null;
    }

    const { receipt, completion } = await runSession(session, { backend, identity, now });

    // Ledger every receipt, including failures and simulated runs. The ledger
    // decides what counts; the runner's job is not to curate the record.
    try {
      appendReceipt(receipt, ledgerPath);
    } catch { /* a ledger write must never lose the run */ }

    outcome.receipts.push(receipt);

    if (receipt.result.ok) {
      outcome.completed++;
      outcome.spend += costPerSession;
      if (!session.validate(completion)) outcome.invalidOutput++;
    } else {
      outcome.failed++;
      // A failed session produced no work. Whether the network still charges for
      // one is unpublished, so it is not counted as spend here and the
      // assumption is recorded rather than buried.
    }
    return receipt;
  });

  if (deadlineHit) outcome.stoppedBecause = 'deadline';
  outcome.elapsedMs = now() - startedAt;
  outcome.spendAssumption = 'Failed sessions are not counted as spend. The teaser does not say '
    + 'whether a failed session is still charged.';

  return outcome;
}

/**
 * One burst: plan the work, then spend the budget on it.
 *
 * This is what a scheduled run calls. It exists so the daemon has a single entry
 * point whose behaviour does not change when the faucet appears — only the
 * budget and the backend do.
 */
export async function runBurst({ state = {}, backend, identity, budget = Infinity, costPerSession = DEFAULT_SESSION_COST, deadlineMs = 10 * 60 * 1000, model, ledgerPath, now } = {}) {
  const plan = planWorkload(state);
  if (plan.length === 0) {
    return { planned: 0, scheduled: 0, completed: 0, failed: 0, invalidOutput: 0, spend: 0, receipts: [], stoppedBecause: 'nothing to do', elapsedMs: 0 };
  }
  return runWorkload({ plan, backend, identity, budget, costPerSession, deadlineMs, model, ledgerPath, now });
}

/** Every task the planner can emit, for callers that want to check coverage. */
export const KNOWN_TASKS = Object.freeze(Object.keys(TASKS));
