/**
 * The mini PC's deployer. It is fail-closed: anything unexpected leaves the live
 * checkout exactly as it was, records why, and (for the states that need a
 * person) says so.
 *
 * Order of business, each step able to stop the run:
 *   1. git fetch origin main
 *   2. the live checkout must be on `main`, its tracked files clean,
 *      and operator-mode.json must exist, parse and say EVIDENCE_ONLY
 *   3. remote SHA == active SHA  ->  UP_TO_DATE
 *   4. only a fast-forward is ever applied: no merge commit, no reset --hard
 *   5. a change that touches only generated files (docs/, data/) is fast-forwarded
 *      without a test run and without a restart
 *   6. any other change is checked out into a CANDIDATE worktree and tested there;
 *      only if the safety tests pass is the live checkout fast-forwarded to that
 *      exact SHA. If they fail the live code was never touched, so there is
 *      nothing to roll back, and the failing SHA is not retried until it changes.
 *
 * The close-1 runner is not a resident process: each scheduled run loads the
 * code afresh, and refuses to start while `update.lock` is fresh. The daemon
 * restarts itself when its own code changes (daemon.mjs, readCodeFingerprint).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readOperatorLock, MODES } from './operator-lock.mjs';
import { UPDATER_FILE } from './host.mjs';

export const STATUS = Object.freeze({
  UP_TO_DATE: 'UP_TO_DATE',
  UPDATED: 'UPDATED',
  UPDATED_GENERATED_ONLY: 'UPDATED_GENERATED_ONLY',
  BLOCKED_FETCH_FAILED: 'UPDATE_BLOCKED_FETCH_FAILED',
  BLOCKED_DIRTY_WORKTREE: 'UPDATE_BLOCKED_DIRTY_WORKTREE',
  BLOCKED_WRONG_BRANCH: 'UPDATE_BLOCKED_WRONG_BRANCH',
  BLOCKED_OPERATOR_LOCK: 'UPDATE_BLOCKED_OPERATOR_LOCK',
  BLOCKED_NOT_FAST_FORWARD: 'UPDATE_BLOCKED_NOT_FAST_FORWARD',
  BLOCKED_TESTS_FAILED: 'UPDATE_BLOCKED_TESTS_FAILED',
  BLOCKED_ERROR: 'UPDATE_BLOCKED_ERROR'
});

/** Paths that are output of the running system, not code it runs. A change to these alone never needs a test or a restart. */
export const GENERATED = [/^docs\//, /^data\//, /^\.github\/badges\//];
export const isGenerated = (p) => GENERATED.some((re) => re.test(p));

export const SAFETY_TESTS = Object.freeze(['test/close1-*.test.mjs']);

const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryGit = (cwd, args) => { try { return { ok: true, out: git(cwd, args) }; } catch (err) { return { ok: false, out: String(err.stderr || err.message).trim() }; } };

/** The safety tests, run inside `cwd`. Returns { ok, tail }. */
export function runSafetyTests(cwd) {
  const files = fs.readdirSync(path.join(cwd, 'test')).filter((n) => /^close1-.*\.test\.mjs$/.test(n)).map((n) => path.join('test', n));
  if (!files.length) return { ok: false, tail: 'no close-1 safety tests found in the candidate' };
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd, encoding: 'utf8', timeout: 600_000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, tail: text.split(/\r?\n/).filter((l) => /^(ℹ|✖|not ok|# (pass|fail))|failing|Error/.test(l)).slice(-12).join('\n') };
}

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/**
 * One updater turn. Never throws. Returns { status, ... } and always leaves
 * `updater-status.json` describing the outcome.
 */
export async function runUpdate({ repoDir = process.cwd(), dir = path.join(repoDir, 'data/local/close1'), branch = 'main', remote = 'origin', now = () => new Date(), testRunner = runSafetyTests, notify = async () => {} } = {}) {
  const statusFile = path.join(dir, UPDATER_FILE);
  const prev = readJson(statusFile, {});
  let result;
  try { result = await turn(); } catch (err) { result = { status: STATUS.BLOCKED_ERROR, detail: String(err.message).slice(0, 300) }; }
  const active = tryGit(repoDir, ['rev-parse', 'HEAD']);
  const out = {
    ...result,
    checked_at: now().toISOString(),
    active_head: active.ok ? active.out : null,
    remote_head: result.remote_head ?? prev.remote_head ?? null,
    last_failed_sha: result.status === STATUS.BLOCKED_TESTS_FAILED ? result.remote_head : (result.status === STATUS.UPDATED ? null : prev.last_failed_sha ?? null)
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify(out, null, 2));
  fs.appendFileSync(path.join(dir, 'updater.log'), JSON.stringify(out) + '\n');
  // A person is told once per new problem, not on every retry of the same one.
  const newProblem = out.status !== prev.status || (out.status === STATUS.BLOCKED_TESTS_FAILED && out.remote_head !== prev.remote_head);
  if (out.status.startsWith('UPDATE_BLOCKED') && newProblem && out.status !== STATUS.BLOCKED_FETCH_FAILED) {
    await notify({ kind: 'updater_blocked', text: `close-1 mini PC updater: ${out.status}${out.detail ? ` — ${out.detail}` : ''}. The live code was not changed.` });
  }
  return out;

  async function turn() {
    const fetched = tryGit(repoDir, ['fetch', '--quiet', remote, branch]);
    if (!fetched.ok) return { status: STATUS.BLOCKED_FETCH_FAILED, detail: fetched.out.slice(0, 200) };
    const remoteSha = git(repoDir, ['rev-parse', `${remote}/${branch}`]);
    const base = { remote_head: remoteSha };

    const cur = tryGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!cur.ok || cur.out !== branch) return { ...base, status: STATUS.BLOCKED_WRONG_BRANCH, detail: `on ${cur.out || 'unknown'}, expected ${branch}` };
    const dirty = git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { ...base, status: STATUS.BLOCKED_DIRTY_WORKTREE, detail: dirty.split('\n').slice(0, 5).join(' | ') };
    const lock = readOperatorLock(dir);
    if (lock.mode_status !== 'OK' || lock.mode !== MODES.EVIDENCE_ONLY) return { ...base, status: STATUS.BLOCKED_OPERATOR_LOCK, detail: `operator mode is ${lock.mode ?? lock.mode_status}; automatic updates run only under ${MODES.EVIDENCE_ONLY}` };

    const head = git(repoDir, ['rev-parse', 'HEAD']);
    if (head === remoteSha) return { ...base, status: STATUS.UP_TO_DATE };
    if (!tryGit(repoDir, ['merge-base', '--is-ancestor', 'HEAD', remoteSha]).ok) return { ...base, status: STATUS.BLOCKED_NOT_FAST_FORWARD, detail: `HEAD ${head.slice(0, 7)} is not an ancestor of ${remote}/${branch} ${remoteSha.slice(0, 7)}` };

    const changed = git(repoDir, ['diff', '--name-only', head, remoteSha]).split('\n').filter(Boolean);
    const codeChanged = changed.filter((p) => !isGenerated(p));
    if (!codeChanged.length) {
      git(repoDir, ['merge', '--ff-only', remoteSha]);
      return { ...base, status: STATUS.UPDATED_GENERATED_ONLY, detail: `${changed.length} generated file(s); no restart needed`, restart_needed: false, from: head };
    }
    if (prev.last_failed_sha === remoteSha) return { ...base, status: STATUS.BLOCKED_TESTS_FAILED, detail: `${remoteSha.slice(0, 7)} failed the safety tests earlier; waiting for a newer commit`, tests_tail: prev.tests_tail };

    // The candidate: a separate worktree, so the live tree is never in a half-updated state.
    const cand = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-candidate`);
    tryGit(repoDir, ['worktree', 'remove', '--force', cand]);
    fs.rmSync(cand, { recursive: true, force: true });
    tryGit(repoDir, ['worktree', 'prune']);
    git(repoDir, ['worktree', 'add', '--detach', cand, remoteSha]);
    let tests;
    try { tests = await testRunner(cand); } finally {
      tryGit(repoDir, ['worktree', 'remove', '--force', cand]);
      fs.rmSync(cand, { recursive: true, force: true });
    }
    if (!tests.ok) return { ...base, status: STATUS.BLOCKED_TESTS_FAILED, detail: `${remoteSha.slice(0, 7)} failed the safety tests; the live code is still ${head.slice(0, 7)}`, tests_tail: tests.tail };

    // Tests passed on exactly this SHA: apply it, with the run lock held so a scheduled close-1 run waits.
    const lockFile = path.join(dir, 'update.lock');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ at: now().toISOString(), to: remoteSha }));
    try { git(repoDir, ['merge', '--ff-only', remoteSha]); } finally { fs.rmSync(lockFile, { force: true }); }
    const after = readOperatorLock(dir);
    return {
      ...base, status: STATUS.UPDATED, from: head, restart_needed: true,
      detail: `${head.slice(0, 7)} → ${remoteSha.slice(0, 7)}; ${codeChanged.length} code file(s); safety tests passed on the candidate; operator mode ${after.mode ?? after.mode_status}`
    };
  }
}
