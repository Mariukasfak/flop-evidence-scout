/**
 * Faucet-day preflight: what works, what we must fix, and what is not ours to fix.
 *
 * The testnet is ninety days and the airdrop is scored on cumulative spend, so
 * the expensive failure is not being slow — it is discovering on day one that a
 * link in the chain was never tested. This walks every link and reports one of
 * three states, and the split between the last two is the whole point:
 *
 *   READY    verified against something real, right now
 *   ACTION   ours to fix, with the fix named
 *   BLOCKED  waiting on Flop Labs; no amount of work here changes it
 *
 * A check that cannot verify something reports ACTION or BLOCKED. It never
 * reports READY on the strength of a local file that says so — this project has
 * been caught by that twice, once when the daemon's state was silently never
 * persisting and once when the source watcher was blind for days while exiting 0.
 *
 * Run: node tools/readiness.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity, getDidShardedPath, getStateKey } from '../src/identity.mjs';
import { selectBackend } from '../src/inference-backends.mjs';
import { ledgerTotals, DEFAULT_LEDGER_PATH } from '../src/inference-ledger.mjs';
import { FACTS_ROOM } from '../src/flop-facts.mjs';
import { FEED_ROOM } from '../src/telemetry-feed.mjs';

const BASE = process.env.TECHNOCORE_URL || 'https://technocore.chat';
const OUT = path.resolve('docs/readiness.json');

const READY = 'READY';
const ACTION = 'ACTION';
const BLOCKED = 'BLOCKED';

/**
 * Retry what is worth retrying, because this report is read as a verdict.
 *
 * A single 503 turned "Scout identity published" into a TODO, "the telemetry
 * room" into "does not exist yet", and the whole board from 12 ready into 8 —
 * while every one of those things was fine. The agent's own logs recorded 67
 * server 503s in one night, so a one-shot read makes this report mostly a
 * measure of the server's mood.
 *
 * A 5xx or a transport fault is the server having a moment; a 404 is an answer
 * and is returned immediately, because "this route does not exist" is exactly
 * what several of these checks are asking.
 */
