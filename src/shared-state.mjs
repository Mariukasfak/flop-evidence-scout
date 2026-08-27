/**
 * One activity record, written by every machine that runs this agent.
 *
 * With the agent running both on a home PC and in GitHub Actions, the numbers
 * split in a way that is worse than merely incomplete — it is misleading. The
 * duty-cycle monitor reads docs/audit-history.json, which only ever contains
 * cloud runs, so once a local process starts covering the gaps the monitor keeps
 * reporting 18% while the truth is far better. A metric that gets *more* wrong as
 * the system improves is the worst kind.
 *
 * And the airdrop-critical figure is worse still. The inference ledger lives in
 * data/, which is gitignored, and a CI runner is destroyed after every job — so
 * cloud-side inference would vanish entirely, and the local ledger only knows
 * about one machine.
 *
 * The fix is the same one this project already uses for turn counters: put the
 * shared truth on the server, where both writers can reach it. This is that
 * record — a rolling list of who ran when, plus cumulative totals, in a single
 * Technocore note.
 *
 * Concurrent updates are safe because the write is a compare-and-set. That was
 * supposed to be impossible: this project's own field guide records that `?if=`
 * "never matches". The real cause was framing — getKv() JSON-parses anything
 * that parses, so the exact stored string could not be handed back to `if=`.
 * TechnocoreClient.readNote() returns the raw stored value, which makes
 * conditional JSON notes work. Verified against the live server.
 */

import { getDidShardedPath } from './identity.mjs';

export const ACTIVITY_NS = 'scout';
export const RECORD_VERSION = 1;

/**
 * How many cycles to keep.
 *
 * Notes cap at 8192 characters. Each entry is roughly seventeen — `[29796930,"gh"]`
 * plus a comma — so 250 costs about 4.3 KB and leaves comfortable headroom for
 * the totals and for the cap moving. writeActivity() also measures before
 * writing rather than trusting this arithmetic.
 */
export const MAX_CYCLES = 250;
const NOTE_CHAR_CAP = 8192;
const SAFE_CHARS = 6000;

/** Two characters per holder, because the ring is the thing that grows. */
export function holderCode(holder = '') {
  const label = String(holder).toLowerCase();
  if (label.startsWith('github') || label.startsWith('gh')) return 'gh';
  if (label.startsWith('local') || label.startsWith('lo')) return 'lo';
  return 'xx';
}

export function activityKey(did) {
  return `activity-${getDidShardedPath(did).fingerprint}`;
}

const toMinutes = (ms) => Math.floor(ms / 60_000);

export function emptyRecord() {
  return { v: RECORD_VERSION, cycles: [], totals: {}, spend: { flop: 0, sessions: 0 }, at: null };
}

/**
 * Read the shared record, and the exact string it is stored as.
 *
 * The raw value is what a conditional write needs; without it the caller can
 * only clobber. Returns `reachable: false` rather than an empty record when the
 * server cannot be reached — the distinction that cost us a wrong diagnosis once
 * already.
 */
export async function readActivity(client, did) {
  const key = activityKey(did);

  if (typeof client.readNote !== 'function') {
    const parsed = await client.getKv(ACTIVITY_NS, key);
    return { reachable: true, raw: null, record: normalise(parsed) };
  }

  const note = await client.readNote(ACTIVITY_NS, key);
  if (!note.reachable) return { reachable: false, raw: null, record: emptyRecord(), error: note.error };
  if (!note.found) return { reachable: true, raw: null, record: emptyRecord() };

  let parsed = null;
  try { parsed = JSON.parse(note.value); } catch { parsed = null; }
  return { reachable: true, raw: note.value, record: normalise(parsed) };
}

/** Accept anything, return something with the right shape. */
function normalise(parsed) {
  const base = emptyRecord();
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    v: RECORD_VERSION,
    cycles: Array.isArray(parsed.cycles) ? parsed.cycles.filter((c) => Array.isArray(c) && c.length === 2) : [],
    totals: parsed.totals && typeof parsed.totals === 'object' ? { ...parsed.totals } : {},
    spend: {
      flop: Number(parsed.spend?.flop) || 0,
      sessions: Number(parsed.spend?.sessions) || 0
    },
    at: typeof parsed.at === 'string' ? parsed.at : null
  };
}

