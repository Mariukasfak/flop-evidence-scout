/**
 * The cheap model does the volume; the better one does the few outputs a
 * stranger reads.
 *
 * The rule this file pins down is not "use the best model available". It is
 * that 99.5% of sessions stay on the local 3B — because they are room text
 * nobody reads twice — and the ~0.5% that are rare, public and judged by a
 * person get the stronger one, without any of them being lost when a free tier
 * answers 429.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runWorkload, STRONG_TASKS } from '../src/workload-runner.mjs';
import { loadOrCreateIdentity } from '../src/identity.mjs';

function fakeBackend(id, { fails = false } = {}) {
  const served = [];
  return {
    id,
    simulated: false,
    maxConcurrency: 1,
    served,
    async available() { return true; },
    async generate({ prompt }) {
      if (fails) throw new Error('api backend rate limited (HTTP 429) — the free tier will refill on its own');
      served.push(prompt);
      return { text: 'ok', modelId: id, promptTokens: 5, completionTokens: 2, parameters: null };
    }
  };
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-tier-'));
  return { dir, ledgerPath: path.join(dir, 'r.jsonl'), identity: loadOrCreateIdentity(path.join(dir, 'id.json')) };
}

const plan = [
  { taskId: 'classify-message', input: { text: 'gm', room: 'lobby' } },
  { taskId: 'classify-message', input: { text: 'hello', room: 'lobby' } },
  { taskId: 'draft-answer', input: { text: 'what is the ring depth?', facts: [] } }
];

test('the volume stays local and only the rare public task takes the better model', async () => {
  const { ledgerPath, identity } = tmp();
  const local = fakeBackend('ollama');
  const strong = fakeBackend('api');

  const out = await runWorkload({ plan, backend: local, strongBackend: strong, identity, ledgerPath });

  assert.equal(out.completed, 3, 'every job must still complete');
  assert.equal(local.served.length, 2, 'both classify-message jobs belong on the local model');
  assert.equal(strong.served.length, 1, 'and exactly the one drafted answer on the better one');
  assert.equal(out.strongServed, 1);
});

test('with no better model configured, nothing changes', async () => {
  const { ledgerPath, identity } = tmp();
  const local = fakeBackend('ollama');

  const out = await runWorkload({ plan, backend: local, identity, ledgerPath });

  assert.equal(out.completed, 3);
  assert.equal(local.served.length, 3, 'all three run exactly where they ran before');
  assert.equal(out.strongServed, undefined);
});

test('a rate-limited better model costs a round trip, never the answer', async () => {
  const { ledgerPath, identity } = tmp();
  const local = fakeBackend('ollama');
  const strong = fakeBackend('api', { fails: true });

  const out = await runWorkload({ plan, backend: local, strongBackend: strong, identity, ledgerPath });

  assert.equal(out.completed, 3, 'the 429 must not lose the job');
  assert.equal(local.served.length, 3, 'the drafted answer falls back to the local model');
  assert.equal(out.strongFailed, 1, 'and the failure is counted, not hidden');

  // The ledger keeps failures on purpose — that is its stated contract — so the
  // wasted attempt is on the record beside the answer that replaced it.
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const failed = lines.filter((r) => r.result.ok === false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].result.backend, 'api');
  assert.match(failed[0].result.error, /429/);
});

test('the strong set is the measured 0.5%, not everything public', () => {
  // kibble-answer and kibble-judge were 507 of the last 2,500 receipts. Routing
  // them would drain a free tier in an afternoon to feed a board whose scorer is
  // half a million messages behind, so they are deliberately excluded.
  assert.ok(!STRONG_TASKS.has('kibble-answer'));
  assert.ok(!STRONG_TASKS.has('kibble-judge'));
  assert.ok(!STRONG_TASKS.has('classify-message'), 'the endless filler must never take the quota');
  assert.ok(STRONG_TASKS.has('draft-answer'));
  assert.ok(STRONG_TASKS.has('summarise-source-change'));
});
