/**
 * The faucet-day rehearsal.
 *
 * On the day the Flop session route is published, the thing that must already
 * work is everything downstream of the request: that the daemon prefers the paid
 * network over the local model without being told twice, that a session against
 * it produces a signed receipt, that the receipt lands in the ledger as genuine
 * rather than simulated, and that the budget stops the burst when the faucet runs
 * dry. None of that can be tested against a route nobody has published — so it is
 * tested against a stand-in that answers on localhost, which exercises the same
 * code path the real one will.
 *
 * What this deliberately does NOT claim: that the request shape matches Flop's
 * spec. It cannot, because there is no spec yet. `flopSessionBackend.generate`
 * is the one function to check on the day; this file is the proof that it is the
 * ONLY one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flopSessionBackend, selectBackend } from '../src/inference-backends.mjs';
import { runSession } from '../src/inference.mjs';
import { appendReceipt, readLedger, ledgerTotals } from '../src/inference-ledger.mjs';
import { loadOrCreateIdentity } from '../src/identity.mjs';
import { buildTask } from '../src/workload.mjs';

/** A stand-in for the network: answers like a session route, and counts the spend. */
async function startStub({ feeFlop = 3 } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      // The availability probe. A real route may well refuse a bare GET; the
      // backend treats anything under 500 as "there", so 405 is the honest reply.
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls += 1;
      const sent = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        text: `answered: ${String(sent.prompt).slice(0, 40)}`,
        model: sent.model,
        prompt_tokens: 11,
        completion_tokens: 7,
        fee_flop: feeFlop,
        session_id: `sess-${calls}`,
        miner: 'miner-stub-1'
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/session`;
  return { url, server, calls: () => calls };
}

function tempIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-rehearsal-'));
  return { dir, identity: loadOrCreateIdentity(path.join(dir, 'id.json')) };
}

test('unconfigured, the backend is exactly as unavailable as it always was', async () => {
  const backend = flopSessionBackend({ url: undefined });
  assert.equal(await backend.available(), false);
  await assert.rejects(
    () => backend.generate({ prompt: 'anything' }),
    /no Flop inference endpoint is configured/i,
    'the refusal must still explain itself, and still name the reason it does not guess a route'
  );
});

test('a configured route is preferred over the local model, without any other change', async () => {
  const stub = await startStub();
  try {
    process.env.FLOP_SESSION_URL = stub.url;
    const { backend, real } = await selectBackend({});
    assert.equal(backend.id, 'flop-session', 'the paid network must outrank Ollama the moment it exists');
    assert.equal(real, true, 'and it must count as real inference, not a simulation');
  } finally {
    delete process.env.FLOP_SESSION_URL;
    stub.server.close();
  }
});

test('a session against the route produces a genuine, verifiable receipt', async () => {
  const stub = await startStub();
  const { identity } = tempIdentity();
  try {
    const backend = flopSessionBackend({ url: stub.url, model: 'flop-test' });
    const session = buildTask('classify-message', 'a message to classify');
    const { receipt, error } = await runSession(session, { backend, identity });

    assert.equal(error, null, 'the session must succeed against a route that answers');
    assert.ok(receipt, 'and it must produce a receipt');
    assert.equal(receipt.result.ok, true);
    assert.equal(receipt.result.backend, 'flop-session', 'the receipt must name who served it');
    assert.equal(receipt.simulated, false, 'and must not be marked simulated');
    // The receipt keeps a hash and a length, never the text — deliberately, so a
    // published receipt leaks nothing. So the round trip is checked by size.
    assert.ok(receipt.result.responseChars > 0, 'the reply must have survived the round trip');
    assert.equal(receipt.result.promptTokens, 11, "the route's own token counts must be used, not our estimate");
    assert.equal(receipt.result.completionTokens, 7);
    assert.equal(stub.calls(), 1, 'exactly one session, one charge');
  } finally {
    stub.server.close();
  }
});

test('the receipt reaches the ledger as spend, which is the number the allocation is read from', async () => {
  const stub = await startStub();
  const { dir, identity } = tempIdentity();
  const ledgerPath = path.join(dir, 'receipts.jsonl');
  try {
    const backend = flopSessionBackend({ url: stub.url, model: 'flop-test' });
    // The fee the caller books for the session. On the day this is the faucet's
    // real price per session rather than the placeholder zero.
    const session = buildTask('classify-message', 'another message', { feeFlop: 3 });
    const { receipt } = await runSession(session, { backend, identity });
    appendReceipt(receipt, ledgerPath);

    const { receipts } = readLedger(ledgerPath);
    assert.equal(receipts.length, 1, 'the receipt must be on disk, not only in memory');

    const totals = ledgerTotals(ledgerPath);
    assert.equal(totals.spendFlop, 3, 'spend must accumulate from the fee actually booked');
    assert.ok(totals.simulated === 0 || totals.simulated === undefined,
      'nothing here may be counted as a simulated session');
  } finally {
    stub.server.close();
  }
});

test('what the network says it charged is carried, so it can be reconciled against our own estimate', async () => {
  const stub = await startStub({ feeFlop: 7 });
  const { identity } = tempIdentity();
  try {
    const backend = flopSessionBackend({ url: stub.url });

    // Asserted at the backend, not at the receipt, and that is the finding: the
    // receipt schema has nowhere to put a fee the network reports. Booked 3,
    // charged 7 — a gap that would otherwise surface only as a wrong total after
    // ninety days. The backend surfaces the figure; deciding whether the ledger
    // should carry it, or reconcile against it, is a faucet-day call that needs
    // the published spec, so it is recorded here rather than guessed at now.
    const out = await backend.generate({ prompt: 'reconcile me', request: { maxLatencyMs: 60_000 } });
    assert.equal(out.raw.reportedFeeFlop, 7, "the miner's own figure must not be dropped on the floor");
    assert.ok(out.raw.sessionId, 'nor the session id that would let anyone check it');

    const session = buildTask('classify-message', 'reconcile me', { feeFlop: 3 });
    const { receipt } = await runSession(session, { backend, identity });
    assert.equal(receipt.request.feeFlop, 3, 'what we booked is what the ledger counts, for now');
  } finally {
    stub.server.close();
  }
});

test('concurrency is not Ollama\'s one, because the network is many machines', () => {
  assert.ok(flopSessionBackend({ url: 'http://x' }).maxConcurrency > 1,
    'a single-card ceiling against a network of miners would leave the faucet unspent');
});