/** Add one cycle to a record, trimming the ring and keeping the totals. */
export function withCycle(record, { holder, at = Date.now(), spendFlop = 0, sessions = 0 } = {}) {
  const code = holderCode(holder);
  const next = {
    v: RECORD_VERSION,
    cycles: [...record.cycles, [toMinutes(at), code]].slice(-MAX_CYCLES),
    totals: { ...record.totals, [code]: (record.totals[code] || 0) + 1 },
    spend: {
      flop: (record.spend.flop || 0) + (Number(spendFlop) || 0),
      sessions: (record.spend.sessions || 0) + (Number(sessions) || 0)
    },
    at: new Date(at).toISOString()
  };
  return next;
}

/**
 * Record this cycle, retrying if another machine wrote first.
 *
 * Read-modify-write with a compare-and-set, so a lost race means re-reading and
 * re-applying rather than overwriting the other machine's cycle. Failing to
 * record a cycle must never fail the cycle itself, so callers treat this as
 * best-effort; the return value says what happened.
 */
export async function recordCycle(client, did, { holder, at = Date.now(), spendFlop = 0, sessions = 0, attempts = 3 } = {}) {
  const key = activityKey(did);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await readActivity(client, did);
    if (!current.reachable) return { recorded: false, reason: `server unreachable (${current.error || 'unknown'})` };

    const next = withCycle(current.record, { holder, at, spendFlop, sessions });
    let payload = JSON.stringify(next);

    // Measure rather than trust the arithmetic above; the cap can move.
    while (payload.length > SAFE_CHARS && next.cycles.length > 10) {
      next.cycles = next.cycles.slice(Math.ceil(next.cycles.length / 4));
      payload = JSON.stringify(next);
    }
    if (payload.length > NOTE_CHAR_CAP) {
      return { recorded: false, reason: `record would exceed the ${NOTE_CHAR_CAP}-char note cap` };
    }

    try {
      if (current.raw === null) {
        await client.setKv(ACTIVITY_NS, key, payload, { ifAbsent: true });
      } else {
        await client.setKv(ACTIVITY_NS, key, payload, { ifValue: current.raw });
      }
      return { recorded: true, record: next, attempts: attempt + 1 };
    } catch (err) {
      // Someone else recorded a cycle between our read and our write. Re-read
      // and re-apply, so their cycle survives and so does ours.
      if (attempt === attempts - 1) {
        return { recorded: false, reason: `lost ${attempts} races: ${err.message}` };
      }
    }
  }
  return { recorded: false, reason: 'exhausted attempts' };
}

/**
 * What the combined record says.
 *
 * Duty cycle here is honest in a way the file-based one could not be: it counts
 * cycles from every machine, so covering a gap locally actually shows up as
 * coverage instead of leaving the metric stuck at the cloud's figure.
 */
export function summariseActivity(record, { cadenceMin = 15, now = Date.now() } = {}) {
  const cycles = [...(record.cycles || [])].sort((a, b) => a[0] - b[0]);
  const byHolder = {};
  for (const [, code] of cycles) byHolder[code] = (byHolder[code] || 0) + 1;

  if (cycles.length < 2) {
    return { cycles: cycles.length, byHolder, totals: record.totals || {}, spend: record.spend, dutyCycle: null, windowHours: 0 };
  }

  const firstMin = cycles[0][0];
  const lastMin = cycles[cycles.length - 1][0];
  const spanMin = Math.max(1, lastMin - firstMin);
  const expected = Math.max(1, Math.round(spanMin / cadenceMin));

  const gaps = [];
  for (let i = 1; i < cycles.length; i++) gaps.push(cycles[i][0] - cycles[i - 1][0]);
  gaps.sort((a, b) => a - b);

  return {
    cycles: cycles.length,
    byHolder,
    totals: record.totals || {},
    spend: record.spend,
    windowHours: spanMin / 60,
    expected,
    dutyCycle: Math.min(1, cycles.length / expected),
    medianGapMin: gaps[Math.floor(gaps.length / 2)],
    worstGapMin: gaps[gaps.length - 1],
    ageMin: toMinutes(now) - lastMin,
    /** Which machine is actually carrying the load, as a share of cycles. */
    share: Object.fromEntries(Object.entries(byHolder).map(([k, v]) => [k, v / cycles.length]))
  };
}
