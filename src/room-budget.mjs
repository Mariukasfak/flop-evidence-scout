/**
 * Whether this machine may still open a new room today.
 *
 * Measured 2026-09-03. Every write into a tclk deal room came back with
 *
 *   HTTP 400 room limit reached (81920 is the cap, and this would be a new one)
 *
 * and the message is misleading in a way that cost real time. The service was
 * nowhere near that cap: `/rooms` reported 54,456 rooms of 81,920 and 779.9 MB
 * of the 5 GiB room-storage budget, and `/r/events` showed other agents
 * creating rooms at two a minute — one of them eighteen seconds after our own
 * refusal. Whatever we were hitting was ours, not the service's.
 *
 * The only per-client knob in `/config` is `rate_rooms_per_day: 20`, "new rooms
 * per day per client IP". It fits: one deal room was created successfully at
 * 12:39Z on 2026-09-02 (mb-p-tclk-951dd1dfec9139b2, one message in it), and
 * every deal room attempted since exists nowhere — eight of them today, each
 * probed and each returning count 0.
 *
 * That is a strong explanation rather than a proved one, so this file does not
 * try to model the budget. It reacts to the refusal: the server said no, so
 * stop asking until the day turns. A counter we maintained ourselves would
 * disagree with the server's the first time a retry was charged differently
 * than we guessed, and then we would be pacing against a number we invented.
 *
 * What this is really protecting is not the quota but the deals. A tclk deal
 * room is created by whichever party writes into it first, and ours was being
 * spent on `cancel` frames for deals that had already died — announcing that
 * nothing happened, in a room that existed only to hold the announcement.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The server's own words when a new room is refused. There are two of them.
 *
 * technocore-chat 0.11.4 refuses a room two different ways, and until
 * 2026-09-04 this only knew the first:
 *
 *   400  room limit reached (<cap> is the cap, and this would be a new one)
 *        — service-wide `max_rooms`, fail-closed. A moving boundary: idle rooms
 *          are reaped continuously and each freed slot is taken within seconds,
 *          so /rooms reading well under the cap an hour later says nothing about
 *          whether it was reached at the instant of the refusal.
 *
 *   429  room-creation budget spent: … this IP has created its 20 rooms for the
 *        day — the per-client `new_rooms_per_day_per_ip`, with Retry-After.
 *
 * Missing the 429 was the worse half: a budget refusal would not have been
 * recognised as one, so the lane would have retried into it every cycle, which
 * is the exact failure this module exists to stop. Distinction and status codes
 * documented by the technocore maintainer on flop-labs/tclk#61.
 */
const REFUSAL = /room limit reached|would be a new one|room-creation budget spent|rooms for the day/i;

export function isRoomCreationRefusal(error) {
  return REFUSAL.test(String(error?.message ?? error ?? ''));
}

/**
 * Midnight UTC after `nowMs` — when a per-day budget would reset.
 *
 * The server does not publish which boundary it uses, so this is the plain
 * reading of "per day". Being wrong here costs a few hours of not trying, and
 * the alternative — retrying into a refusal every minute — costs a request per
 * cycle and teaches nothing.
 */
export function nextDayBoundary(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function loadBudget(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      blockedUntilMs: Number(parsed?.blockedUntilMs) || 0,
      refusals: Number(parsed?.refusals) || 0,
      lastRefusalAt: typeof parsed?.lastRefusalAt === 'string' ? parsed.lastRefusalAt : null
    };
  } catch {
    return { blockedUntilMs: 0, refusals: 0, lastRefusalAt: null };
  }
}

export function saveBudget(budget, filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.writing`;
    fs.writeFileSync(temp, JSON.stringify(budget), 'utf8');
    fs.renameSync(temp, filePath);
    return true;
  } catch {
    return false;
  }
}

/** May we open a new room right now? */
export function canOpenRoom(budget, nowMs) {
  return !(budget.blockedUntilMs > nowMs);
}

/** Record a refusal and stand down until the day turns. */
export function recordRefusal(budget, nowMs) {
  return {
    blockedUntilMs: nextDayBoundary(nowMs),
    refusals: (budget.refusals || 0) + 1,
    lastRefusalAt: new Date(nowMs).toISOString()
  };
}

/** How long the stand-down has left, in whole minutes, for a log line. */
export function minutesBlocked(budget, nowMs) {
  return Math.max(0, Math.ceil((budget.blockedUntilMs - nowMs) / 60_000));
}
