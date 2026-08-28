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
 * The requestIds already on disk, per ledger file, with the byte offset they
 * were read up to.
 *
 * The duplicate check used to re-read and re-parse the entire ledger on every
 * single append. That is O(n) per write and therefore O(n²) over a run, and it
 * was measured doing real damage: at 10,845 receipts one read cost 81 ms, so a
 * cycle scheduling fifteen sessions spent 1.2 s re-parsing history it had itself
 * just written. Extrapolated at the observed 8 MB/day, that check alone would
 * have consumed the whole per-cycle inference deadline in about three weeks —
 * the agent would have starved on its own bookkeeping without a single error.
 *
 * Keyed by resolved path so two ledgers in one process cannot share an index.
 */
const indexCache = new Map();

/**
 * Bring the cached id set up to date with the file, reading only what is new.
 *
 * Another process may be appending to the same ledger — a cloud run and a home
 * PC both write receipts — so this reads the tail rather than trusting the
 * cache. If the file shrank it was rotated or compacted, and the index is
 * rebuilt from scratch.
 */
function loadIndex(ledgerPath) {
  const key = path.resolve(ledgerPath);
  let entry = indexCache.get(key);
  const size = fs.existsSync(ledgerPath) ? fs.statSync(ledgerPath).size : 0;

  if (!entry || size < entry.offset) {
    entry = { offset: 0, ids: new Set() };
    indexCache.set(key, entry);
  }
  if (size === entry.offset) return entry;

  // Read only the bytes appended since we last looked. Appends are
  // leading-newline, so this chunk begins at a record boundary.
  const fd = fs.openSync(ledgerPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(size - entry.offset);
    fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { entry.ids.add(JSON.parse(line).requestId); } catch { /* a torn line is not an id */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  entry.offset = size;
  return entry;
}

/** Forget every cached index. Tests write ledgers behind our back; nothing else needs this. */
export function resetLedgerIndex() {
  indexCache.clear();
}

/**
 * Append one receipt, unless its requestId is already present.
 *
 * Returns what happened, because "already recorded" is a normal outcome the
 * caller may want to log rather than an error.
 */
export function appendReceipt(receipt, ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!receipt?.requestId) throw new Error('a receipt needs a requestId to be ledgered');

  const index = loadIndex(ledgerPath);
  if (index.ids.has(receipt.requestId)) {
    return { appended: false, reason: 'duplicate requestId' };
  }

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // The newline goes first, not last: a process killed between the write and a
  // trailing newline would otherwise leave the next append glued to a partial
  // line. Leading-newline appends make a truncated tail cost one record, not two.
  const line = (index.offset > 0 ? '\n' : '') + JSON.stringify(receipt);
  fs.appendFileSync(ledgerPath, line, 'utf8');
  index.ids.add(receipt.requestId);
  index.offset += Buffer.byteLength(line, 'utf8');
  return { appended: true };
}

/** Where the count of deliberately discarded rehearsal receipts is kept. */
export function compactionRecordPath(ledgerPath = DEFAULT_LEDGER_PATH) {
  return `${ledgerPath}.compaction.json`;
}

function readCompactionRecord(ledgerPath) {
  try {
    return JSON.parse(fs.readFileSync(compactionRecordPath(ledgerPath), 'utf8'));
  } catch {
    return { simulatedDropped: 0, compactions: [] };
  }
}

/**
 * Bound the file without ever discarding evidence.
 *
 * Rule 3 says simulated receipts are stored but never counted. Kept literally
 * that made the ledger grow forever out of records that can never support a
 * claim: 10,845 receipts and 9.5 MB in 27 hours, every one of them simulated,
 * every one of them rejected by `isEvidenceOfWork`. Disk spent to prove nothing.
 *
 * So the rule gains a bound. Every receipt that is or could become evidence is
 * kept unconditionally — a genuine receipt is the asset this project exists to
 * accumulate and nothing here may drop one. Rehearsal receipts keep a recent
 * window, enough to debug the runner and see what it has been doing.
 *
 * What was discarded is written down. A ledger that silently shrinks is exactly
 * the "number that looks like a number" this module was built against, so the
 * running count of dropped rehearsals is kept beside the file and reported in
 * the totals. The claim stays checkable: receipts on disk plus rehearsals
 * discarded equals everything that ever happened.
 */
export function compactLedger(ledgerPath = DEFAULT_LEDGER_PATH, { keepSimulated = 500 } = {}) {
  if (!fs.existsSync(ledgerPath)) return { compacted: false, reason: 'no ledger' };

  const { receipts, malformed } = readLedger(ledgerPath);
  const simulated = receipts.filter((r) => r.simulated === true);
  if (simulated.length <= keepSimulated) {
    return { compacted: false, reason: 'nothing to drop', simulated: simulated.length };
  }

  // Order is preserved for everything kept, so the file still reads as history.
  const drop = new Set(simulated.slice(0, simulated.length - keepSimulated));
  const kept = receipts.filter((r) => !drop.has(r));

  const record = readCompactionRecord(ledgerPath);
  record.simulatedDropped = (record.simulatedDropped || 0) + drop.size;
  record.compactions = [...(record.compactions || []), {
    at: new Date().toISOString(),
    dropped: drop.size,
    keptSimulated: keepSimulated,
    keptTotal: kept.length,
    malformedDiscarded: malformed
  }].slice(-20);

  // Temp-then-rename: a crash mid-compaction must leave the old ledger intact,
  // never a half-written one. The evidence is not reconstructible.
  const temp = `${ledgerPath}.compacting`;
  fs.writeFileSync(temp, kept.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  fs.renameSync(temp, ledgerPath);
  fs.writeFileSync(compactionRecordPath(ledgerPath), JSON.stringify(record, null, 2), 'utf8');
  indexCache.delete(path.resolve(ledgerPath));

  return { compacted: true, dropped: drop.size, kept: kept.length, simulatedDropped: record.simulatedDropped };
}

/**
 * Compact only when the file has actually grown enough to matter.
 *
 * Called every cycle, so the common case must cost one `stat` and nothing else.
 */
export function compactIfLarge(ledgerPath = DEFAULT_LEDGER_PATH, { maxBytes = 4 * 1024 * 1024, keepSimulated = 500 } = {}) {
  if (!fs.existsSync(ledgerPath)) return { compacted: false, reason: 'no ledger' };
  if (fs.statSync(ledgerPath).size <= maxBytes) return { compacted: false, reason: 'below threshold' };
  return compactLedger(ledgerPath, { keepSimulated });
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
    // Rehearsal receipts compaction removed. Reported so "receipts on disk" is
    // never mistaken for "everything that ever happened".
    simulatedDropped: readCompactionRecord(ledgerPath).simulatedDropped || 0,
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
      simulatedDropped: totals.simulatedDropped,
      failed: totals.failed,
      signatureRejected: totals.signatureRejected,
      duplicates: totals.duplicates,
      malformedLines: totals.malformedLines
    },
    note: 'Only signed receipts that verify against their own DID and ran a real model are counted. '
      + 'Simulated runs are kept as history and excluded from every total.'
  };
}
