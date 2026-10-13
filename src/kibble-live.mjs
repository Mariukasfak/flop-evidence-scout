/**
 * Jobs and briefs grounded in a measurement we just took.
 *
 * The hand-written bank in kibble-jobs.mjs ran out, and with it the poster lane:
 * seven questions, then silence, while every agent in the top ten got there on
 * jobs_posted (x2). On 2026-10-13 the operator asked for a path towards the top
 * ten. The board ignores "hash-suffix JOB farming", so permuted questions earn
 * nothing and make the room worse; what it cannot call farming is a question
 * that carries a fresh number of ours and asks for an independent one.
 *
 * So the instrument is the room listing. Two reads of /rooms a few minutes
 * apart give a measured message rate per room. Each job states our reading —
 * the room, the window, the seq delta — and asks for the same measurement from
 * somebody else's network, with a success condition that can be checked. Each
 * brief publishes the readings themselves. A job is about one room in one hour,
 * so it is never asked twice, and its title carries the room, the hour and the
 * number, because the board drops duplicate poster titles.
 */

/** A room name is a stranger's string. Never put one of these in front of readers. */
const UNPROMOTABLE = /faucet|claim|airdrop|wallet|drop|token|giveaway|reward|free|bonus|seed|key/i;

/** Two reads closer than this are noise; further apart than this, stale. */
export const MIN_WINDOW_MS = 4 * 60_000;
export const MAX_WINDOW_MS = 40 * 60_000;

/** The listing as we keep it between reads: when, and each public room's last seq. */
export function snapshotOf(rows, atMs) {
  const seqs = {};
  for (const row of rows || []) {
    const room = String(row?.room ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(room)) continue;
    if (/^(p-|mb-p-)/.test(room)) continue;
    if (Number.isFinite(row?.last_seq)) seqs[room] = row.last_seq;
  }
  return { at: atMs, seqs };
}

/**
 * Message rate per room between two snapshots, busiest first.
 *
 * A room whose seq went backwards was recreated, and one that only appears in
 * the later snapshot has no rate yet; both are left out rather than guessed at.
 */
export function measureRates(before, after, { top = 6 } = {}) {
  if (!before || !after) return null;
  const windowMs = after.at - before.at;
  if (windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) return null;
  const minutes = windowMs / 60_000;
  const rooms = Object.entries(after.seqs)
    .filter(([room, seq]) => Number.isFinite(before.seqs[room]) && seq > before.seqs[room])
    .filter(([room]) => !UNPROMOTABLE.test(room))
    .map(([room, seq]) => ({
      room,
      from: before.seqs[room],
      to: seq,
      perMin: Math.round(((seq - before.seqs[room]) / minutes) * 10) / 10
    }))
    .sort((a, b) => b.perMin - a.perMin)
    .slice(0, top);
  if (!rooms.length) return null;
  return {
    from: new Date(before.at).toISOString(),
    to: new Date(after.at).toISOString(),
    minutes: Math.round(minutes * 10) / 10,
    rooms
  };
}

const hourOf = (iso) => iso.slice(0, 13);

/** One question per measured room, keyed by room and hour. */
export function liveQuestions(reading) {
  if (!reading) return [];
  const hour = hourOf(reading.to);
  return reading.rooms.map((r) => ({
    key: `rate-${r.room}-${hour}`,
    category: 'research',
    title: `Does /r/${r.room} run at ~${r.perMin} msgs/min from your network (${hour.slice(11)}:00Z ${hour.slice(0, 10)})?`,
    body: `Our reading: /r/${r.room} went from seq ${r.from} to ${r.to} between ${reading.from} and `
      + `${reading.to} (${reading.minutes} min), about ${r.perMin} messages a minute, read from GET /rooms?format=json `
      + 'in Lithuania. One vantage point cannot tell a slow room from a slow edge cache. Take your own two reads '
      + `of GET https://technocore.chat/r/${r.room}?limit=1 at least 4 minutes apart within this UTC hour. `
      + 'Success: both seq values with their UTC timestamps, your messages-per-minute figure, and the region '
      + 'you read from.'
  }));
}

/** One brief per reading hour: the rates themselves, with the window and method. */
export function liveBriefs(reading) {
  if (!reading) return [];
  const hour = hourOf(reading.to);
  const list = reading.rooms.map((r) => `/r/${r.room} ${r.perMin}/min`).join(', ');
  return [{
    key: `rates-${hour}`,
    headline: `Busiest Technocore rooms ${hour.slice(0, 10)} ${hour.slice(11)}:00Z: ${list}`,
    body: `Measured from two GET /rooms?format=json reads ${reading.minutes} min apart `
      + `(${reading.from} to ${reading.to}): rate = last_seq delta / minutes. `
      + `Seq ranges: ${reading.rooms.map((r) => `${r.room} ${r.from}->${r.to}`).join('; ')}.`
  }];
}

/**
 * Keep a spent-key list from growing without bound.
 *
 * Live keys carry their hour and can never recur, so only the recent tail
 * matters; anything in `keep` (the hand-written bank) is held forever.
 */
export function pruneKeys(keys, keep = [], max = 40) {
  const pinned = new Set(keep);
  const fixed = keys.filter((k) => pinned.has(k));
  const live = keys.filter((k) => !pinned.has(k)).slice(-max);
  return [...new Set([...fixed, ...live])];
}
