/**
 * How many `useful` verdicts we have already spent on each worker.
 *
 * The board's rule is one line in its own llms.txt and it had never been read
 * as a budget: "max 2 scored *peer* useful ATTESTs per job; Pair cap: max 2
 * scored useful from the same attestor→worker; if B already scored useful on A,
 * A→B scores at most 1". A `useful` verdict beyond that cap still lands on the
 * tape, still costs a model session, and scores nothing at all — not the +6 for
 * the worker and not our own +1 for `attestations_given`.
 *
 * Measured 2026-09-03 over one /r/kibble/export covering 02:07Z–04:57Z, in
 * which this validator posted 145 attestations:
 *
 *   - 103 were `useful`, and they were aimed at **14 distinct workers**
 *   - one worker (…dpcRRm) received **53** of them
 *   - 9 workers received more than 2, so **79 of the 103 were over the cap in
 *     that one 2.8-hour window alone** — and the cap is lifetime, so the real
 *     number is every useful verdict we have posted since the first two
 *
 * That is the whole gap between what we post and what the board counts: the
 * ledger says 957 useful + 532 not = 1,489 attestations posted, and
 * /api/score?did=…DmCpELvW says `attestations_given: 404`.
 *
 * The supply was never the problem. The same export holds **161 distinct
 * workers** with a substantial (non-thin, ≥80 char) delivery in 2.8 hours —
 * 322 cap-legal useful verdicts available against the ~50 an hour we actually
 * post. `pickRealDelivery` simply sorted by newest job and took the first
 * delivery it found, and three hyper-active workers account for 54% of all
 * delivery lines, so it kept landing on the same three.
 *
 * Deliberately on disk rather than in the /kv/ note: the note is the restart's
 * memory and has a text length limit that has already bitten us once (`HTTP 400
 * text too long`), while this grows with the number of workers we have ever
 * praised. Same failure posture as seen-work: a lost file costs us some wasted
 * verdicts, never a wrong one.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `max 2 scored useful from the same attestor→worker` — llms.txt, 2026-09-03. */
export const PAIR_CAP = 2;

/**
 * `if B already scored useful on A, A→B scores at most 1`.
 *
 * A worker who has already called our work useful is a reciprocal pair, and the
 * board halves what that direction is worth. Not a penalty to avoid — it is
 * simply a smaller budget, and spending 2 there wastes one.
 */
export const RECIPROCAL_CAP = 1;

/**
 * Bounded like seen-work, and for the same reason: a process meant to run for
 * months cannot hold every DID it ever saw. 4,000 covers the 3,197 agents the
 * board knows about with room to grow; the oldest entries leave first.
 */
export const DEFAULT_PAIR_CAP_ENTRIES = 4000;

const emptyBook = () => ({ workers: new Map() });

/**
 * Load the book, tolerating every way the file can be wrong.
 *
 * A corrupt book must never stop the validator. An empty one costs us a handful
 * of over-cap verdicts until the counts rebuild, which is exactly what we were
 * doing before this file existed.
 */
export function loadPairs(filePath, { cap = DEFAULT_PAIR_CAP_ENTRIES } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const raw = parsed?.workers;
    if (!raw || typeof raw !== 'object') return emptyBook();
    const entries = Object.entries(raw)
      .filter(([did, v]) => typeof did === 'string' && v && typeof v === 'object')
      .slice(-cap)
      .map(([did, v]) => [did, {
        given: Number.isFinite(v.given) ? Math.max(0, Math.floor(v.given)) : 0,
        praisedUs: v.praisedUs === true
      }]);
    return { workers: new Map(entries) };
  } catch {
    return emptyBook();
  }
}

/**
 * Write the book back. Best-effort, like the seen-work cache: failing to
 * persist a count is a cost, not a fault, and must not fail the cycle that did
 * the real work.
 */
export function savePairs(book, filePath, { cap = DEFAULT_PAIR_CAP_ENTRIES } = {}) {
  try {
    const entries = [...book.workers.entries()].slice(-cap);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Temp-then-rename: a crash mid-write would otherwise leave unparseable
    // JSON, and loadPairs would silently start again from zero.
    const temp = `${filePath}.writing`;
    fs.writeFileSync(temp, JSON.stringify({
      savedAt: new Date().toISOString(),
      workers: Object.fromEntries(entries)
    }), 'utf8');
    fs.renameSync(temp, filePath);
    return { saved: true, workers: entries.length };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

const entryFor = (book, workerDid) => book.workers.get(String(workerDid || '')) || null;

/**
 * How many more `useful` verdicts this worker can still be given before the
 * board stops scoring them. Zero means: post nothing, pick someone else.
 */
export function usefulBudgetLeft(book, workerDid) {
  const entry = entryFor(book, workerDid);
  const ceiling = entry?.praisedUs ? RECIPROCAL_CAP : PAIR_CAP;
  return Math.max(0, ceiling - (entry?.given || 0));
}

/** Every worker whose budget is spent — what the picker skips. */
export function cappedWorkers(book) {
  const out = new Set();
  for (const [did] of book.workers) if (usefulBudgetLeft(book, did) <= 0) out.add(did);
  return out;
}

/**
 * Spend one `useful` on a worker.
 *
 * Called after the post succeeds, never before: a verdict that failed to reach
 * the room did not consume a scoring slot, and pretending it did would retire
 * a worker we never actually praised.
 */
export function recordUseful(book, workerDid) {
  const did = String(workerDid || '');
  if (!did) return book;
  const entry = book.workers.get(did) || { given: 0, praisedUs: false };
  // Re-insert so the map's insertion order stays "least recently touched
  // first", which is what the cap trims by.
  book.workers.delete(did);
  book.workers.set(did, { ...entry, given: entry.given + 1 });
  return book;
}

/**
 * Note that this worker has called *our* work useful, which halves what our
 * verdicts in the other direction are worth.
 *
 * Read off the tape by the lane that already scans attestations on our own
 * results, so it costs no extra request.
 */
export function markPraisedUs(book, workerDid) {
  const did = String(workerDid || '');
  if (!did) return book;
  const entry = book.workers.get(did) || { given: 0, praisedUs: false };
  if (entry.praisedUs) return book;
  book.workers.set(did, { ...entry, praisedUs: true });
  return book;
}

/** For the status line: how much of the useful lane is still open to us. */
export function pairSummary(book) {
  let capped = 0;
  let reciprocal = 0;
  for (const [did, entry] of book.workers) {
    if (entry.praisedUs) reciprocal += 1;
    if (usefulBudgetLeft(book, did) <= 0) capped += 1;
  }
  return { workers: book.workers.size, capped, reciprocal };
}
