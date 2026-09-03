#!/usr/bin/env node
/**
 * Rebuild the attestor→worker budget from the room's own tape.
 *
 * The budget book (kibble-pairs.mjs) is written forward from the moment it
 * exists, but this validator had already spent its useful verdicts long before
 * — 957 of them by 2026-09-03, against a cap of two per worker. Starting from
 * an empty book would re-endorse the same handful of workers a third and
 * fourth time and score nothing for it, which is the exact failure the book was
 * added to stop.
 *
 * So the book is seeded from `/r/kibble/export`, which is the authority anyway:
 * the scorer recomputes from that same tape. The export is a ring — it held
 * 2h50m when this was written — so it recovers only what is still retained.
 * That is a floor, not a total, and a floor is the safe direction: it can only
 * retire a worker we really did endorse.
 *
 * Run it after any loss of data/local, or whenever the counts look wrong:
 *
 *   node tools/kibble-pairs-backfill.mjs
 *   node tools/kibble-pairs-backfill.mjs --dry-run
 *   node tools/kibble-pairs-backfill.mjs --file=some-earlier-export.ndjson
 *
 * `--file` exists because the ring is short and moves fast: the export read at
 * 04:57Z held 2h50m, the one read nine minutes later held 1h24m. An export
 * saved earlier still carries verdicts the live tape has already dropped, and
 * since counts only ever move up, replaying old exports is safe in any order.
 */

import fs from 'node:fs';
import { loadPairs, savePairs, pairSummary, usefulBudgetLeft } from '../src/kibble-pairs.mjs';

const ROOM_EXPORT = 'https://technocore.chat/r/kibble/export';
const PAIRS_PATH = 'data/local/kibble-useful-pairs.json';
const VALIDATOR = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const WORKER = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';

const dryRun = process.argv.includes('--dry-run');
const fromFile = (process.argv.find((a) => a.startsWith('--file=')) || '').slice('--file='.length);

const verb = (t) => (String(t).match(/^([A-Z][A-Z0-9_-]{2,15})\b/) || [, ''])[1];
const jobId = (t) => (String(t).match(/\|\s*(k[0-9a-f]{10})\s*\|/) || [])[1];
const verdictOf = (t) => (String(t).split('|')[2] || '').trim().toLowerCase();

async function main() {
  let text;
  if (fromFile) {
    text = fs.readFileSync(fromFile, 'utf8');
    console.log(`source: ${fromFile}`);
  } else {
    const res = await fetch(ROOM_EXPORT, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`export returned HTTP ${res.status}`);
    text = await res.text();
  }
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  const span = `${rows[0].ts} → ${rows[rows.length - 1].ts}`;
  console.log(`tape: ${rows.length} lines, ${span}`);

  // Group by job so a verdict can be matched to the delivery it judged. On this
  // board a job routinely carries several deliveries, so "the worker we praised"
  // is the one whose delivery came before our line — not simply the first.
  const byJob = new Map();
  for (const row of rows) {
    const id = jobId(row.text);
    if (!id) continue;
    if (!byJob.has(id)) byJob.set(id, []);
    byJob.get(id).push(row);
  }

  const book = loadPairs(PAIRS_PATH);
  const before = pairSummary(book);
  const seen = new Map();          // worker did -> useful verdicts of ours found on this tape
  let praisedUs = 0;

  for (const [, msgs] of byJob) {
    const sorted = msgs.slice().sort((a, b) => a.seq - b.seq);
    for (const line of sorted) {
      if (verb(line.text) !== 'ATTEST') continue;

      // Ours, going out: which worker did it endorse?
      if (line.from === VALIDATOR && verdictOf(line.text) === 'useful') {
        const delivery = sorted.find((m) => m.seq < line.seq
          && (verb(m.text) === 'RESULT' || verb(m.text) === 'DELIVER')
          && m.from !== VALIDATOR && m.from !== WORKER);
        if (delivery) seen.set(delivery.from, (seen.get(delivery.from) || 0) + 1);
        continue;
      }

      // Theirs, coming in: a worker who endorsed us halves our budget for them.
      if (verdictOf(line.text) === 'useful' && line.from !== VALIDATOR && line.from !== WORKER) {
        const oursDelivered = sorted.some((m) => m.seq < line.seq
          && (verb(m.text) === 'RESULT' || verb(m.text) === 'DELIVER')
          && (m.from === WORKER || m.from === VALIDATOR));
        if (oursDelivered) {
          const entry = book.workers.get(line.from) || { given: 0, praisedUs: false };
          if (!entry.praisedUs) praisedUs += 1;
          book.workers.set(line.from, { ...entry, praisedUs: true });
        }
      }
    }
  }

  // The tape is a floor: keep whichever count is higher, so a rebuild after a
  // ring has rolled over cannot hand a retired worker a fresh budget.
  let raised = 0;
  for (const [did, count] of seen) {
    const entry = book.workers.get(did) || { given: 0, praisedUs: false };
    if (count > entry.given) { raised += 1; book.workers.set(did, { ...entry, given: count }); }
  }

  const after = pairSummary(book);
  console.log(`our useful verdicts on this tape: ${[...seen.values()].reduce((a, b) => a + b, 0)}`
    + ` across ${seen.size} workers`);
  console.log(`counts raised: ${raised} | new reciprocal pairs: ${praisedUs}`);
  console.log(`book: ${before.workers} → ${after.workers} workers, `
    + `${after.capped} now out of budget, ${after.reciprocal} reciprocal`);
  for (const [did, count] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  …${did.slice(-8)}  ${count} given, ${usefulBudgetLeft(book, did)} left`);
  }

  if (dryRun) { console.log('--dry-run: nothing written'); return; }
  const saved = savePairs(book, PAIRS_PATH);
  console.log(saved.saved ? `written: ${PAIRS_PATH} (${saved.workers} workers)` : `write failed: ${saved.error}`);
}

main().catch((err) => {
  console.error(`backfill failed: ${err.message}`);
  process.exitCode = 1;
});
