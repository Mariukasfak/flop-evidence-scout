import fs from 'node:fs';
import path from 'node:path';

/**
 * Which offers are worth a deal slot, measured rather than guessed.
 *
 * Measured 2026-09-03 over the whole life of `tclk-offers` (`/r/<room>/export`,
 * 5,204 records, 2026-09-02T07:12Z onward) with every derived deal room probed:
 * 1,556 accepted deals, 278 of them cleanly claimed — a baseline of **17.9%**.
 *
 * Three signals separate the 278 from the rest. Each is a refusal, never a
 * preference, because the room supplies far more offers than one deal slot can
 * use and the cost of a wrong accept is five minutes of standing still.
 *
 *   payer already tried and never finished   6.5% clean   <- the expensive one
 *   payer's first appearance                30.5%
 *   payer has finished at least one         61.8%
 *
 * Together with the dead protocols below, the rule keeps 78% of every clean
 * deal in the room while cutting what we accept from 1,556 to 522 — **41.4%**
 * clean, against a 17.9% baseline. It was checked the other way round too: a
 * stricter rule (only proven payers, or only short claim windows) scores
 * 62-71% but catches under a quarter of the deals, and replayed over our own
 * history it would have thrown away the one deal we actually completed.
 */

/**
 * Protocols that have never once produced a claimed deal.
 *
 * Only shapes with a real sample are listed. `acp` (77 deals), `tdex1` (12) and
 * offers naming no protocol at all (98) are 0-for-187 between them. Everything
 * else that scores zero does so on a single observation, which is noise, not
 * evidence — those are left alone deliberately.
 */
export const DEAD_PROTOS = new Set(['acp', 'tdex1']);

/**
 * A rule that was measured and then thrown away, written down so it is not
 * rediscovered: offers between 100 and 10,000 settle 0.8% of the time (2 in
 * 266), against 28.7% below 100 and 20.2% at the million-and-up convention.
 * It looks decisive and it is not. One payer accounts for 100 of those 266,
 * the top three for 47%, and the burned-payer rule already removes 170 of
 * them; across the 59 that survive both filters the band explains nothing
 * further. It was a proxy for a handful of spammers, so the spammers are what
 * we filter.
 */

/**
 * How many contract ids we remember having counted.
 *
 * The board is a ring: measured 2026-09-04, `/r/tclk-offers/export` held 5.9
 * hours (8.99 MiB, seq 34751-49700) where the day before it held 25. So a scan
 * sees a moving window, and the only way a count over "every deal we ever saw"
 * survives is to remember which deals are already in it. 50k ids is weeks of
 * this room at 43 records a minute, and the oldest are the ones the venue
 * itself has long since dropped.
 */
export const SEEN_LIMIT = 50_000;

export function emptyReputation() {
  return { updatedAt: null, payers: {}, seen: [] };
}

export function loadReputation(file) {
  if (!file) return emptyReputation();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.payers !== 'object' || !parsed.payers) {
      return emptyReputation();
    }
    return {
      updatedAt: parsed.updatedAt ?? null,
      payers: parsed.payers,
      seen: Array.isArray(parsed.seen) ? parsed.seen : []
    };
  } catch {
    // A reputation we cannot read is a reputation we do not have. Never fatal:
    // the lane must keep working on the day this file is first introduced.
    return emptyReputation();
  }
}

export function saveReputation(rep, file) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(rep, null, 1));
  fs.renameSync(temp, file);
}

/**
 * One more deal for this payer, and whether it ended claimed.
 *
 * `contract` makes it idempotent, which matters because two writers count the
 * same deals: this lane as each of its own closes, and the scan every few hours
 * over a window that overlaps the last one. Without it a payer's `tried` climbs
 * by one per scan for a deal that happened once. Called without a contract the
 * count still lands -- older callers and tests keep working -- it just cannot
 * be deduplicated.
 */
export function recordOutcome(rep, payer, completed, contract = null) {
  if (!payer) return rep;
  const seen = Array.isArray(rep.seen) ? rep.seen : [];
  if (contract && seen.includes(contract)) return rep;          // already counted
  const payers = { ...rep.payers };
  const prior = payers[payer] || { tried: 0, done: 0 };
  payers[payer] = { tried: prior.tried + 1, done: prior.done + (completed ? 1 : 0) };
  const nextSeen = contract ? [...seen, contract].slice(-SEEN_LIMIT) : seen;
  return { updatedAt: new Date().toISOString(), payers, seen: nextSeen };
}

/**
 * A payer who has had at least one chance and has never taken it.
 *
 * Not "has failed once": a payer's *first* appearance is the second-best signal
 * in the room (30.5%), so an unknown payer is welcome. It is the proven
 * non-finisher that costs us — 952 such deals in the room, 6.5% clean.
 */
export function isBurned(rep, did) {
  const r = rep?.payers?.[did];
  return Boolean(r && r.tried > 0 && r.done === 0);
}

/** A payer who has finished at least one deal with somebody. */
export function isTrusted(rep, did) {
  const r = rep?.payers?.[did];
  return Boolean(r && r.done > 0);
}

/** The offer shapes that have never once settled. */
export function offerLooksAlive(offer) {
  const proto = offer?.job?.proto;
  if (!proto) return false;                       // 98 deals, 0 clean
  if (DEAD_PROTOS.has(proto)) return false;
  return true;
}
