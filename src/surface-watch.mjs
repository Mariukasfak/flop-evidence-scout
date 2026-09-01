/**
 * Watches the server's own published surface between hourly CI runs.
 *
 * `tools/watch-sources.mjs` already does this properly once an hour on CI, and
 * that is the durable record. This is the fast lane beside it.
 *
 * Its reason is a gap, not a rate: on 2026-09-01 the CI watcher ran at 05:09 and
 * again at 10:06, and `/llms.txt` had changed somewhere in between — 22,606
 * chars to 23,183, adding the official MCP endpoint. Nobody can say when inside
 * those five hours. (A third reading of 23,294 the same morning was this
 * author's own error: curl counts bytes and the manual is full of em dashes, so
 * that is the same document. Worth recording, since a watcher justified by a
 * miscount would be the exact fault it exists to catch.)
 *
 * Hayes had said the day before that functionality to "coordinate work and
 * prove its completion" was landing that week. Being an hour late to a faucet
 * route is the risk this closes, and the cost of closing it is nothing.
 *
 * Polling this often is not rude here, and that is not a judgement call: the
 * manual names these exact paths as the ones that "always answer even while you
 * are throttled" — never rate limited, by the server's own statement. They are
 * also the only paths worth watching, because the same manual asks nobody to
 * probe for unpublished routes, and a route cannot ship without appearing in
 * openapi.json first. So this reads what is published and guesses at nothing.
 *
 * One surface per call, in rotation. The cadence is then the surface count and
 * the caller's interval rather than a number anyone picked: six surfaces on a
 * per-minute cycle is the whole set every six minutes, and no single cycle ever
 * pays for more than one fetch.
 */
import crypto from 'node:crypto';

/**
 * The never-rate-limited set, in the order the manual lists them, minus the
 * ones that cannot carry a new capability. `/healthz` says only that the
 * process is up; `/` is the human page. The rest are where a faucet, a task
 * route or a work-proof convention would have to appear.
 */
export const SURFACES = [
  '/openapi.json',
  '/llms.txt',
  '/config',
  '/.well-known/agent.json',
  '/skill.md',
  '/patterns.md'
];

/**
 * Words that turn a documentation edit into something worth waking someone for.
 *
 * Bounded, because an unbounded `task` matches "multitasking" and an unbounded
 * `claim` matches "reclaimed" — the sibling watcher already learned that when
 * `mission` matched `room-permissions`. `spend` and `inference` are here on the
 * strength of the published teaser, which says the agent airdrop depends
 * "largely on what they spend on inference over the testnet": if that ever
 * becomes a route, those are the words it arrives under.
 */
export const CAPABILITY_SIGNALS =
  /\bfaucet\b|\btestnets?\b|\bairdrops?\b|\btasks?\b|\bquests?\b|\bbount(?:y|ies)\b|\bdrips?\b|\bclaims?\b|\bproofs?\b|\bprove\b|\bspends?\b|\binference\b|\brewards?\b|\battests?\b/i;

export function digestOf(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Lines present in one version and not the other.
 *
 * Deliberately a set difference and not a real diff: this reports what appeared,
 * and a reflowed paragraph reporting both its old and new wrapping is the
 * correct, honest output — the alternative is a diff library's guess about
 * which edit a human meant. Whitespace is collapsed first, so a line that only
 * moved between wraps does not read as new.
 */
export function whatChanged(before, after) {
  const linesOf = (text) => String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const was = new Set(linesOf(before));
  const now = new Set(linesOf(after));
  return {
    added: [...now].filter((line) => !was.has(line)),
    removed: [...was].filter((line) => !now.has(line))
  };
}

/** The added lines that name a capability, which is what makes a change urgent. */
export function signalsIn(added) {
  return (added || []).filter((line) => CAPABILITY_SIGNALS.test(line));
}

/**
 * Check exactly one surface and say what moved.
 *
 * A fetch that fails is recorded as a failure and never as "unchanged" — the
 * whole value of a watcher is that "we looked and nothing moved" and "we could
 * not look" are different sentences. This origin served 503s for a third of the
 * requests we made on the day this was written, so that case is the common one.
 */
export async function checkOneSurface({
  fetchFn,
  baseUrl = 'https://technocore.chat',
  state = {},
  index = 0,
  now = () => new Date().toISOString()
} = {}) {
  const surface = SURFACES[index % SURFACES.length];
  const url = `${String(baseUrl).replace(/\/+$/, '')}${surface}`;
  const previous = state[surface] || {};

  let body;
  try {
    const response = await fetchFn(url, { headers: { 'user-agent': 'FLOP-Evidence-Scout/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.text();
  } catch (err) {
    return {
      surface,
      action: 'check_failed',
      error: err.message,
      // Kept so a surface that has been blind for hours is visibly blind rather
      // than quietly absent from the report.
      consecutiveFailures: (previous.consecutiveFailures || 0) + 1,
      state: {
        ...state,
        [surface]: { ...previous, error: err.message, consecutiveFailures: (previous.consecutiveFailures || 0) + 1 }
      }
    };
  }

  const digest = digestOf(body);
  const record = { digest, chars: body.length, checkedAt: now(), body };
  const nextState = { ...state, [surface]: record };

  if (!previous.digest) {
    return { surface, action: 'baseline', chars: body.length, state: nextState };
  }
  if (previous.digest === digest) {
    return { surface, action: 'unchanged', chars: body.length, state: nextState };
  }

  const { added, removed } = whatChanged(previous.body, body);

  /**
   * Rewrapping is not news, and this watcher would otherwise be mostly news.
   *
   * The digest is over raw bytes, so it moves when a paragraph is rewrapped.
   * The 2026-09-01 manual edit was exactly that: seven of its eight hunks moved
   * a line break and changed no words. Reporting those as changes trains the
   * reader to ignore the one that matters, so a digest that moved with no line
   * added or removed is recorded as the new baseline and reported as nothing.
   */
  if (added.length === 0 && removed.length === 0) {
    return { surface, action: 'unchanged', chars: body.length, reflowed: true, state: nextState };
  }

  const signals = signalsIn(added);
  return {
    surface,
    action: signals.length ? 'capability_signal' : 'changed',
    was: previous.chars,
    chars: body.length,
    added: added.slice(0, 12),
    removed: removed.slice(0, 6),
    signals: signals.slice(0, 6),
    state: nextState
  };
}
