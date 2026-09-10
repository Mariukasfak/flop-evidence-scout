import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkload, jobKey } from '../src/workload.mjs';

test('processed source changes do not starve later unprocessed news behind the three-source cap', () => {
  const changes = Array.from({ length: 5 }, (_, n) => ({ id: `source-${n}`, was: 'old', now: 'new' }));
  const first = planWorkload({ sourceChange: { changes } });
  const seen = new Set(first.map(job => jobKey(job.taskId, job.input)));
  const next = planWorkload({ sourceChange: { changes }, seen });
  assert.deepEqual(next.map(job => job.input.sourceId), ['source-3', 'source-4']);
});

test('claims extracted from FLOP news carry the actual publisher URL', () => {
  const url = 'https://flop.finance/intro/verification/';
  const plan = planWorkload({ sourceChange: { changes: [{ id: 'flop-verification', url,
    was: 'old', now: 'new', addedLines: ['A new published rule.'] }] } });
  assert.equal(plan.find(job => job.taskId === 'extract-claims').input.source, url);
});
