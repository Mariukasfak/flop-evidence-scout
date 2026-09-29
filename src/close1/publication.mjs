/**
 * Is the official archive actually PUBLISHING, or did it just catch up once?
 *
 * On 2026-09-29 the archive sat at sweep 766 for hours, then jumped to 1119 in
 * one batch (lag 9), then stopped again (lag 13 twenty minutes later). A lag
 * under a threshold in ONE cycle says nothing about whether a NEW trade would
 * later be auditable. So the archive gets a small state machine with memory:
 *
 *   STALLED     nothing has moved for a long time (or we have no history to say otherwise)
 *   RECOVERING  it moved after a stall, but one advance is not proof of a habit
 *   STABLE      several independent, regular advances since the recovery, and the lag stays small
 *
 * Only STABLE may support SAFE_RESUME_CANDIDATE (see decide() in tools/close1-forensics.mjs).
 * Nothing here is a trading permission; the operator lock is untouched.
 *
 * The limits are not tuned to a test. They come from how the archive behaves:
 * it publishes in batches, about an hour of sweeps at a time (see WINDOW_SWEEPS),
 * and we sample every 20 minutes. Derivations are next to each constant.
 */

export const PUBLICATION = Object.freeze({ STALLED: 'STALLED', RECOVERING: 'RECOVERING', STABLE: 'STABLE' });

/** An hour of sweeps at 5 minutes each: the archive's own batch size, so a lag this small is normal. */
export const WINDOW_SWEEPS = 12;
/** Silence that makes RECOVERING a STALL again: one batch interval (1 h) plus room for our own 20-minute sampling to be late. */
export const SILENCE_MS = 90 * 60_000;
/** A STABLE archive is allowed a longer quiet spell before we say STALLED (hysteresis): two batch intervals plus an hour of slack. */
export const STABLE_SILENCE_MS = 3 * 60 * 60_000;
/** Independent advances after the recovery one before we call it STABLE: three separate batches, not one. */
export const MIN_INDEPENDENT_ADVANCES = 3;
/** Lag at which an archive still lets a new trade be audited soon: two batches behind. */
export const STABLE_MAX_LAG = 2 * WINDOW_SWEEPS;
/** A STABLE archive that falls this far behind while still advancing has stopped keeping up: four batches. */
export const DEMOTE_LAG = 4 * WINDOW_SWEEPS;
const KEEP = 8;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Next publication state from the previous one and this cycle's archive reading.
 * `error` (index unreadable) keeps the previous state: an outage of our own view is not a publication event.
 */
export function publicationHealth(prev, { latest, live = null, lag = null, lastModified = null, nowMs, error = null }) {
  if (error || latest == null) {
    return prev ? { ...prev, note: 'archive index unreadable this cycle; state carried over' } : null;
  }
  const now = iso(nowMs);
  if (!prev || !prev.state) {
    // No history: the safe reading is "not proven", never STABLE.
    const state = lag != null && lag <= STABLE_MAX_LAG ? PUBLICATION.RECOVERING : PUBLICATION.STALLED;
    return {
      state, since: now, latest_seen: latest, last_advance_at: null, last_advance_from: null, last_advance_to: null, last_advance_jump: null,
      consecutive_advances: 0, independent_advances: 0, advances: [],
      reason: 'first observation: no history, so nothing is proven yet'
    };
  }
  const advanced = latest > (prev.latest_seen ?? -Infinity);
  const lastAdvMs = prev.last_advance_at ? Date.parse(prev.last_advance_at) : Date.parse(prev.since);
  const out = { ...prev, latest_seen: Math.max(latest, prev.latest_seen ?? latest), note: undefined };
  const set = (state, reason) => { if (state !== prev.state) out.since = now; out.state = state; out.reason = reason; return out; };

  if (advanced) {
    const gap = nowMs - lastAdvMs;
    const ev = { at: now, from: prev.latest_seen, to: latest, jump: latest - prev.latest_seen, last_modified: lastModified };
    out.advances = [...(prev.advances || []), ev].slice(-KEEP);
    out.last_advance_at = now; out.last_advance_from = ev.from; out.last_advance_to = ev.to; out.last_advance_jump = ev.jump;
    if (prev.state === PUBLICATION.STALLED || gap > SILENCE_MS) {
      out.consecutive_advances = 0; out.independent_advances = 0; out.recovery_last_modified = lastModified ? [lastModified] : [];
      return set(PUBLICATION.RECOVERING, `first advance after a stall (${ev.from} → ${ev.to}); one advance is not a habit`);
    }
    out.consecutive_advances = (prev.consecutive_advances ?? 0) + 1;
    const seen = new Set([...(prev.recovery_last_modified || []), ...(lastModified ? [lastModified] : [])]);
    out.recovery_last_modified = [...seen];
    // Independent = a different Last-Modified each time; without one, each distinct advance counts once.
    out.independent_advances = lastModified || prev.recovery_last_modified?.length ? Math.max(0, seen.size - 1) : out.consecutive_advances;
    if (prev.state === PUBLICATION.RECOVERING) {
      if (out.consecutive_advances >= MIN_INDEPENDENT_ADVANCES && out.independent_advances >= MIN_INDEPENDENT_ADVANCES && lag != null && lag <= STABLE_MAX_LAG) {
        return set(PUBLICATION.STABLE, `${out.independent_advances} independent advances since the recovery, lag ${lag}`);
      }
      return set(PUBLICATION.RECOVERING, `${out.independent_advances}/${MIN_INDEPENDENT_ADVANCES} independent advances since the recovery`);
    }
    // STABLE keeps advancing: only a runaway lag demotes it.
    if (lag != null && lag > DEMOTE_LAG) return set(PUBLICATION.STALLED, `advancing but ${lag} sweeps behind (more than ${DEMOTE_LAG})`);
    return set(PUBLICATION.STABLE, `advancing; lag ${lag ?? '?'}`);
  }

  // No advance this cycle.
  const silent = nowMs - lastAdvMs;
  if (prev.state === PUBLICATION.RECOVERING && silent > SILENCE_MS) return set(PUBLICATION.STALLED, `no advance for ${Math.round(silent / 60000)} min after a recovery`);
  if (prev.state === PUBLICATION.STABLE) {
    if (silent > STABLE_SILENCE_MS) return set(PUBLICATION.STALLED, `no advance for ${Math.round(silent / 60000)} min`);
    if (lag != null && lag > DEMOTE_LAG) return set(PUBLICATION.STALLED, `${lag} sweeps behind (more than ${DEMOTE_LAG})`);
  }
  return out;
}

/** Text for an operator: what changed between two publication states, or null when nothing did. */
export function publicationTransition(prev, next) {
  if (!prev?.state || !next?.state || prev.state === next.state) return null;
  return `close-1 archive publication ${prev.state} → ${next.state}: ${next.reason}`;
}

/** The Last-Modified age in minutes, or null. */
export const lastModifiedAgeMin = (lastModified, nowMs) => {
  const t = lastModified ? Date.parse(lastModified) : NaN;
  return Number.isFinite(t) ? Math.round((nowMs - t) / 60000) : null;
};