async function get(pathname, { attempts = 3 } = {}) {
  let last = { ok: false, status: 0, text: 'not attempted' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${BASE}${pathname}`, {
        headers: { 'user-agent': 'FLOP-Scout-Readiness/1.0 (+github.com/Mariukasfak/flop-evidence-scout)' },
        signal: AbortSignal.timeout(15_000)
      });
      const text = await res.text();
      // Strip the untrusted-content banner; it is framing, not content.
      last = { ok: res.ok, status: res.status, text: text.replace(/^!!.*$/m, '').trim() };
      if (res.ok || res.status < 500) return last;
    } catch (err) {
      last = { ok: false, status: 0, text: err.message };
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  return last;
}

const checks = [];
const record = (id, label, state, detail, fix = null) => {
  checks.push({ id, label, state, detail, fix });
};

async function main() {
  const scout = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
  const scribe = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');

  // ---------------------------------------------------------------- identity
  for (const [name, identity] of [['Scout', scout], ['Scribe', scribe]]) {
    const { fullPath } = getDidShardedPath(identity.did);
    const profile = await get(fullPath);
    record(
      `did-${name.toLowerCase()}`,
      `${name} identity published`,
      profile.ok && profile.text.includes('did:') ? READY : ACTION,
      profile.ok ? `${fullPath} resolves` : `${fullPath} → ${profile.status || profile.text}`,
      'Run the daemon once so it republishes its DID note.'
    );
  }

  /**
   * State surviving a restart is the one thing that must not be assumed.
   *
   * The CI runner is destroyed every fifteen minutes. For weeks the turn counter
   * silently restarted at one, because state was written to a key the server
   * rejected with a 400 nobody read. A turn count above one, read back off the
   * live server, is the only honest proof this works.
   */
  const stateKey = getStateKey(scout.did, 'scout');
  const state = await get(`/kv/scout/${stateKey}`);
  let turns = null;
  try { turns = JSON.parse(state.text).totalTurns; } catch { /* not JSON yet */ }
  /**
   * A state note that has outgrown the note limit stops persisting silently.
   *
   * It happened: answeredAuthors grew unbounded to 199 entries and 8,159 of
   * 8,192 characters, every write started failing with 400, and the only sign
   * was a line in a log nobody was reading. A turn count alone cannot catch it,
   * because the count keeps looking plausible while going backwards.
   */
  const NOTE_CAP = 8192;
  const stateNote = await new (await import('../src/technocore-client.mjs')).TechnocoreClient({ baseUrl: BASE })
    .readNote('scout', stateKey);
  const stateBytes = stateNote.reachable && stateNote.found ? String(stateNote.value).length : 0;
  record(
    'state-size',
    'State note fits the server limit',
    stateBytes > 0 && stateBytes < NOTE_CAP * 0.9 ? READY : ACTION,
    stateBytes === 0 ? 'no state note readable' : `${stateBytes} of ${NOTE_CAP} characters`,
    'answeredAuthors is pruned by cooldown age on every save. If this is near the cap, '
    + 'something else in the state is growing without bound.'
  );

  /**
   * Collaboration between the two agents, as something a stranger can check.
   *
   * Flop Labs is reported to be preparing a mechanism that rewards agents
   * collaborating over Technocore. Whatever the rules turn out to be, the thing
   * worth holding is evidence: two keys signing statements about the same
   * messages, in a world-readable note. `mutual` is the honest measure — one key
   * producing many signatures is one agent, however many it produces.
   */
  try {
    const { readRecord, summariseRecord } = await import('../src/collaboration.mjs');
    const collabClient = new (await import('../src/technocore-client.mjs')).TechnocoreClient({ baseUrl: BASE, readOnly: true });
    const { reachable, record: collabRecord } = await readRecord(collabClient, scout.did, scribe.did);
    const collab = reachable ? summariseRecord(collabRecord) : null;

    record(
      'collaboration',
      'Agent collaboration is on record',
      collab?.mutual ? READY : ACTION,
      !reachable
        ? 'Technocore unreachable — nothing checked'
        : `${collab.verified} verified, ${collab.rejected} rejected, ${collab.distinctAcknowledgers} distinct acknowledger(s)`,
      'Each peer sync is acknowledged by signing what was received into '
      + '/kv/flop-scout-collab. Mutual means both keys have signed; until the other agent '
      + 'acknowledges too, this is one agent attesting. Check it with tools/verify-collab.mjs.'
    );
  } catch (err) {
    record('collaboration', 'Agent collaboration is on record', ACTION, `could not be read: ${err.message}`,
      'Run tools/verify-collab.mjs to see the record directly.');
  }

  record(
    'state-persistence',
    'State survives restarts',
    Number(turns) > 1 ? READY : ACTION,
    turns == null ? 'no readable state note yet' : `${turns} turns recorded on the server`,
    'The daemon must complete at least two turns and write state to /kv/.'
  );

  // ------------------------------------------------------------------- rooms
  for (const room of [FACTS_ROOM, FEED_ROOM]) {
    const owner = await get(`/kv/room-owners/${room}`);
    const live = await get(`/r/${room}?limit=1`);
    const claimed = owner.ok && owner.text.includes('did:');
    const exists = live.ok && live.text.includes('# room');

    /**
     * A server that will not answer is not a room that is not there.
     *
     * After three retries this still reported "does not exist yet" on a 503,
     * while the room held 41 messages. Absence of evidence and evidence of
     * absence read identically in that sentence, which is the mistake this
     * project has now made in four separate checks.
     */
    const unreachable = !live.ok && (live.status === 0 || live.status >= 500);
    const detail = unreachable
      ? `${claimed ? 'claimed' : 'ownership unreadable'}, existence not checked — server returned ${live.status || 'no response'}`
      : `${claimed ? 'claimed' : 'not claimed'}, ${exists ? 'exists' : 'does not exist yet'}`;

    record(
      `room-${room}`,
      `Room /r/${room}`,
      exists && claimed ? READY : (unreachable ? BLOCKED : ACTION),
      detail,
      unreachable
        ? 'Technocore was unreachable. Re-run when it answers; nothing here is ours to fix.'
        : 'Room creation is refused while the service-wide room cap is full; the daemon retries.'
    );
  }

  // --------------------------------------------------------------- inference
  const { backend, real } = await selectBackend({});
  record(
    'inference-backend',
    'A real model is reachable',
    real ? READY : ACTION,
    `backend: ${backend.id}${backend.model ? ` (${backend.model})` : ''}`,
    'Two ways, either works. Free API: put a key from console.groq.com into '
    + '.secrets/inference-api.json (and the same key into the INFERENCE_API_KEY repo secret '
    + 'so cloud runs use it too). Local: install Ollama and pull qwen2.5:3b. Rehearsal either '
    + 'way — real latency, real tokens, real failures, zero $FLOP earned yet.'
  );

  /**
   * Every ledger under data/, not just the default path.
   *
   * The daemon writes its receipts under whatever --data-dir it was given, and
   * the local launcher uses data/local so it never dirties the repository. This
   * check was reading only data/inference-receipts.jsonl, so it reported twelve
   * receipts from an old bench run while the agent was busy writing hundreds
   * beside it. A readiness check looking in the wrong place is worse than none.
   */
  const ledgerPaths = [];
  const findLedgers = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findLedgers(full, depth + 1);
      else if (entry.name === 'inference-receipts.jsonl') ledgerPaths.push(full);
    }
  };
  findLedgers(path.resolve('data'));

  const ledger = ledgerPaths.reduce((sum, p) => {
    const t = ledgerTotals(p);
    return {
      receiptsOnDisk: sum.receiptsOnDisk + t.receiptsOnDisk,
      counted: sum.counted + t.counted,
      simulated: sum.simulated + t.simulated,
      signatureRejected: sum.signatureRejected + t.signatureRejected,
      malformedLines: sum.malformedLines + t.malformedLines,
      spendFlop: sum.spendFlop + (t.spendFlop || 0)
    };
  }, { receiptsOnDisk: 0, counted: 0, simulated: 0, signatureRejected: 0, malformedLines: 0, spendFlop: 0 });

  const ledgerHealthy = ledger.malformedLines === 0 && ledger.signatureRejected === 0;
  record(
    'ledger',
    'Spend ledger is intact',
    ledger.receiptsOnDisk === 0 ? ACTION : (ledgerHealthy ? READY : ACTION),
    /**
     * The spend figure belongs on the same line as the receipt count.
     *
     * Eight thousand signed receipts reads like progress, and on its own it
     * invites exactly the wrong conclusion. Every one of them was paid for with
     * electricity on the operator's own machine: feeFlop is 0, because there is
     * no official inference endpoint to charge anything, and the airdrop is
     * scored on official testnet spend. Separating the two numbers by a screen
     * is how a rehearsal starts getting counted as the performance.
     */
    `${ledger.receiptsOnDisk} receipts across ${ledgerPaths.length} ledger(s), ${ledger.counted} counted, `
    + `${ledger.simulated} simulated, ${ledger.signatureRejected} rejected, ${ledger.malformedLines} malformed`
    + ` — official FLOP spent: ${ledger.spendFlop} (no paid endpoint exists yet)`,
    ledger.receiptsOnDisk === 0
      ? 'Run the agent, or tools/inference-bench.mjs, to start the ledger.'
      : 'Investigate rejected or malformed receipts before trusting the total.'
  );

  // ----------------------------------------------------------------- watcher
  const statePath = path.resolve('docs/watch/state.json');
  let watchState = null;
  let watchError = null;
  try {
    watchState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    watchError = err.message;
  }
  const watchedIds = watchState ? Object.keys(watchState.sources || {}) : [];
  const watchOk = watchState && watchedIds.includes('flop-teaser') && watchedIds.includes('openapi');

  /**
   * A source we cannot read is not a source we are watching.
   *
   * This line said "11 sources baselined" while one of them had been answering
   * the hourly runner with a 403 for days. The count was true and the sentence
   * was not, which is the more expensive kind of wrong: nothing to investigate,
   * because nothing looked broken.
   */
  const blind = watchState
    ? Object.entries(watchState.sources || {})
      // Two ways to be blind. Six failures in a row is a source that used to
      // work; no digest at all is one that never has — it has nothing to
      // compare against, so it could not report a change even in principle,
      // and waiting six hours to say so would only delay the truth.
      .filter(([, v]) => v.error && ((v.consecutiveFailures || 0) >= 6 || !v.digest))
      .map(([id, v]) => `${id} (${v.error})`)
    : [];

  const watchDetail = watchError
    ? `UNREADABLE: ${watchError}`
    : blind.length
      ? `${watchedIds.length} baselined, ${blind.length} blind: ${blind.join(', ')}`
      : `${watchedIds.length} sources baselined`;

  record(
    'source-watch',
    'Source watcher baseline is readable',
    watchOk && blind.length === 0 ? READY : ACTION,
    watchDetail,
    blind.length
      ? 'A blind source keeps its last digest, so it can never report a change. Check whether the block is on the runner IP; if it is, the source cannot be watched from CI at all and should be moved or dropped rather than left looking watched.'
      : 'A corrupt baseline makes every run report "first run" and detect nothing. Delete it and re-run.'
  );

  // ------------------------------------------------------- not ours to fix
  const openapi = await get('/openapi.json');
  let paths = [];
  try { paths = Object.keys(JSON.parse(openapi.text).paths || {}); } catch { /* leave empty */ }
  const sessionRoute = paths.find((p) => /faucet|session|inference|mint|claim/i.test(p));
  record(
    'faucet-route',
    'Faucet / session route published',
    sessionRoute ? READY : BLOCKED,
    sessionRoute
      ? `found ${sessionRoute}`
      : `none among ${paths.length} documented paths`,
    'Waiting on Flop Labs. auth.md asks that nobody probe for unpublished paths, so this '
    + 'watches openapi.json rather than guessing. A route cannot ship without appearing there.'
  );

  record(
    'wallet',
    'Wallet format published',
    BLOCKED,
    'No address format, key scheme or transaction signing published',
    'Waiting on Flop Labs. The Teaser says genesis is Q1 2027; nothing describes how a '
    + 'recipient holds $FLOP. Nothing can be built against this yet.'
  );

  // ------------------------------------------------------ operator homework
  const vaultPath = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'flop-scout-identity-vault.json');
  record(
    'identity-backup',
    'Identity vault backed up',
    fs.existsSync(vaultPath) ? READY : ACTION,
    fs.existsSync(vaultPath) ? vaultPath : 'no vault found',
    'Run tools/backup-identity.mjs. Losing these keys loses every DID, every claimed room, '
    + 'and every signed receipt — there is no recovery.'
  );

  /**
   * The structural gap, stated as a number rather than a worry.
   *
   * Under a refilling faucet, spend is throughput times time online. A workflow
   * on a fifteen-minute cron is not continuous operation: it is 96 short bursts a
   * day with gaps between them, and scheduled runs are dropped under load. This
   * is the single largest multiplier still on the table and it is ours to fix.
   */
  /**
   * Measured, not inferred from a cron expression.
   *
   * The first version read the workflow file and reported ACTION whenever a
   * 15-minute cron was present — so it kept saying "runs in bursts" while a local
   * process was in fact running continuously beside it. A readiness check that
   * cannot see the work being done is worse than none.
   *
   * The shared activity note is the only place both machines' cycles add up, so
   * that is what this reads.
   */
  const { readActivity, summariseActivity } = await import('../src/shared-state.mjs');
  const { TechnocoreClient } = await import('../src/technocore-client.mjs');
  const activityClient = new TechnocoreClient({ baseUrl: BASE });
  let activity = { reachable: false, record: null };
  for (let attempt = 1; attempt <= 3; attempt++) {
    activity = await readActivity(activityClient, scout.did);
    if (activity.reachable) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  const combined = activity.reachable ? summariseActivity(activity.record, { cadenceMin: 15 }) : null;

  // Unreachable is not idle. The note is the only evidence either way, so
  // without it this reports BLOCKED rather than accusing the agent of stopping.
  let continuousState = activity.reachable ? ACTION : BLOCKED;
  let continuousDetail = activity.reachable
    ? 'no cycles recorded yet'
    : 'Technocore unreachable — the shared record could not be read';
  if (combined?.dutyCycle != null) {
    const pct = Math.round(combined.dutyCycle * 100);
    const fresh = combined.ageMin != null && combined.ageMin < 30;
    // A high duty cycle over a stale window is history, not current coverage.
    continuousState = pct >= 80 && fresh ? READY : ACTION;
    continuousDetail = `${pct}% duty over ${combined.windowHours.toFixed(1)} h, `
      + `${combined.cycles} cycles, last ${combined.ageMin} min ago`;
  } else if (combined) {
    continuousDetail = `${combined.cycles} cycle(s) recorded — not enough for a rate yet`;
  }

  record(
    'continuous-operation',
    'Runs continuously, not in bursts',
    continuousState,
    continuousDetail,
    'GitHub drops most scheduled runs. Keep the local agent running, or use an always-on '
    + 'host — a rented validator box would run this too, collapsing two decisions into one.'
  );

  // ------------------------------------------------------------------ report
  const byState = (s) => checks.filter((c) => c.state === s);
  const width = Math.max(...checks.map((c) => c.label.length));

  console.log('\n=== FAUCET-DAY READINESS ===\n');
  for (const c of checks) {
    const mark = c.state === READY ? ' OK ' : c.state === ACTION ? 'TODO' : 'WAIT';
    console.log(`  [${mark}] ${c.label.padEnd(width)}  ${c.detail}`);
  }

  console.log(`\n  ${byState(READY).length} ready · ${byState(ACTION).length} ours to fix · ${byState(BLOCKED).length} waiting on Flop Labs\n`);

  if (byState(ACTION).length) {
    console.log('OURS TO FIX\n');
    for (const c of byState(ACTION)) console.log(`  ${c.label}\n    → ${c.fix}\n`);
  }
  if (byState(BLOCKED).length) {
    console.log('NOT OURS TO FIX\n');
    for (const c of byState(BLOCKED)) console.log(`  ${c.label}\n    → ${c.fix}\n`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    summary: { ready: byState(READY).length, action: byState(ACTION).length, blocked: byState(BLOCKED).length },
    checks,
    note: 'Every READY is verified against the live service or a file read at check time. '
      + 'BLOCKED means waiting on Flop Labs, not deferred by us.'
  }, null, 2), 'utf8');
  console.log(`Wrote ${OUT}\n`);
}

main().catch((err) => {
  console.error('readiness check failed:', err.message);
  process.exit(1);
});
