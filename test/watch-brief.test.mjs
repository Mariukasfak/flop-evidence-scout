import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as watchBrief from '../tools/watch-brief.mjs';

function state(checkedAt, version) {
  return { checkedAt, sources: { 'agent-json': { summary: version } } };
}

test('baseline prefers the newest valid local watcher state over the CI fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-brief-'));
  try {
    const localPath = path.join(dir, 'source-watch', 'state.json');
    const fallbackPath = path.join(dir, 'docs-state.json');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(state('2026-09-10T12:00:00.000Z', 'local-0.12.1')));
    fs.writeFileSync(fallbackPath, JSON.stringify(state('2026-09-10T11:00:00.000Z', 'ci-0.12.0')));

    assert.equal(typeof watchBrief.baseline, 'function');
    assert.match(watchBrief.baseline({ dataDir: dir, fallbackPath })[0], /local-0\.12\.1/);
    assert.match(watchBrief.baseline({ dataDir: dir, fallbackPath })[0], /2026-09-10T12:00:00\.000Z/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('baseline falls back to the valid CI state when local state is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-brief-'));
  try {
    const fallbackPath = path.join(dir, 'docs-state.json');
    fs.writeFileSync(fallbackPath, JSON.stringify(state('2026-09-10T11:00:00.000Z', 'ci-0.12.0')));
    assert.equal(typeof watchBrief.baseline, 'function');
    assert.match(watchBrief.baseline({ dataDir: dir, fallbackPath })[0], /ci-0\.12\.0/);

    const localPath = path.join(dir, 'source-watch', 'state.json');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, '{not-json');
    assert.match(watchBrief.baseline({ dataDir: dir, fallbackPath })[0], /ci-0\.12\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
