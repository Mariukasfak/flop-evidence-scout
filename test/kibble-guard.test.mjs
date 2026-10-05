import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freshMistakes, readPause, writePause } from '../src/kibble-guard.mjs';
import { resultHashFor } from '../src/kibble.mjs';

const US = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const PEER = 'did:key:z6MkpeerPEERpeerPEERpeerPEERpeerPEERpeerPEERpeer';
const OTHER = 'did:key:z6MkotherOTHERotherOTHERotherOTHERotherOTHERoth';

let seq = 0;
const msg = (from, text, ts) => ({ seq: ++seq, from, text, ts });

function tape() {
  seq = 0;
  return [
    msg(PEER, 'JOB v1 | k0000000001 | explain | Q | a real question', '2026-10-05T18:00:00.000000Z'),
    msg(US, 'RESULT v1 | k0000000001 | our early answer', '2026-10-05T18:01:00.123456Z'),
    msg(OTHER, 'ATTEST v1 | k0000000001 | not | restates the question', '2026-10-05T18:02:00Z'),
    msg(PEER, 'JOB v1 | k0000000002 | explain | Q2 | another real question', '2026-10-05T19:00:00Z'),
    msg(US, 'RESULT v1 | k0000000002 | our later answer', '2026-10-05T19:01:00.654321Z'),
    msg(OTHER, `ATTEST v1 | k0000000002 | not | rh:${resultHashFor('our later answer')} | wrong`, '2026-10-05T19:02:00Z'),
    msg(OTHER, `ATTEST v1 | k0000000002 | not | rh:${resultHashFor('somebody else')} | not ours`, '2026-10-05T19:03:00Z'),
    msg(US, 'ATTEST v1 | k0000000002 | not | our own key never counts', '2026-10-05T19:04:00Z'),
    msg(OTHER, 'ATTEST v1 | k0000000002 | useful | fine', '2026-10-05T19:05:00Z')
  ];
}

test('only fresh not-useful verdicts by other keys on our deliveries count', () => {
  const found = freshMistakes(tape(), { since: '2026-10-05T18:30:00Z', ours: [US] });
  assert.deepEqual(found.map((m) => [m.jobId, m.reason]), [['k0000000002', 'wrong']]);
});

test('work delivered before the guard was armed does not pause it', () => {
  assert.equal(freshMistakes(tape(), { since: '2026-10-05T20:00:00Z', ours: [US] }).length, 0);
  assert.equal(freshMistakes(tape(), { since: '2026-10-05T17:00:00Z', ours: [US] }).length, 2);
});

test('a verdict already reported is not reported again', () => {
  const first = freshMistakes(tape(), { since: '2026-10-05T18:30:00Z', ours: [US] });
  const again = freshMistakes(tape(), { since: '2026-10-05T18:30:00Z', ours: [US], seen: new Set(first.map((m) => m.seq)) });
  assert.equal(again.length, 0);
});

test('the pause file round-trips, and its absence means not paused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibble-guard-'));
  assert.equal(readPause(dir), null);
  writePause(dir, { at: 'now', reason: 'test' });
  assert.equal(readPause(dir).reason, 'test');
});
