import test from 'node:test';
import assert from 'node:assert/strict';

import { kibbleLanes, KIBBLE_LANES } from '../src/daemon.mjs';

test('no KIBBLE_LANES means every lane, as KIBBLE_WRITES always meant', () => {
  assert.deepEqual([...kibbleLanes({}).on], [...KIBBLE_LANES]);
  assert.deepEqual([...kibbleLanes({ KIBBLE_LANES: '  ' }).on], [...KIBBLE_LANES]);
});

test('a list turns on exactly those lanes, so answering can stay off', () => {
  const { on, unknown } = kibbleLanes({ KIBBLE_LANES: 'validator, Brief,poster' });
  assert.deepEqual([...on].sort(), ['brief', 'poster', 'validator']);
  assert.equal(on.has('worker'), false);
  assert.equal(on.has('fast'), false);
  assert.deepEqual(unknown, []);
});

test('a misspelt lane is reported, never guessed at', () => {
  const { on, unknown } = kibbleLanes({ KIBBLE_LANES: 'validatr,brief' });
  assert.deepEqual([...on], ['brief']);
  assert.deepEqual(unknown, ['validatr']);
});
