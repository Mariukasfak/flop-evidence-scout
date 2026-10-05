/**
 * Stops the kibble lanes the moment the board says our work was not useful.
 *
 * A not-useful verdict costs -3 on a public ledger that never forgets, and the
 * only signal that one is coming is the verdict itself. On 2026-10-05 the lanes
 * were switched on for forty minutes and six answers drew fourteen of them,
 * which nobody saw until someone went looking. So this reads the tape, counts
 * fresh `not` verdicts on anything our keys delivered, and on the first one
 * writes a pause file the daemon honours before every kibble step. Resuming is
 * a person's decision: delete the file.
 *
 * It reads the room's export rather than /api/score on purpose. The score lags
 * by hours and folds in verdicts on work from before the guard was armed, so it
 * would pause the board for yesterday's answers. The tape shows exactly which
 * delivery a verdict is about, and when that delivery was made.
 */
import fs from 'node:fs';
import path from 'node:path';

import { reconstructBoard, resultHashFor, didsMatch } from './kibble.mjs';

export const PAUSE_FILE = 'kibble-paused.json';
export const GUARD_STATE_FILE = 'kibble-guard.json';

export const OUR_DIDS = Object.freeze([
  'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn',
  'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW'
]);

const isOurs = (did, ours) => Boolean(did) && ours.some((d) => didsMatch(did, d));

/** The tape's timestamps carry microseconds; trim to what Date.parse is specified to read. */
const toMs = (ts) => Date.parse(String(ts ?? '').replace(/(\.\d{3})\d+/, '$1'));

/**
 * Not-useful verdicts by other keys on our deliveries made at or after `since`.
 *
 * A verdict bound to a result hash counts only against the delivery it names;
 * an unbound one counts against our delivery on that job, since that is how the
 * scorer can read it too. Verdicts already in `seen` (by seq) are not repeated.
 */
export function freshMistakes(messages, { since, ours = OUR_DIDS, seen = new Set() }) {
  const sinceMs = toMs(since);
  const mistakes = [];
  for (const job of reconstructBoard(messages).values()) {
    const mine = job.results.filter((r) => isOurs(r.from, ours) && toMs(r.ts) >= sinceMs);
    if (!mine.length) continue;
    for (const a of job.attests) {
      if (a.verdict !== 'not' || isOurs(a.from, ours) || seen.has(a.seq)) continue;
      const target = a.resultHash
        ? mine.find((r) => resultHashFor(r.summary) === a.resultHash)
        : mine[0];
      if (!target) continue;
      mistakes.push({ jobId: job.jobId, seq: a.seq, by: a.from, reason: a.reason, deliveredAt: target.ts });
    }
  }
  return mistakes;
}

export function readPause(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, PAUSE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function writePause(dataDir, pause) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, PAUSE_FILE), JSON.stringify(pause, null, 2), 'utf8');
}
