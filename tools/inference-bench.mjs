/**
 * Can this machine actually do inference, and how much?
 *
 * The agent airdrop is scored on inference spend, so "how much work can we push
 * through in ninety days" is a number worth measuring rather than hoping about.
 * This runs the real task set against whatever backend is available, verifies the
 * receipts, and writes the result where the site can read it.
 *
 * It installs nothing. With no model present it runs the simulated backend, says
 * so on every line, and prints what the operator would need to install — the
 * measurement is then explicitly not a measurement of inference.
 *
 * Run: node tools/inference-bench.mjs [--model=qwen2.5:3b] [--runs=3]
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity } from '../src/identity.mjs';
import { runSession, verifyReceipt, isEvidenceOfWork, summariseReceipts, estimateFlops } from '../src/inference.mjs';
import { selectBackend, ollamaBackend } from '../src/inference-backends.mjs';
import { buildTask } from '../src/workload.mjs';

const OUT = path.resolve('docs/measurements/inference.json');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; })
);
const runs = Number(args.runs ?? 3);
const model = args.model;

/** A representative slice of the real workload, not a synthetic prompt. */
const BENCH_TASKS = [
  ['classify-message', { text: 'Has anyone actually seen the faucet go live, or is this all speculation?', room: 'flop-network' }],
  ['summarise-source-change', { sourceId: 'flop-finance', was: '15,900 chars', now: '16,464 chars', addedLinks: ['/teaser/'] }],
  ['explain-measurement', {
    metric: 'sharded_did_estimate',
    series: [
      { at: '2026-08-25T14:00Z', sharded_did_estimate: 13800 },
      { at: '2026-08-25T20:00Z', sharded_did_estimate: 41200 },
      { at: '2026-08-26T02:00Z', sharded_did_estimate: 78400 },
      { at: '2026-08-26T11:45Z', sharded_did_estimate: 115558 }
    ]
  }],
  ['draft-answer', {
    question: 'When is the airdrop and how much will I get?',
    facts: [
      { status: 'REPORTED', claim: 'Genesis airdrop of 3.5bn $FLOP, 20.4% of year-10 supply', source: 'Teaser v0.1', asOf: '2026-08-26' },
      { status: 'UNKNOWN', claim: 'The scoring formula and snapshot date', source: 'Nothing published', asOf: '2026-08-26' }
    ]
  }]
];

async function main() {
  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
  const { backend, real } = await selectBackend(model ? { model } : {});

  console.log(`\nBackend: ${backend.id}${backend.model ? ` (${backend.model})` : ''}`);
  if (!real) {
    console.log('\n  NOT INFERENCE. No local model is reachable, so this run exercises the');
    console.log('  pipeline with a deterministic stand-in. Every receipt below is stamped');
    console.log('  simulated:true and none of it counts as work.\n');
    console.log('  To make this real, the operator installs Ollama and pulls one model:');
    console.log('    https://ollama.com/download   then:  ollama pull qwen2.5:3b');
    console.log('  A 3B model at 4-bit fits comfortably in 6 GB of VRAM.\n');
  } else {
    try {
      const models = await backend.listModels?.();
      if (models?.length) {
        console.log('  Models available: ' + models.map((m) => `${m.name} (${(m.sizeBytes / 1e9).toFixed(1)} GB)`).join(', '));
      }
    } catch { /* listing is a nicety, not a requirement */ }
    console.log();
  }

  const receipts = [];
  const perTask = {};

  for (const [taskId, input] of BENCH_TASKS) {
    const timings = [];
    let validCount = 0;

    for (let i = 0; i < runs; i++) {
      const session = buildTask(taskId, input, model ? { model } : {});
      const { receipt, completion } = await runSession(session, { backend, identity });
      receipts.push(receipt);

      if (receipt.result.ok) {
        timings.push(receipt.result.latencyMs);
        if (session.validate(completion)) validCount++;
      }
    }

    const ok = timings.length;
    const mean = ok ? timings.reduce((a, b) => a + b, 0) / ok : null;
    perTask[taskId] = {
      runs,
      succeeded: ok,
      validOutputs: validCount,
      // A model that answers fast and in the wrong shape is not useful. Both are
      // reported because the failure modes are different problems.
      validShare: ok ? validCount / ok : 0,
      meanLatencyMs: mean,
      minLatencyMs: ok ? Math.min(...timings) : null,
      maxLatencyMs: ok ? Math.max(...timings) : null
    };

    console.log(`  ${taskId.padEnd(26)} ${String(ok).padStart(2)}/${runs} ok  `
      + `${validCount}/${ok || 0} valid shape  `
      // `mean` is legitimately 0 for the simulated backend, and 0 is falsy — the
      // first version of this line reported "no timing" for a successful run.
      + `${mean == null ? 'no timing' : `${Math.round(mean)} ms mean`}`);
  }

  const totals = summariseReceipts(receipts);
  const verified = receipts.filter(verifyReceipt).length;
  const genuine = receipts.filter(isEvidenceOfWork).length;

  console.log(`\n  Receipts        ${receipts.length}`);
  console.log(`  Signature valid ${verified}/${receipts.length}`);
  console.log(`  Count as work   ${genuine}${real ? '' : '  (correct: nothing simulated may count)'}`);

  /**
   * The projection the airdrop model wants: sustained throughput over the
   * testnet. Deliberately conservative — it assumes the measured mean latency
   * holds, one session at a time, with no batching and no concurrency.
   */
  let projection = null;
  if (real && totals.genuine > 0) {
    const meanLatency = totals.meanLatencyMs;
    const sessionsPerDay = (86_400_000 / meanLatency);
    const tokensPerSession = (totals.promptTokens + totals.completionTokens) / totals.genuine;
    projection = {
      meanLatencyMs: meanLatency,
      sessionsPerDaySerial: sessionsPerDay,
      sessionsOver90Days: sessionsPerDay * 90,
      meanTokensPerSession: tokensPerSession,
      estimatedFlopsPerSession: totals.estimatedFlops / totals.genuine,
      note: 'Serial, one session at a time, at the measured mean latency. No batching, no '
        + 'concurrency, no allowance for downtime. A floor, not a target.'
    };
    console.log(`\n  Mean latency          ${Math.round(meanLatency)} ms`);
    console.log(`  Sessions/day (serial) ${Math.round(sessionsPerDay).toLocaleString()}`);
    console.log(`  Over a 90-day testnet ${Math.round(sessionsPerDay * 90).toLocaleString()} sessions`);
    if (totals.estimatedFlops > 0) {
      console.log(`  Estimated compute     ${(totals.estimatedFlops / totals.genuine / 1e9).toFixed(1)} GFLOP per session`);
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    backend: backend.id,
    model: backend.model ?? model ?? null,
    isRealInference: real,
    runsPerTask: runs,
    perTask,
    totals,
    receiptsVerified: verified,
    receiptsCountingAsWork: genuine,
    projection,
    caveat: real
      ? 'Measured on the operator machine. FLOPs are the standard 2 x parameters x tokens estimate, '
        + 'not a hardware counter.'
      : 'NOT A MEASUREMENT OF INFERENCE. No model was reachable; a deterministic stand-in ran instead.'
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWrote ${OUT}\n`);
}

main().catch((err) => {
  console.error('inference bench failed:', err.message);
  process.exit(1);
});
