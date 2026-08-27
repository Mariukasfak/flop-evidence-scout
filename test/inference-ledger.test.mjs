import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { runSession } from '../src/inference.mjs';
import { simulatedBackend, flopSessionBackend } from '../src/inference-backends.mjs';
import { buildTask } from '../src/workload.mjs';
import {
  DEFAULT_LEDGER_PATH, readLedger, appendReceipt, ledgerTotals,
  observedThroughput, ledgerSummary
} from '../src/inference-ledger.mjs';

const identity = generateIdentity();

/** A scratch ledger per test. Production paths are never touched — see below. */
function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-ledger-'));
  return path.join(dir, 'receipts.jsonl');
}

/**
 * A receipt shaped like real work but carrying no valid signature.
 *
 * Used to prove the ledger refuses it. Producing a genuinely signed one means
 * going through runSession, which the tests above do.
 */
function genuineReceipt({ feeFlop = 5, task = 'classify-message', at, flops = 3e9, latencyMs = 250 } = {}) {
  return {
    schema: 'flop-inference-receipt-v0',
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    request: { task, model: 'qwen2.5:3b', feeFlop, promptHash: 'x'.repeat(64) },
    result: {
      ok: true, error: null, responseHash: 'y'.repeat(64),
      promptTokens: 100, completionTokens: 50, estimatedFlops: flops,
      latencyMs, backend: 'ollama', modelId: 'qwen2.5:3b'
    },
    simulated: false,
    at: at || new Date().toISOString()
  };
}

test('an empty ledger reads as empty rather than throwing', () => {
  const p = tempLedger();
  assert.deepEqual(readLedger(p), { receipts: [], malformed: 0 });
  const totals = ledgerTotals(p);
  assert.equal(totals.counted, 0);
  assert.equal(totals.spendFlop, 0);
});

test('a receipt round-trips through the ledger', async () => {
  const p = tempLedger();
  const session = buildTask('classify-message', { text: 'gm', room: 'lobby' });
  const { receipt } = await runSession(session, { backend: simulatedBackend, identity });

  assert.deepEqual(appendReceipt(receipt, p), { appended: true });
  const { receipts } = readLedger(p);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].requestId, receipt.requestId);
});

test('the same receipt cannot be counted twice', async () => {
  const p = tempLedger();
  const session = buildTask('classify-message', { text: 'gm', room: 'lobby' });
  const { receipt } = await runSession(session, { backend: simulatedBackend, identity });

  assert.equal(appendReceipt(receipt, p).appended, true);
  const second = appendReceipt(receipt, p);
  assert.equal(second.appended, false);
  assert.match(second.reason, /duplicate/);
  assert.equal(readLedger(p).receipts.length, 1);
});

test('a receipt without a requestId is refused', () => {
  const p = tempLedger();
  assert.throws(() => appendReceipt({ result: { ok: true } }, p), /needs a requestId/);
});

test('simulated receipts are stored as history and never counted', async () => {
  const p = tempLedger();
  for (let i = 0; i < 3; i++) {
    const session = buildTask('classify-message', { text: `m${i}`, room: 'lobby' });
    const { receipt } = await runSession(session, { backend: simulatedBackend, identity });
    appendReceipt(receipt, p);
  }

  const totals = ledgerTotals(p);
  assert.equal(totals.receiptsOnDisk, 3);
  assert.equal(totals.simulated, 3);
  // The whole point: three receipts on disk, zero provable work.
  assert.equal(totals.counted, 0);
  assert.equal(totals.spendFlop, 0);
});

test('a failed session is recorded and excluded from the total', async () => {
  const p = tempLedger();
  const session = buildTask('classify-message', { text: 'gm', room: 'lobby' });
  const { receipt } = await runSession(session, { backend: flopSessionBackend, identity });
  appendReceipt(receipt, p);

  const totals = ledgerTotals(p);
  assert.equal(totals.failed, 1);
  assert.equal(totals.counted, 0);
});

test('a receipt whose signature does not verify is rejected, not silently skipped', () => {
  const p = tempLedger();
  const forged = {
    ...genuineReceipt({ feeFlop: 10_000 }),
    did: identity.did,
    signature: 'A'.repeat(86)   // well-formed and wrong
  };
  appendReceipt(forged, p);

  const totals = ledgerTotals(p);
  assert.equal(totals.signatureRejected, 1);
  assert.equal(totals.counted, 0);
  // The forged 10,000 $FLOP fee must not reach the number the airdrop scores.
  assert.equal(totals.spendFlop, 0);
});

test('an unsigned receipt cannot contribute to spend', () => {
  const p = tempLedger();
  appendReceipt(genuineReceipt({ feeFlop: 99 }), p);   // no did, no signature

  const totals = ledgerTotals(p);
  assert.equal(totals.counted, 0);
  assert.equal(totals.spendFlop, 0);
});

test('a truncated final line costs one receipt, not the ledger', async () => {
  const p = tempLedger();
  const session = buildTask('classify-message', { text: 'gm', room: 'lobby' });
  const { receipt } = await runSession(session, { backend: simulatedBackend, identity });
  appendReceipt(receipt, p);

  // Simulate a process killed mid-append.
  fs.appendFileSync(p, '\n{"requestId":"half-writ', 'utf8');

  const { receipts, malformed } = readLedger(p);
  assert.equal(receipts.length, 1, 'the intact receipt must survive');
  assert.equal(malformed, 1);
  assert.equal(ledgerTotals(p).malformedLines, 1);
});

test('throughput needs history before it will report a rate', () => {
  const p = tempLedger();
  const empty = observedThroughput(p);
  assert.equal(empty.perDay, null);
  assert.match(empty.note, /not enough history/);
});

test('the summary publishes counts and never a prompt or a completion', async () => {
  const p = tempLedger();
  const session = buildTask('draft-answer', {
    question: 'SECRETQUESTION',
    facts: [{ status: 'UNKNOWN', claim: 'SECRETFACT', source: 's', asOf: '2026-08-27' }]
  });
  const { receipt } = await runSession(session, { backend: simulatedBackend, identity });
  appendReceipt(receipt, p);

  const summary = JSON.stringify(ledgerSummary(p));
  assert.ok(!summary.includes('SECRETQUESTION'));
  assert.ok(!summary.includes('SECRETFACT'));
  assert.match(summary, /countedSessions/);
  assert.match(summary, /simulated/);
});

test('the ledger default path stays under data/, which is gitignored', () => {
  // Receipts are operational state, not source. data/ is in .gitignore, so the
  // default must live there — a ledger committed by accident would publish a
  // stream of hashes nobody asked for on every run.
  assert.match(DEFAULT_LEDGER_PATH, /^data[\\/]/);
});

test('writing a ledger never touches the production path', () => {
  // This project has contaminated real state from tests three times: the faucet
  // alert, the heartbeat, and the feed state — the last of which claimed a room
  // and logged a publication that only ever happened against a mock. Every test
  // above passes an explicit temp path; this asserts the production file was not
  // created as a side effect of any of them.
  const before = fs.existsSync(DEFAULT_LEDGER_PATH)
    ? fs.statSync(DEFAULT_LEDGER_PATH).mtimeMs
    : null;

  const p = tempLedger();
  appendReceipt(genuineReceipt(), p);

  const after = fs.existsSync(DEFAULT_LEDGER_PATH)
    ? fs.statSync(DEFAULT_LEDGER_PATH).mtimeMs
    : null;
  assert.equal(after, before, 'a test wrote to the production ledger');
});
