import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWatch } from '../tools/watch-sources.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { statePath: path.join(dir, 'state.json'), changePath: path.join(dir, 'change.json'),
    sourceList: [{ id: 'openapi', url: 'https://technocore.chat/openapi.json', kind: 'openapi' }],
    commitBaseline: true };
  return { opts, read: () => JSON.parse(fs.readFileSync(opts.statePath, 'utf8')) };
}
const api = (paths) => JSON.stringify({ paths: Object.fromEntries(paths.map(p => [p, {}])) });
const requestFor = (body) => async (url) => url.endsWith('/rooms') ? '' : body;

test('a read-only quiet check preserves the pending report and baseline', async t => {
  const { opts } = fixture(t);
  await runWatch({ ...opts, request: requestFor(api(['/a'])) });
  fs.writeFileSync(opts.changePath, 'pending finding');
  const baseline = fs.readFileSync(opts.statePath, 'utf8');
  await runWatch({ ...opts, commitBaseline: false, request: requestFor(api(['/a'])) });
  assert.equal(fs.readFileSync(opts.changePath, 'utf8'), 'pending finding');
  assert.equal(fs.readFileSync(opts.statePath, 'utf8'), baseline);
});

test('valid JSON with an invalid state shape fails loudly instead of becoming a first run', async t => {
  const { opts } = fixture(t);
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  for (const invalid of [[], null, { sources: [] }, { sources: null }]) {
    process.exitCode = 0;
    fs.writeFileSync(opts.statePath, JSON.stringify(invalid));
    await runWatch({ ...opts, request: requestFor(api(['/a'])) });
    assert.equal(process.exitCode, 1);
  }
});

test('an outage retains the last successful route baseline so recovery reports added routes', async t => {
  const { opts, read } = fixture(t);
  await runWatch({ ...opts, request: requestFor(api(['/r/{room}'])) });
  await runWatch({ ...opts, request: async () => { throw new Error('HTTP 503'); } });
  assert.deepEqual(read().sources.openapi.paths, ['/r/{room}']);
  await runWatch({ ...opts, request: requestFor(api(['/r/{room}', '/new-published-route'])) });
  const change = JSON.parse(fs.readFileSync(opts.changePath, 'utf8'));
  assert.deepEqual(change.changes.find(c => c.id === 'openapi').addedPaths, ['/new-published-route']);
});

test('newly watched sources announce existing content on an established watch', async t => {
  const { opts } = fixture(t);
  await runWatch({ ...opts, request: requestFor(api(['/r/{room}'])) });
  await runWatch({ ...opts,
    sourceList: [...opts.sourceList, { id: 'flop-agent', url: 'https://flop.finance/intro/agent/', kind: 'html' }],
    request: async url => url.endsWith('/rooms') ? '' : url.includes('openapi') ? api(['/r/{room}']) : '<p>Agent plan</p>' });
  assert.equal(fs.existsSync(opts.changePath), true);
  const change = JSON.parse(fs.readFileSync(opts.changePath, 'utf8'));
  assert.equal(change.changes.some(c => c.id === 'flop-agent' && c.newSource), true);
});

test('local history keeps findings even after a quiet run clears the current delta', async t => {
  const { opts } = fixture(t);
  const historyPath = path.join(path.dirname(opts.statePath), 'history.jsonl');
  for (const paths of [['/a'], ['/a', '/b'], ['/a', '/b']]) {
    await runWatch({ ...opts, historyPath, request: requestFor(api(paths)) });
  }
  assert.equal(fs.existsSync(historyPath), true);
  const runs = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 3);
  assert.equal(runs[1].changes[0].addedPaths[0], '/b');
  assert.equal(runs[2].changes.length, 0);
  assert.equal(runs[2].healthySources, 1);
});
