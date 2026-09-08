/**
 * Commits and pushes the generated docs, and does not lose a measurement to a race.
 *
 * Two workflows write the same generated files: the agent every 15 minutes and
 * the source watch every hour. When they overlap, `git pull --rebase` hits a
 * conflict in docs/index.html, docs/status.html or docs/audit-history.json, the
 * rebase aborts, the push never happens, and that hour's reading is gone. That
 * is how a 201-minute gap appeared in a series that is supposed to be hourly.
 *
 * Merging generated files is the wrong idea anyway — there is no meaningful
 * three-way merge of two renderings of the same template. The right resolution
 * is "take the remote as the base, regenerate from it, keep ours", which is what
 * `reset --soft` plus a rebuild does, and it cannot conflict.
 *
 * Run: node scripts/publish-docs.mjs "commit message"
 */
import { execFileSync } from 'node:child_process';

const MESSAGE = process.argv[2] || 'chore(docs): regenerate [skip ci]';
const MAX_ATTEMPTS = 3;

/** Regenerating is cheap and deterministic; merging two renders is neither. */
const REBUILD = [
  ['node', ['tools/build-facts.mjs']],
  ['node', ['tools/readiness.mjs']],
  ['node', ['tools/check-freshness.mjs', '--quiet']],
  ['node', ['tools/render-charts.mjs']],
  ['node', ['tools/build-guide.mjs']],
  ['node', ['tools/build-index.mjs']]
];

function run(cmd, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (err) {
    if (!allowFailure) throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stderr || err.message}`);
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

function stageAndCommit() {
  run('git', ['add', 'docs']);
  const status = run('git', ['status', '--porcelain', '--', 'docs']).out;
  if (!status) return false;

  /**
   * The pathspec is the guarantee, not the `git add` above it.
   *
   * `git commit -- docs` commits those paths from the working tree and ignores
   * whatever else is staged, so this job cannot write a file outside docs/ even
   * if the index is wrong again for some reason nobody has thought of yet.
   */
  run('git', ['commit', '-m', MESSAGE, '--', 'docs']);
  return true;
}

function main() {
  if (!stageAndCommit()) {
    console.log('[publish] Nothing changed under docs/.');
    return;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const push = run('git', ['push', 'origin', 'main'], { allowFailure: true });
    if (push.ok) {
      console.log(`[publish] Pushed on attempt ${attempt}.`);
      return;
    }

    console.log(`[publish] Push rejected on attempt ${attempt}; rebasing onto the remote and regenerating.`);
    run('git', ['fetch', 'origin', 'main']);

    /**
     * Move HEAD *and the index* to the remote. No merge, so no conflict.
     *
     * This was `reset --soft`, which moves HEAD and leaves the index holding the
     * tree this checkout started from. Every file that landed on the remote in
     * the meantime then sat in the index as its own reversal, and the commit
     * below wrote that whole tree — so a docs job quietly reverted source it had
     * never touched. `git add docs` did not protect anything: a commit takes the
     * index, not the pathspec that was last added.
     *
     * It has happened twice and both were invisible for days. On 2026-09-03 it
     * undid a800d31, the fix that serialises signed writes to one room with
     * monotonic nonces, and deleted its test file; the repository ran without
     * that fix for five days while the commit sat in the log looking applied. On
     * 2026-09-08 it undid f0278e5 within a minute of it being pushed.
     *
     * A mixed reset makes the index match the remote, so `git add docs` stages
     * only what this job actually generated.
     */
    run('git', ['reset', 'origin/main']);

    // Rebuild from the remote's data so the output reflects both sides rather
    // than clobbering whatever landed while we were working.
    for (const [cmd, args] of REBUILD) {
      const result = run(cmd, args, { allowFailure: true });
      if (!result.ok) console.warn(`[publish] ${args[0]} failed during rebuild; continuing.`);
    }

    if (!stageAndCommit()) {
      console.log('[publish] Nothing left to publish after the rebuild.');
      return;
    }
  }

  console.error(`[publish] Still could not push after ${MAX_ATTEMPTS} attempts.`);
  process.exit(1);
}

main();
