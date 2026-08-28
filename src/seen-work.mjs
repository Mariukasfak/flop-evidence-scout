/**
 * What this agent has already done, kept where a restart cannot lose it.
 *
 * The planner skips a job whose key it has seen. That set lived only in memory,
 * so every restart made the agent forget its entire history and re-classify
 * everything the next room read returned. Seven restarts are recorded in one
 * day of audit log — a crash, a closed window, a machine rebooting overnight —
 * and each one silently paid for work already done.
 *
 * Free today, because the backend is simulated. Not free the moment a session
 * costs $FLOP: the airdrop is scored on spend, and spend on a question already
 * answered is the same wasted budget as the hundred thousand identities posting
 * "checking in" into the lobby.
 *
 * Deliberately not the ledger. The ledger is evidence and must stay append-only
 * and verifiable; this is a cache whose worst failure is doing a job twice. They
 * have opposite requirements and sharing a file would compromise both.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Bounded, because a process meant to run for months cannot hold every key it
 * ever saw. Insertion order is preserved by Set, so the oldest keys leave first
 * and the worst case is that a long-forgotten message is classified once more.
 */
export const DEFAULT_SEEN_CAP = 5000;

/**
 * Load the keys from disk, tolerating every way the file can be wrong.
 *
 * A corrupt cache must never stop the agent: an empty set costs some repeated
 * work, while throwing here would take the daemon down for a file that holds
 * nothing irreplaceable.
 */
export function loadSeen(filePath, { cap = DEFAULT_SEEN_CAP } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const keys = Array.isArray(parsed) ? parsed : parsed?.keys;
    if (!Array.isArray(keys)) return new Set();
    return new Set(keys.filter((k) => typeof k === 'string').slice(-cap));
  } catch {
    return new Set();
  }
}

/**
 * Write the keys back, newest last, trimmed to the cap.
 *
 * Best-effort by design and returns what happened rather than throwing. Failing
 * to persist a cache is a cost, not a fault, and it must not fail the cycle that
 * did the actual work.
 */
export function saveSeen(seen, filePath, { cap = DEFAULT_SEEN_CAP } = {}) {
  try {
    const keys = [...seen].slice(-cap);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Temp-then-rename: a crash mid-write would otherwise leave unparseable JSON,
    // which loadSeen would discard — turning a small interruption into total amnesia.
    const temp = `${filePath}.writing`;
    fs.writeFileSync(temp, JSON.stringify({ savedAt: new Date().toISOString(), keys }), 'utf8');
    fs.renameSync(temp, filePath);
    return { saved: true, keys: keys.length };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

/**
 * Drop the oldest keys once the set outgrows its cap.
 *
 * Trims below the cap rather than to it, so a set sitting at the boundary does
 * not pay for a trim on every single addition.
 */
export function trimSeen(seen, { cap = DEFAULT_SEEN_CAP } = {}) {
  if (seen.size <= cap) return { dropped: 0 };
  const drop = seen.size - Math.floor(cap * 0.8);
  let i = 0;
  for (const key of seen) {
    if (i++ >= drop) break;
    seen.delete(key);
  }
  return { dropped: drop };
}
