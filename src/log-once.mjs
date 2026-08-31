/**
 * Say a recurring thing once, then say how often it kept happening.
 *
 * Technocore spent 2026-08-31 refusing writes. Every cycle printed the same
 * five lines — the Scout's state write failed, the Scribe's state write failed,
 * the Mailbox's state write failed, a post failed, the activity was not
 * recorded — once a minute, for hours. Around three hundred lines an hour, all
 * of them true, all of them the same fact: the server is not accepting writes.
 *
 * The cost is not disk. It is that the operator looked at a healthy agent
 * completing twenty inference sessions a cycle and could not see it, because
 * the one useful line was buried under a hundred copies of a line they had
 * already read. "I still don't really see it working" is what that looks like
 * from outside, and it was accurate.
 *
 * So: the first occurrence prints immediately, because a new failure is news.
 * Repeats are counted silently and summarised on a timer, so the log says
 * "still happening, 47 times since" rather than saying it 47 times. Anything
 * with different text is a different fact and prints at once — this suppresses
 * repetition, never information.
 */

/** How long a repeated line stays quiet before it reports its own count. */
const DEFAULT_SUMMARY_MS = 5 * 60_000;

const seen = new Map();

/**
 * @param {string} key    what this line is about, e.g. 'scout:state-write'
 * @param {string} message the line as it would have been printed
 */
export function sayOnce(key, message, { summaryMs = DEFAULT_SUMMARY_MS, now = Date.now, out = console.warn } = {}) {
  const at = now();
  const entry = seen.get(key);

  // A different message under the same key is a different fact. Report the old
  // one's tail before moving on, so nothing is silently swallowed.
  if (entry && entry.message !== message) {
    if (entry.suppressed > 0) {
      out(`${entry.message}  (and ${entry.suppressed} more like it)`);
    }
    seen.delete(key);
  }

  const current = seen.get(key);
  if (!current) {
    seen.set(key, { message, suppressed: 0, lastSaidAt: at });
    out(message);
    return true;
  }

  current.suppressed += 1;
  if (at - current.lastSaidAt >= summaryMs) {
    out(`${message}  (still happening — ${current.suppressed} times in the last ${Math.round((at - current.lastSaidAt) / 60_000)} min)`);
    current.suppressed = 0;
    current.lastSaidAt = at;
    return true;
  }
  return false;
}

/**
 * Report and forget, for when a thing stops happening.
 *
 * Called when the underlying condition clears, so the log records how long the
 * problem lasted rather than simply falling silent — a stream of errors that
 * just stops is indistinguishable from a process that died.
 */
export function clearOnce(key, { now = Date.now, out = console.log } = {}) {
  const entry = seen.get(key);
  if (!entry) return false;
  seen.delete(key);
  if (entry.suppressed > 0) {
    const mins = Math.round((now() - entry.lastSaidAt) / 60_000);
    out(`${entry.message.split(':')[0]}: recovered after ${entry.suppressed} more failure(s) over ~${mins} min.`);
    return true;
  }
  return false;
}

/** Tests write their own history; this forgets it. */
export function resetLogOnce() {
  seen.clear();
}
