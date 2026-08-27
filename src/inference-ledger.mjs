/**
 * The running total of inference actually performed, kept where a restart cannot
 * lose it.
 *
 * The teaser scores the agent cohort on what it spends on inference across a
 * ninety-day testnet. That makes the cumulative total the single most important
 * number this project will ever hold — and until now it existed only as an array
 * in memory, recomputed from whatever receipts happened to be in scope.
 *
 * This project has already been bitten by exactly that. The daemon is destroyed
 * every fifteen minutes, and for weeks its turn counter silently restarted at one
 * because state was being written to a key the server rejected. A spend total
 * that resets is worse than no total: it looks like a number.
 *
 * Three rules:
 *
 *   1. Verify on read, never trust on write. A ledger nobody can check is a
 *      claim. Every signature is re-verified when totals are computed, and a
 *      receipt that fails is counted as rejected rather than skipped quietly.
 *   2. Idempotent by requestId. A restart mid-write, or a replayed queue, must
 *      not inflate the total. Appending the same receipt twice is a no-op.
 *   3. Simulated receipts are stored but never counted. They are useful history
 *      and they are not work.
 *
 * The file is JSON Lines: append-only, survives a truncated final line, and can
 * be read by anyone with `tail`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { verifyReceipt, isEvidenceOfWork } from './inference.mjs';

export const DEFAULT_LEDGER_PATH = path.join('data', 'inference-receipts.jsonl');

/**
 * Read every receipt on disk.
 *
 * A malformed line is reported, not thrown on. The common cause is a process
 * killed mid-append, which costs one receipt and must not cost the ledger.
 */
export function readLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!fs.existsSync(ledgerPath)) return { receipts: [], malformed: 0 };

  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
  const receipts = [];
  let malformed = 0;

  for (const line of lines) {
    try {
      receipts.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { receipts, malformed };
}

/**
 * Append one receipt, unless its requestId is already present.
 *
 * Returns what happened, because "already recorded" is a normal outcome the
 * caller may want to log rather than an error.
 */
export function appendReceipt(receipt, ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!receipt?.requestId) throw new Error('a receipt needs a requestId to be ledgered');

  const { receipts } = readLedger(ledgerPath);
  if (receipts.some((r) => r.requestId === receipt.requestId)) {
    return { appended: false, reason: 'duplicate requestId' };
  }

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // The newline goes first, not last: a process killed between the write and a
  // trailing newline would otherwise leave the next append glued to a partial
  // line. Leading-newline appends make a truncated tail cost one record, not two.
  const prefix = fs.existsSync(ledgerPath) && fs.statSync(ledgerPath).size > 0 ? '\n' : '';
  fs.appendFileSync(ledgerPath, prefix + JSON.stringify(receipt), 'utf8');
  return { appended: true };
}

/**
 * The totals, with every signature re-checked.
 *
 * `spendFlop` is the figure the airdrop is scored on. It counts only receipts
 * that are signed, verify against their own DID, ran a real model, and succeeded.
 * Everything else is reported separately so the gap between "receipts we hold"
 * and "work we can prove" is always visible rather than averaged away.
 */
export function ledgerTotals(ledgerPath = DEFAULT_LEDGER_PATH) {
  const { receipts, malformed } = readLedger(ledgerPath);

  const seen = new Set();
  const totals = {
    receiptsOnDisk: receipts.length,
    malformedLines: malformed,
    duplicates: 0,
    simulated: 0,
    failed: 0,
    signatureRejected: 0,
    counted: 0,
    spendFlop: 0,
    estimatedFlops: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMsTotal: 0,
    firstAt: null,
    lastAt: null,
    byTask: {}
  };

  for (const receipt of receipts) {
    if (seen.has(receipt.requestId)) { totals.duplicates++; continue; }
    seen.add(receipt.requestId);

    if (receipt.simulated === true) { totals.simulated++; continue; }
    if (receipt?.result?.ok === false) { totals.failed++; continue; }

    // A receipt that does not verify is not evidence, whoever wrote it.
    if (!verifyReceipt(receipt) || !isEvidenceOfWork(receipt)) {
      totals.signatureRejected++;
      continue;
    }

    totals.counted++;
    totals.spendFlop += receipt.request?.feeFlop || 0;
    totals.estimatedFlops += receipt.result?.estimatedFlops || 0;
    totals.promptTokens += receipt.result?.promptTokens || 0;
    totals.completionTokens += receipt.result?.completionTokens || 0;
    totals.latencyMsTotal += receipt.result?.latencyMs || 0;

    const task = receipt.request?.task || 'unknown';
    totals.byTask[task] = (totals.byTask[task] || 0) + 1;

    if (!totals.firstAt || receipt.at < totals.firstAt) totals.firstAt = receipt.at;
    if (!totals.lastAt || receipt.at > totals.lastAt) totals.lastAt = receipt.at;
  }

  totals.meanLatencyMs = totals.counted ? totals.latencyMsTotal / totals.counted : null;
  return totals;
}

/**
 * Sessions per day, measured rather than projected.
 *
 * The airdrop model's one controllable lever is our multiple of the average
 * agent's spend, and under a refilling faucet that is throughput times uptime.
 * This reports the throughput half from what actually happened, so the claim is
 * grounded in the ledger instead of in a benchmark run under ideal conditions.
 */
export function observedThroughput(ledgerPath = DEFAULT_LEDGER_PATH) {
  const totals = ledgerTotals(ledgerPath);
  if (!totals.firstAt || !totals.lastAt || totals.counted < 2) {
    return { sessions: totals.counted, elapsedHours: 0, perDay: null, note: 'not enough history yet' };
  }

  const elapsedMs = Date.parse(totals.lastAt) - Date.parse(totals.firstAt);
  const elapsedHours = elapsedMs / 3_600_000;
  if (elapsedHours <= 0) {
    return { sessions: totals.counted, elapsedHours: 0, perDay: null, note: 'all receipts share a timestamp' };
  }

  return {
    sessions: totals.counted,
    elapsedHours,
    perDay: (totals.counted / elapsedHours) * 24,
    /**
     * Wall-clock, not busy-time. If the agent was idle for most of the window
     * this understates capacity and overstates realised throughput — which is
     * the honest direction, because the airdrop scores realised spend.
     */
    note: 'Wall-clock rate across the whole ledger window, including idle time.'
  };
}

/**
 * A publishable summary. Hashes and counts only — no prompts, no completions.
 *
 * Safe to post to a room or commit to the repository, which is the point: the
 * spend total is the claim this project will eventually make, and it should be
 * checkable by a stranger the whole way along rather than announced at the end.
 */
export function ledgerSummary(ledgerPath = DEFAULT_LEDGER_PATH) {
  const totals = ledgerTotals(ledgerPath);
  const throughput = observedThroughput(ledgerPath);

  return {
    generatedAt: new Date().toISOString(),
    countedSessions: totals.counted,
    spendFlop: totals.spendFlop,
    estimatedFlops: totals.estimatedFlops,
    tokens: totals.promptTokens + totals.completionTokens,
    meanLatencyMs: totals.meanLatencyMs,
    sessionsPerDay: throughput.perDay,
    window: { from: totals.firstAt, to: totals.lastAt },
    byTask: totals.byTask,
    excluded: {
      simulated: totals.simulated,
      failed: totals.failed,
      signatureRejected: totals.signatureRejected,
      duplicates: totals.duplicates,
      malformedLines: totals.malformedLines
    },
    note: 'Only signed receipts that verify against their own DID and ran a real model are counted. '
      + 'Simulated runs are kept as history and excluded from every total.'
  };
}
