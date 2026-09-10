import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readCodeFingerprint, readSourceChange } from '../src/daemon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'tools', 'quick-status.mjs');

function fixture({ fingerprint = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-status-'));
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'local'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'new-head\n');
  fs.writeFileSync(path.join(dir, 'src', 'fixture.mjs'), 'export const fixture = true;\n');
  fs.writeFileSync(path.join(dir, 'tools', 'fixture.mjs'), 'export const tool = true;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');

  const codeFingerprint = readCodeFingerprint(dir);
  const startup = {
    event: 'startup',
    timestamp: new Date().toISOString(),
    commit: 'old-head',
    ...(fingerprint ? { codeFingerprint } : {})
  };
  fs.writeFileSync(
    path.join(dir, 'data', 'local', 'scout-audit.jsonl'),
    `${JSON.stringify(startup)}\n`,
    'utf8'
  );
  return dir;
}

function runStatus(cwd) {
  return execFileSync(process.execPath, [STATUS], { cwd, encoding: 'utf8' });
}

test('status compares the running code fingerprint, not a docs-only commit SHA', () => {
  const output = runStatus(fixture());
  assert.match(output, /Veikia naujausias kodas/);
  assert.doesNotMatch(output, /Naujas kodas laukia/);
});

test('legacy startup records report code version as unknown', () => {
  const output = runStatus(fixture({ fingerprint: false }));
  assert.match(output, /Veikianti versija nezinoma/);
  assert.doesNotMatch(output, /Veikia naujausias kodas/);
  assert.doesNotMatch(output, /Naujas kodas laukia/);
});

test('source watch deltas are merged into fresh workload source changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-change-'));
  fs.mkdirSync(path.join(dir, 'source-watch'), { recursive: true });
  const surfaceAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const watchedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'source-change.json'), JSON.stringify({
    detectedAt: surfaceAt,
    changes: [{ id: 'surface', was: 'a', now: 'b' }]
  }));
  fs.writeFileSync(path.join(dir, 'source-watch', 'change.json'), JSON.stringify({
    detectedAt: watchedAt,
    changes: [{ id: 'openapi', was: 'old', now: 'new' }],
    signalAlerts: [{ id: 'patterns', url: 'https://example.test/patterns', words: ['faucet'] }],
    newRooms: ['faucet']
  }));

  const merged = readSourceChange(dir);
  assert.equal(merged.detectedAt, watchedAt, 'the newest source finding dates the merged work');
  assert.deepEqual(merged.newRooms, ['faucet']);
  assert.deepEqual(merged.changes.map((change) => change.id), ['surface', 'openapi', 'signal:patterns']);
  assert.deepEqual(merged.signalAlerts[0].words, ['faucet']);
});

test('source watch signals remain workload-visible when no surface report exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-signal-'));
  fs.mkdirSync(path.join(dir, 'source-watch'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'source-watch', 'change.json'), JSON.stringify({
    detectedAt: new Date().toISOString(),
    changes: [],
    signalAlerts: [{ id: 'openapi', words: ['session'] }],
    newRooms: ['faucet']
  }));

  const merged = readSourceChange(dir);
  assert.deepEqual(merged.changes.map((change) => change.id), ['signal:openapi']);
  assert.deepEqual(merged.newRooms, ['faucet'], 'room discovery stays metadata, not a proven source change');
});

test('stale source watch deltas are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-stale-'));
  fs.mkdirSync(path.join(dir, 'source-watch'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'source-watch', 'change.json'), JSON.stringify({
    detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 1).toISOString(),
    changes: [{ id: 'old', was: 'a', now: 'b' }],
    signalAlerts: []
  }));

  assert.equal(readSourceChange(dir), null);
});
