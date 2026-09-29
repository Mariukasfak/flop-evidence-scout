/**
 * close-1 production host (operator, 2026-09-29): the lock is fail-closed and
 * re-read before every write, a second writer is noticed, Telegram is only
 * used if it is already configured, and the updater never touches live code
 * that has not passed the safety tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateIdentity } from '../src/identity.mjs';
import { readOperatorLock, makeWriteGuard, lockAlerts, recordWrite, readWrites, foreignWrites, setWatchSince, WritesBlocked } from '../src/close1/operator-lock.mjs';
import { Executor } from '../src/close1/executor.mjs';
import { loadTelegramEnv, telegramOnlineTest, TELEGRAM_TEST_TEXT, hostHealth } from '../src/close1/host.mjs';
import { runUpdate, isGenerated, STATUS } from '../src/close1/updater.mjs';
import { deliverAlerts } from '../src/close1/runtime.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'close1-host-'));
const lf = (t) => t.split('\r\n').join('\n');
const put = (dir, name, v) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v)); };
const setup = (mode, writer = true, host = 'MINI_PC') => {
  const dir = tmp();
  if (mode !== undefined) put(dir, 'operator-mode.json', mode);
  if (writer !== null) put(dir, 'host-role.json', { host, writer });
  return dir;
};

test('L1. writes are allowed only for mode ACTIVE on a declared writer; everything else fails closed', () => {
  const on = (dir) => readOperatorLock(dir).writes_allowed;
  assert.equal(on(setup({ mode: 'ACTIVE' })), true);
  assert.equal(on(setup({ mode: 'EVIDENCE_ONLY' })), false);
  assert.equal(on(setup(undefined)), false, 'file missing');
  assert.equal(on(setup('{ not json')), false, 'malformed');
  assert.equal(on(setup('[]')), false, 'not an object');
  assert.equal(on(setup({})), false, 'no mode');
  assert.equal(on(setup({ mode: 'active' })), false, 'the mode must match exactly');
  assert.equal(on(setup({ mode: 'FULL_SEND' })), false, 'unknown mode');
  assert.equal(on(setup({ mode: 'ACTIVE' }, false, 'HETZNER_STANDBY')), false, 'not a writer host');
  assert.equal(on(setup({ mode: 'ACTIVE' }, null)), false, 'no host role');
  const l = readOperatorLock(setup({ mode: 'EVIDENCE_ONLY' }));
  assert.deepEqual([l.mode, l.mode_status, l.host, l.host_writer], ['EVIDENCE_ONLY', 'OK', 'MINI_PC', true]);
  assert.equal(readOperatorLock(setup('﻿{"mode":"EVIDENCE_ONLY"}')).mode, 'EVIDENCE_ONLY', 'a BOM from a Windows editor is tolerated, and still not ACTIVE');
});

test('L2. the guard re-reads the lock every time: a lock that flips mid-run stops the next write', () => {
  const dir = setup({ mode: 'ACTIVE' });
  const guard = makeWriteGuard(dir);
  assert.doesNotThrow(() => guard('post'));
  put(dir, 'operator-mode.json', { mode: 'EVIDENCE_ONLY' });
  assert.throws(() => guard('post'), (e) => e instanceof WritesBlocked && /EVIDENCE_ONLY/.test(e.message));
  fs.rmSync(path.join(dir, 'operator-mode.json'));
  assert.throws(() => guard('post'), /MISSING/);
});

test('L3. the executor signs nothing and posts nothing while blocked, and records only what it really did', async () => {
  const id = generateIdentity();
  const posts = [];
  const client = { postSignedMessage: async (room, text) => { posts.push(text); return { raw: '' }; } };
  const dir = setup({ mode: 'EVIDENCE_ONLY' });
  const ex = new Executor({ identityPath: 'x', client, loadIdentity: () => id, guard: makeWriteGuard(dir), onWrite: (w) => recordWrite(dir, w) });
  const terms = { id: 't1', maker: id.did, side: 'buy', qty: '0.50', px: '224.00', until: 10, season: 'close-1' };
  assert.throws(() => ex.signOffer(terms), WritesBlocked);
  assert.throws(() => ex.signAccept(terms, 'sig'), WritesBlocked);
  assert.throws(() => ex.probeText({ terms }), WritesBlocked);
  await assert.rejects(ex.post('{"terms":{"id":"t1"}}', { ok: true, text: '{"terms":{"id":"t1"}}' }), WritesBlocked);
  assert.equal(posts.length, 0);
  assert.deepEqual([readWrites(dir).attempts, readWrites(dir).actual, readWrites(dir).last_actual_write_at], [0, 0, null], 'a blocked write is not even an attempt');
  // With the lock open, a post is recorded as attempted and done.
  put(dir, 'operator-mode.json', { mode: 'ACTIVE' });
  const text = '{"terms":{"id":"t1"}}';
  await ex.post(text, { ok: true, text });
  const w = readWrites(dir);
  assert.deepEqual([posts.length, w.attempts, w.actual], [1, 1, 1]);
  assert.ok(w.last_actual_write_at);
});

test('L4. a failed post is an attempt, not a write', async () => {
  const dir = setup({ mode: 'ACTIVE' });
  const ex = new Executor({ identityPath: 'x', client: { postSignedMessage: async () => { throw new Error('503'); } }, loadIdentity: () => generateIdentity(), guard: makeWriteGuard(dir), onWrite: (w) => recordWrite(dir, w) });
  await assert.rejects(ex.post('{"terms":{"id":"a"}}', { ok: true, text: '{"terms":{"id":"a"}}' }), /503/);
  const w = readWrites(dir);
  assert.deepEqual([w.attempts, w.actual, w.last_actual_write_at], [1, 0, null]);
});

test('L5. the lock changing, or breaking, is a watchdog alert; an unchanged lock is silent', () => {
  const snap = (over = {}) => ({ operator_mode: 'EVIDENCE_ONLY', operator_mode_status: 'OK', host_writer: true, active_runtime_host: 'MINI_PC', ...over });
  assert.deepEqual(lockAlerts(snap(), snap()), []);
  assert.deepEqual(lockAlerts(null, snap()), []);
  assert.deepEqual(lockAlerts({ generated_at: 'x' }, snap()), [], 'a snapshot from before the field existed is a baseline');
  assert.deepEqual(lockAlerts(snap(), snap({ operator_mode: 'ACTIVE' })).map((a) => a.kind), ['operator_mode_changed']);
  assert.match(lockAlerts(snap(), snap({ operator_mode: 'ACTIVE' }))[0].text, /EVIDENCE_ONLY → ACTIVE/);
  assert.deepEqual(lockAlerts(snap(), snap({ operator_mode: null, operator_mode_status: 'MISSING' })).map((a) => a.kind), ['operator_lock_broken']);
  assert.deepEqual(lockAlerts(snap({ host_writer: false }), snap()).map((a) => a.kind), ['host_became_writer']);
});

test('L6. a post under our key that this host did not make is a CRITICAL second-writer signal', () => {
  const dir = tmp();
  const OUR = 'did:key:zOurs';
  const rec = (seq, from = OUR) => ({ room: 'close1', seq, from });
  const history = [rec(100), rec(200), rec(300, 'did:key:zStranger')];
  const first = foreignWrites({ records: history, ourDid: OUR, writes: readWrites(dir) });
  assert.deepEqual([first.initialised, first.since, first.foreign], [true, 200, []], 'the first look only marks the history');
  setWatchSince(dir, first.since);
  assert.deepEqual(foreignWrites({ records: history, ourDid: OUR, writes: readWrites(dir) }).foreign, []);
  // Our own post is recorded by this host, so it is known.
  recordWrite(dir, { phase: 'done', seq: 250 });
  assert.deepEqual(foreignWrites({ records: [...history, rec(250)], ourDid: OUR, writes: readWrites(dir) }).foreign, []);
  // A post nobody here made: another machine has the key.
  assert.deepEqual(foreignWrites({ records: [...history, rec(250), rec(260)], ourDid: OUR, writes: readWrites(dir) }).foreign, [260]);
  assert.deepEqual(foreignWrites({ records: [...history, rec(400, 'did:key:zStranger')], ourDid: OUR, writes: readWrites(dir) }).foreign, [], 'strangers are not us');
});

test('T1. Telegram: nothing is created or guessed; one test message once, and only if configured', async () => {
  const dir = tmp();
  const sent = [];
  const fetchFn = async (url, o) => { sent.push([url, JSON.parse(o.body)]); return { ok: true }; };
  assert.deepEqual(await telegramOnlineTest({ env: {}, dir, fetchFn }), { status: 'NOT_CONFIGURED' });
  assert.equal(sent.length, 0);
  const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' };
  const a = await telegramOnlineTest({ env, dir, fetchFn, now: new Date('2026-09-29T10:00:00Z') });
  assert.equal(a.status, 'CONFIGURED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].text, TELEGRAM_TEST_TEXT);
  assert.equal(TELEGRAM_TEST_TEXT, 'FLOP Evidence Scout mini PC alerts online');
  await telegramOnlineTest({ env, dir, fetchFn });
  assert.equal(sent.length, 1, 'the test message is sent once');
  const bad = await telegramOnlineTest({ env, dir: tmp(), fetchFn: async () => ({ ok: false, status: 401 }) });
  assert.equal(bad.status, 'CONFIGURED_TEST_FAILED');
  // credentials from an existing secret env file, never printed
  const f = path.join(tmp(), '.env.local');
  fs.writeFileSync(f, 'KIBBLE_WRITES=true\nTELEGRAM_BOT_TOKEN="abc"\nTELEGRAM_CHAT_ID=7\n');
  const e = loadTelegramEnv({ env: {}, file: f });
  assert.deepEqual([e.TELEGRAM_BOT_TOKEN, e.TELEGRAM_CHAT_ID], ['abc', '7']);
  assert.equal(loadTelegramEnv({ env: {}, file: path.join(tmp(), 'nope') }).TELEGRAM_BOT_TOKEN, undefined);
  // log-only alerts never reach Telegram
  const log = path.join(tmp(), 'a.jsonl'); const texts = [];
  await deliverAlerts([{ kind: 'x', text: 'held', logOnly: true }, { kind: 'write_failure', text: 'sent' }], { logFile: log, env, fetchFn: async (u, o) => { texts.push(JSON.parse(o.body).text); return { ok: true }; } });
  assert.deepEqual(texts, ['🟡 SVARBU\nsent']);
});

test('T2. the host block says which machine, which lock, and whether anything was ever written', () => {
  const dir = setup({ mode: 'EVIDENCE_ONLY' });
  put(dir, 'updater-status.json', { status: 'UP_TO_DATE', checked_at: 'x', remote_head: 'aaaaaaa', active_head: 'aaaaaaa' });
  const h = hostHealth({ dir, nowMs: Date.parse('2026-09-29T10:00:00Z'), cycleOk: true, telegram: { status: 'NOT_CONFIGURED' }, baseline: { ready: true, status: 'BASELINE_READY', why: null }, archive: { archive_cache_required: 102, archive_cache_present: 102, archive_cache_valid: true }, repoDir: dir });
  assert.deepEqual([h.active_runtime_host, h.operator_mode, h.writes_allowed, h.evidence_baseline_ready, h.telegram_status, h.updater_status, h.remote_head, h.active_head],
    ['MINI_PC', 'EVIDENCE_ONLY', false, true, 'NOT_CONFIGURED', 'UP_TO_DATE', 'aaaaaaa', 'aaaaaaa']);
  assert.deepEqual([h.last_actual_write, h.last_write_attempt, h.writes_actual_total, h.writes_this_cycle], [null, null, 0, 0], 'no write has ever happened here');
  assert.deepEqual([h.archive_cache_required, h.archive_cache_present, h.archive_cache_valid], [102, 102, true]);
  const stale = hostHealth({ dir, prev: { last_successful_cycle: 'earlier' }, nowMs: 0, cycleOk: false, baseline: { ready: false, status: 'BACKFILLING', why: 'x' }, repoDir: dir });
  assert.equal(stale.last_successful_cycle, 'earlier');
  assert.equal(stale.evidence_status, 'BACKFILLING');
});

// ---------------------------------------------------------------- the updater, against real git

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repos() {
  const root = tmp();
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const live = path.join(root, 'live');
  fs.mkdirSync(origin); git(origin, 'init', '--bare', '-b', 'main');
  fs.mkdirSync(work); git(work, 'init', '-b', 'main'); git(work, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(work, 'src')); fs.mkdirSync(path.join(work, 'docs')); fs.mkdirSync(path.join(work, 'test'));
  fs.writeFileSync(path.join(work, 'src/a.mjs'), 'export const v = 1;\n'); fs.writeFileSync(path.join(work, 'docs/s.json'), '1');
  fs.writeFileSync(path.join(work, 'test/close1-x.test.mjs'), '');
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'base'); git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, live);
  const dir = path.join(live, 'data/local/close1');
  put(dir, 'operator-mode.json', { mode: 'EVIDENCE_ONLY' });
  const push = (file, body, msg = 'c') => { fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.writeFileSync(path.join(work, file), body); git(work, 'add', '-A'); git(work, 'commit', '-m', msg); git(work, 'push', '-q', 'origin', 'main'); return git(work, 'rev-parse', 'HEAD'); };
  return { root, work, live, dir, push, head: () => git(live, 'rev-parse', 'HEAD') };
}

const pass = async () => ({ ok: true, tail: '' });
const fail = async () => ({ ok: false, tail: 'not ok 1 - risk gate' });

test('U1. same SHA: nothing to do', async () => {
  const r = repos();
  const out = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass });
  assert.equal(out.status, STATUS.UP_TO_DATE);
  assert.equal(out.active_head, out.remote_head);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'updater-status.json'), 'utf8')).status, STATUS.UP_TO_DATE);
});

test('U2. generated-only commits are fast-forwarded with no tests and no restart', async () => {
  const r = repos();
  const sha = r.push('docs/s.json', '2', 'chore(status) [skip ci]');
  let ran = false;
  const out = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: async () => { ran = true; return { ok: true }; } });
  assert.equal(out.status, STATUS.UPDATED_GENERATED_ONLY);
  assert.equal(out.restart_needed, false);
  assert.equal(ran, false);
  assert.equal(r.head(), sha);
  assert.ok(isGenerated('docs/index.html') && isGenerated('data/local/x') && !isGenerated('src/a.mjs') && !isGenerated('tools/x.mjs') && !isGenerated('package.json'));
});

test('U3. a code change is tested in a candidate first; on pass the live tree is fast-forwarded to exactly that SHA', async () => {
  const r = repos();
  const sha = r.push('src/a.mjs', 'export const v = 2;\n', 'feat');
  let testedIn = null; let liveWhileTesting = null;
  const out = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: async (cwd) => { testedIn = cwd; liveWhileTesting = lf(fs.readFileSync(path.join(r.live, 'src/a.mjs'), 'utf8')); assert.equal(lf(fs.readFileSync(path.join(cwd, 'src/a.mjs'), 'utf8')), 'export const v = 2;\n'); return { ok: true, tail: '' }; } });
  assert.equal(out.status, STATUS.UPDATED);
  assert.equal(out.restart_needed, true);
  assert.notEqual(testedIn, r.live, 'tests ran in a separate candidate checkout');
  assert.equal(liveWhileTesting, 'export const v = 1;\n', 'the live code was untouched while the candidate was tested');
  assert.equal(r.head(), sha);
  assert.equal(fs.existsSync(testedIn), false, 'the candidate is cleaned up');
  assert.equal(fs.existsSync(path.join(r.dir, 'update.lock')), false, 'the run lock is released');
  assert.equal(readOperatorLock(r.dir).mode, 'EVIDENCE_ONLY', 'still EVIDENCE_ONLY afterwards');
  assert.equal(git(r.live, 'log', '--merges', '--oneline').length, 0, 'no merge commit');
});

test('U4. failing safety tests: the live code is never changed, the operator is told once, and the SHA is not retried', async () => {
  const r = repos();
  const before = r.head();
  const bad = r.push('src/a.mjs', 'export const v = 3;\n', 'feat: broken');
  const alerts = [];
  const notify = async (a) => alerts.push(a);
  const one = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: fail, notify });
  assert.equal(one.status, STATUS.BLOCKED_TESTS_FAILED);
  assert.equal(one.tests_tail, 'not ok 1 - risk gate');
  assert.equal(r.head(), before, 'nothing to roll back: live never moved');
  assert.equal(lf(fs.readFileSync(path.join(r.live, 'src/a.mjs'), 'utf8')), 'export const v = 1;\n');
  assert.equal(alerts.length, 1);
  let retried = false;
  const two = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: async () => { retried = true; return { ok: true }; }, notify });
  assert.equal(two.status, STATUS.BLOCKED_TESTS_FAILED);
  assert.equal(retried, false, 'the same failing SHA is not tested again');
  assert.equal(alerts.length, 1, 'and not announced again');
  // A newer commit gets a fresh look.
  const good = r.push('src/a.mjs', 'export const v = 4;\n', 'fix');
  const three = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass, notify });
  assert.equal(three.status, STATUS.UPDATED);
  assert.equal(r.head(), good);
  assert.notEqual(good, bad);
});

test('U5. a dirty tracked file blocks the update and nothing is touched', async () => {
  const r = repos();
  r.push('src/a.mjs', 'export const v = 5;\n', 'feat');
  fs.writeFileSync(path.join(r.live, 'src/a.mjs'), 'export const v = 99; // local edit\n');
  const before = r.head();
  const out = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass });
  assert.equal(out.status, 'UPDATE_BLOCKED_DIRTY_WORKTREE');
  assert.equal(r.head(), before);
  assert.equal(fs.readFileSync(path.join(r.live, 'src/a.mjs'), 'utf8'), 'export const v = 99; // local edit\n');
  // An untracked file (the mini PC's package-lock.json) is not "dirty".
  fs.writeFileSync(path.join(r.live, 'package-lock.json'), '{}');
  git(r.live, 'checkout', '--', 'src/a.mjs');
  assert.equal((await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass })).status, STATUS.UPDATED);
});

test('U6. no valid EVIDENCE_ONLY lock, no update: missing, malformed, ACTIVE', async () => {
  for (const setMode of [(d) => fs.rmSync(path.join(d, 'operator-mode.json')), (d) => put(d, 'operator-mode.json', '{oops'), (d) => put(d, 'operator-mode.json', { mode: 'ACTIVE' })]) {
    const r = repos();
    r.push('src/a.mjs', 'export const v = 6;\n', 'feat');
    setMode(r.dir);
    const before = r.head();
    const out = await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass });
    assert.equal(out.status, STATUS.BLOCKED_OPERATOR_LOCK);
    assert.equal(r.head(), before);
  }
});

test('U7. only fast-forwards: local commits ahead of origin, a wrong branch, or a failing fetch change nothing', async () => {
  const r = repos();
  fs.writeFileSync(path.join(r.live, 'src/local.mjs'), 'x'); git(r.live, 'add', '-A'); git(r.live, 'commit', '-m', 'local only');
  r.push('src/a.mjs', 'export const v = 7;\n', 'feat');
  const before = r.head();
  assert.equal((await runUpdate({ repoDir: r.live, dir: r.dir, testRunner: pass })).status, STATUS.BLOCKED_NOT_FAST_FORWARD);
  assert.equal(r.head(), before);
  const r2 = repos(); git(r2.live, 'checkout', '-q', '-b', 'side');
  assert.equal((await runUpdate({ repoDir: r2.live, dir: r2.dir, testRunner: pass })).status, STATUS.BLOCKED_WRONG_BRANCH);
  const r3 = repos(); git(r3.live, 'remote', 'set-url', 'origin', path.join(r3.root, 'missing.git'));
  assert.equal((await runUpdate({ repoDir: r3.live, dir: r3.dir, testRunner: pass })).status, STATUS.BLOCKED_FETCH_FAILED);
});

test('U8. a running close-1 refuses to start while the update lock is fresh (checked in the take tool)', () => {
  const src = fs.readFileSync(new URL('../tools/close1-take.mjs', import.meta.url), 'utf8');
  assert.match(src, /update\.lock/);
  assert.match(src, /an update is in progress/);
});

test('U9. no scheduled close-1 path can write without the guard: every Executor in the tools gets one', () => {
  const src = fs.readFileSync(new URL('../tools/close1-take.mjs', import.meta.url), 'utf8');
  const made = src.match(/new Executor\(\{[^}]*\}\)/g) || [];
  assert.ok(made.length >= 1);
  for (const m of made) assert.match(m, /guard: makeWriteGuard\(DIR\)/);
  assert.match(src, /if \(!lock\.writes_allowed\)/);
});
