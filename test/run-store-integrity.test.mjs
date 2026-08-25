import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RunStore } from '../src/core/run-store.mjs';
import { EVENT_TYPES } from '../src/core/contracts.mjs';

// Regresiniai testai prideliniam zurnalui. Kiekvienas ju atitinka realiai atkurta klaida.
describe('RunStore integrity', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'triagent-integrity-'));
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test('two stores writing one run never reuse a sequence number', async () => {
    const runId = 'shared-run';
    const first = new RunStore(root);
    const second = new RunStore(root);

    first.createRun(runId);
    first.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId: 'codex' });
    second.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId: 'claude' });
    first.appendEvent(runId, { type: EVENT_TYPES.CRITIQUE, agentId: 'codex' });
    second.appendEvent(runId, { type: EVENT_TYPES.FINAL, agentId: 'claude' });

    const events = await second.readEvents(runId);
    const sequences = events.map((event) => event.seq);
    assert.deepStrictEqual(sequences, [1, 2, 3, 4, 5]);
    assert.strictEqual(new Set(sequences).size, sequences.length);

    // SSE srautas rodo tik didejancius numerius, tad dublikatas tyliai dingtu is narsykles.
    let lastSeq = 0;
    const delivered = events.filter((event) => {
      if (event.seq <= lastSeq) return false;
      lastSeq = event.seq;
      return true;
    });
    assert.strictEqual(delivered.length, events.length, 'no event may be dropped by the SSE filter');
  });

  test('a non-numeric seq in the last record fails loudly instead of restarting at 1', () => {
    const runId = 'corrupt-seq';
    fs.writeFileSync(
      path.join(root, `${runId}.jsonl`),
      `${JSON.stringify({ type: EVENT_TYPES.RUN_CREATED, seq: 'penki' })}\n`
    );
    const store = new RunStore(root);
    assert.throws(
      () => store.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId: 'codex' }),
      /invalid seq/
    );
  });

  test('falsy agent ids are rejected rather than silently stored', () => {
    const runId = 'falsy-agent';
    const store = new RunStore(root);
    store.createRun(runId);

    for (const agentId of ['', 0, null]) {
      assert.throws(
        () => store.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId }),
        /Invalid agentId/,
        `agentId ${JSON.stringify(agentId)} must be rejected`
      );
    }

    // Ivykis be agentId lauko lieka teisetas.
    assert.doesNotThrow(() => store.appendEvent(runId, { type: EVENT_TYPES.RUN_COMPLETED }));
  });
});
