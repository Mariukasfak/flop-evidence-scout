/**
 * The docs publisher must never write a file it did not generate.
 *
 * It did, twice, and both times it was invisible for days. The publisher runs in
 * a workflow whose checkout is minutes old by the time it pushes; when something
 * lands on the remote in between, the push is rejected and it recovers by moving
 * HEAD to the remote and committing again. That recovery used `reset --soft`,
 * which moves HEAD and leaves the index holding the tree the checkout started
 * from — so every file that had landed in the meantime sat in the index as its
 * own reversal, and the next commit wrote the whole tree.
 *
 * On 2026-09-03 it undid a800d31, the fix that serialises signed writes to one
 * room with monotonic nonces, and deleted `test/signed-write-order.test.mjs`
 * with it. Nothing noticed for five days: the commit was in the log, the code
 * was not in the file. On 2026-09-08 it undid f0278e5 about a minute after it
 * was pushed, which is how it was finally caught.
 *
 * So this test is not about docs. It is about the one property that matters:
 * a job that generates docs cannot change source, whatever the index holds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PUBLISHER = path.resolve('scripts/publish-docs.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A bare origin plus one clone, both with an identity so commits are possible. */
function makeRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');

  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'keep.mjs'), 'export const value = "original";\n');
  fs.writeFileSync(path.join(work, 'docs', 'page.html'), '<p>first render</p>\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'initial');
  git(work, 'push', '-u', 'origin', 'main');

  return { root, origin, work };
}

describe('the docs publisher stays inside docs/', () => {
  test('source that lands mid-run survives the push it collides with', () => {
    const { root, origin, work } = makeRepos();
    try {
      // Somebody else pushes real work while this checkout is already stale.
      const other = path.join(root, 'other');
      execFileSync('git', ['clone', origin, other], { stdio: 'ignore' });
      git(other, 'config', 'user.email', 'other@example.com');
      git(other, 'config', 'user.name', 'Other');
      fs.writeFileSync(path.join(other, 'src', 'keep.mjs'), 'export const value = "new work";\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'a fix somebody needs');
      git(other, 'push', 'origin', 'main');

      // The stale job regenerates its own output and publishes. Its first push
      // is rejected, which is the path that used to eat the commit above.
      fs.writeFileSync(path.join(work, 'docs', 'page.html'), '<p>second render</p>\n');
      execFileSync('node', [PUBLISHER, 'chore(docs): regenerate [skip ci]'], {
        cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });

      const published = git(work, 'show', 'origin/main:src/keep.mjs');
      assert.match(published, /new work/, 'the docs job reverted source it never touched');

      const docs = git(work, 'show', 'origin/main:docs/page.html');
      assert.match(docs, /second render/, 'the docs job failed to publish its own output');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a run with nothing to publish writes no commit at all', () => {
    const { root, work } = makeRepos();
    try {
      const before = git(work, 'rev-parse', 'HEAD');
      const out = execFileSync('node', [PUBLISHER, 'chore(docs): regenerate [skip ci]'], {
        cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      assert.match(out, /Nothing changed under docs/);
      assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
