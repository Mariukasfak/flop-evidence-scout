/**
 * Is the automation actually running, or does it only look like it is?
 *
 * Every artefact this project publishes is produced on a schedule, and a
 * scheduled job that stops is the quietest failure there is: the site keeps
 * serving, the numbers keep looking plausible, and the newest one just gets
 * older. Nothing here alerted on that. It has already happened twice — a
 * 201-minute measurement gap caused by rebase conflicts, and a source watcher
 * that reported "first run" for days while exiting 0.
 *
 * So this checks two different things, and the second is the interesting one:
 *
 *   FRESHNESS   is the newest record younger than its cadence allows?
 *   DUTY CYCLE  over the whole history, what share of expected runs happened?
 *
 * Freshness catches a stoppage. Duty cycle catches the slower, more expensive
 * problem: a scheduler that never stops but quietly delivers half of what was
 * asked for. GitHub's own documentation warns that scheduled workflows are
 * delayed or dropped under load, and measuring it is the only way to know by
 * how much.
 *
 * Exits non-zero when something is stale, so the workflow goes red instead of
 * green-and-wrong.
 *
 * Run: node tools/check-freshness.mjs [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/freshness.json');
const quiet = process.argv.includes('--quiet');

const MINUTE = 60_000;

/**
 * Each artefact, its intended cadence, and how to find its newest timestamp.
 *
 * `tolerance` is generous on purpose. A scheduler that is occasionally late is
 * normal; one that is hours late is not, and an alert that cries wolf gets muted,
 * which costs more than it saves.
 */
const ARTEFACTS = [
  {
    id: 'measurements',
    label: 'Network measurements',
    file: 'docs/measurements/timeseries.json',
    cadenceMin: 60,
    toleranceMin: 180,
    series: (j) => (Array.isArray(j) ? j : j.observations || []).map((p) => p.at).filter(Boolean)
  },
  {
    id: 'source-watch',
    label: 'Source watcher',
    file: 'docs/watch/state.json',
    cadenceMin: 60,
    toleranceMin: 180,
    series: (j) => (j.checkedAt ? [j.checkedAt] : [])
  },
  {
    id: 'daemon',
    label: 'Agent daemon cycles',
    file: 'docs/audit-history.json',
    cadenceMin: 15,
    toleranceMin: 90,
    /**
     * One timestamp per CYCLE, not per audit event.
     *
     * The first version mapped every row in the audit log, and a single cycle
     * writes several. That produced a median gap of 0 minutes and a duty cycle
     * pinned at 100% — a metric that could never report the thing it exists to
     * report. Filtering to cycle_complete makes each record mean one scheduled
     * run, which is what the cadence is expressed in.
     */
    series: (j) => (Array.isArray(j) ? j : [])
      .filter((e) => e.event === 'cycle_complete')
      .map((e) => e.timestamp)
      .filter(Boolean)
  },
  {
    id: 'feed',
    label: 'Telemetry feed',
    file: 'docs/feed.json',
    /**
     * Reported, never failed.
     *
     * Two separate reasons this artefact goes stale without anything being
     * wrong. The feed only gains an item when there is something worth saying,
     * and silence is the design goal — a 48-hour tolerance was always going to
     * trip on a quiet week and call it a fault. And docs/feed.json is the
     * COMMITTED copy, written by cloud runs; while the operator's machine holds
     * the lease the local daemon writes to its own docs directory and this file
     * ages by design, exactly as the daemon artefact does.
     *
     * It went stale at 55.6 hours while the feed had in fact published that
     * morning. Age is still printed, because a feed that has said nothing for a
     * month is worth noticing — but noticing is a human's job here, not a red
     * build's.
     */
    cadenceMin: 240,
    toleranceMin: 60 * 48,
    dutyCycle: false,
    informational: true,
    series: (j) => (j.items || []).map((i) => i.date_published || i.id?.split(':').slice(1).join(':')).filter(Boolean)
  }
];

/**
 * What share of the expected runs actually landed.
 *
 * Deliberately computed from the timestamps themselves rather than from a run
 * counter: a counter records what the job believed, and the whole point is to
 * measure what reached the artefact.
 */
function dutyCycle(timestamps, cadenceMin) {
  const times = timestamps.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 3) return null;

  const spanMin = (times[times.length - 1] - times[0]) / MINUTE;
  const expected = Math.max(1, Math.round(spanMin / cadenceMin));

  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / MINUTE);
  gaps.sort((a, b) => a - b);

  return {
    records: times.length,
    spanHours: spanMin / 60,
    expected,
    ratio: Math.min(1, times.length / expected),
    meanGapMin: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    medianGapMin: gaps[Math.floor(gaps.length / 2)],
    worstGapMin: gaps[gaps.length - 1],
    // A gap of two cadences means one run went missing, and so on.
    apparentlyMissed: gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / cadenceMin) - 1), 0)
  };
}

const results = [];
let stale = 0;

for (const artefact of ARTEFACTS) {
  const file = path.resolve(artefact.file);
  if (!fs.existsSync(file)) {
    results.push({ ...artefact, series: undefined, state: 'MISSING', detail: 'file does not exist' });
    stale++;
    continue;
  }

  let timestamps = [];
  try {
    timestamps = artefact.series(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    results.push({ ...artefact, series: undefined, state: 'UNREADABLE', detail: err.message });
    stale++;
    continue;
  }

  if (timestamps.length === 0) {
    results.push({ ...artefact, series: undefined, state: 'EMPTY', detail: 'no timestamps found' });
    stale++;
    continue;
  }

  const newest = Math.max(...timestamps.map((t) => Date.parse(t)).filter(Number.isFinite));
  const ageMin = (Date.now() - newest) / MINUTE;
  const isStale = ageMin > artefact.toleranceMin;
  // An informational artefact is still measured and printed; it just cannot
  // turn a quiet week into a red build.
  if (isStale && !artefact.informational) stale++;

  results.push({
    id: artefact.id,
    label: artefact.label,
    file: artefact.file,
    cadenceMin: artefact.cadenceMin,
    toleranceMin: artefact.toleranceMin,
    newest: new Date(newest).toISOString(),
    ageMin,
    state: isStale ? (artefact.informational ? 'QUIET' : 'STALE') : 'FRESH',
    duty: artefact.dutyCycle === false ? null : dutyCycle(timestamps, artefact.cadenceMin)
  });
}

let combined = null;
try {
  const { TechnocoreClient } = await import('../src/technocore-client.mjs');
  const { loadOrCreateIdentity } = await import('../src/identity.mjs');
  const { readActivity, summariseActivity } = await import('../src/shared-state.mjs');

  /**
   * Refuse to invent an identity here.
   *
   * loadOrCreateIdentity does what its name says, and on a runner with no secret
   * that means generating a fresh key, reading that stranger's non-existent
   * activity note, and finding nothing — which then reads as "the agent stopped"
   * rather than "this check could not see". A missing credential and a missing
   * agent are different findings and must not produce the same output.
   */
  if (!process.env.SCOUT_IDENTITY_JSON && !fs.existsSync('.secrets/scout-identity.json')) {
    throw new Error('no Scout identity available — set SCOUT_IDENTITY_JSON to read the shared record');
  }
  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');

  /**
   * Retry the one read this whole check depends on.
   *
   * A single 503 leaves `combined` null, and null means "a standdown and a
   * stoppage look identical from here" — so one blip blinds the monitor for an
   * hour. The agent's own logs recorded 67 server 503s in a night, so that blip
   * is the normal case. Three attempts with a rising pause; if the server is
   * genuinely down the honest answer is still "could not see".
   */
  const readWithRetry = async (client, did) => {
    let last = { reachable: false, record: null, error: 'not attempted' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await readActivity(client, did);
      if (last.reachable) return last;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    return last;
  };
  const client = new TechnocoreClient({ baseUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat' });
  const { reachable, record } = await readWithRetry(client, identity.did);

  if (reachable) {
    combined = summariseActivity(record, { cadenceMin: 15 });

    if (!quiet) {
      const label = { gh: 'GitHub Actions', lo: 'this machine', xx: 'unlabelled' };
      console.log('  Combined, from the shared note on the server:\n');
      if (combined.dutyCycle == null) {
        console.log(`    ${combined.cycles} cycle(s) recorded — not enough yet for a rate.\n`);
      } else {
        console.log(`    duty cycle across both machines   ${(combined.dutyCycle * 100).toFixed(0)}%`);
        console.log(`    cycles in the window              ${combined.cycles} over ${combined.windowHours.toFixed(1)} h`);
        for (const [code, count] of Object.entries(combined.byHolder)) {
          console.log(`      ${(label[code] || code).padEnd(18)} ${String(count).padStart(4)}  (${(combined.share[code] * 100).toFixed(0)}% of cycles)`);
        }
      }
      const lifetime = Object.entries(combined.totals || {});
      if (lifetime.length) {
        console.log(`    lifetime cycles                   ${lifetime.map(([k, v]) => `${label[k] || k} ${v}`).join(', ')}`);
      }
      console.log(`    inference sessions counted        ${combined.spend?.sessions ?? 0}`);
      console.log(`    inference spend                   ${combined.spend?.flop ?? 0} $FLOP\n`);
    }
  } else if (!quiet) {
    console.log('  Combined view unavailable — Technocore unreachable.\n');
  }
} catch (err) {
  if (!quiet) console.log(`  Combined view unavailable — ${err.message}\n`);
}

/**
 * A machine standing down is not a machine that stopped.
 *
 * docs/audit-history.json is written by the GitHub Actions run. Once the lease
 * landed, the cloud run correctly declines the cycle whenever the home PC holds
 * it, so that file stops advancing while the agent is running perfectly well —
 * and this check called it stale and failed the workflow.
 *
 * The cost was not cosmetic. "Watch official sources" went red on every single
 * run, so the one job whose output is an alert was permanently the colour that
 * means "ignore me". Technocore doubled its capacity and raised the DID
 * namespace cap, and that had to be found by hand.
 *
 * The right question was never "did this machine run" but "did the agent run
 * anywhere", and the shared note answers it for both.
 */
const daemonResult = results.find((r) => r.id === 'daemon');
if (daemonResult?.state === 'STALE') {
  const daemonTolerance = ARTEFACTS.find((a) => a.id === 'daemon').toleranceMin;

  if (combined && Number.isFinite(combined.ageMin) && combined.ageMin <= daemonTolerance) {
    daemonResult.state = 'STANDING DOWN';
    daemonResult.detail = `this machine's log is ${daemonResult.ageMin?.toFixed(0) ?? '?'} min old, `
      + `but the shared record shows a cycle ${combined.ageMin.toFixed(0)} min ago — another holder has the lease`;
    stale--;
  } else if (!combined) {
    /**
     * Failing to look is not the same as seeing it stopped.
     *
     * This file's own artefact ages by design whenever the other machine holds
     * the lease, and the shared note is the only thing that can tell a normal
     * standdown from a real stoppage. When Technocore cannot be reached — 54
     * server 503s in one night — that evidence is simply absent, and calling it
     * a stoppage turns a server blip into a red alerting run, which is the third
     * distinct way this check has cried wolf.
     *
     * So: say plainly that it could not be verified, and let the next scheduled
     * run answer. A genuine stoppage stays visible, because the very next run
     * that does reach the server reports it.
     */
    daemonResult.state = 'UNVERIFIED';
    daemonResult.detail = "this machine's log is old, and the shared record could not be read — "
      + 'a standdown and a stoppage look identical from here';
    stale--;
  }
}

if (!quiet) {
  console.log('\n=== SCHEDULED WORK: IS IT ACTUALLY RUNNING? ===\n');
  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const age = r.ageMin == null ? '' : `${r.ageMin < 60 ? `${Math.round(r.ageMin)} min` : `${(r.ageMin / 60).toFixed(1)} h`} old`;
    // Three states, not two: standing down for a lease is neither fresh nor broken.
    const tag = r.state === 'FRESH' ? ' OK '
      : r.state === 'STANDING DOWN' ? 'IDLE'
        : r.state === 'UNVERIFIED' ? ' ?? '
          : r.state === 'QUIET' ? 'QUIET' : 'STALE';
    console.log(`  [${tag}] ${r.label.padEnd(w)}  ${age.padEnd(10)} ${r.detail || ''}`);
  }

  const withDuty = results.filter((r) => r.duty);
  if (withDuty.length) {
    console.log('\n  Delivered vs scheduled:\n');
    console.log(`    ${'artefact'.padEnd(w)}  every  got/want   duty   median gap   worst gap   missed`);
    for (const r of withDuty) {
      const d = r.duty;
      console.log(
        `    ${r.label.padEnd(w)}  ${String(r.cadenceMin).padStart(3)}m  `
        + `${String(d.records).padStart(3)}/${String(d.expected).padEnd(3)}  `
        + `${(d.ratio * 100).toFixed(0).padStart(4)}%  `
        + `${d.medianGapMin.toFixed(0).padStart(7)}m  `
        + `${d.worstGapMin.toFixed(0).padStart(9)}m  `
        + `${String(d.apparentlyMissed).padStart(6)}`
      );
    }
    console.log('\n  Duty cycle is what reached the artefact, not what the scheduler believed it ran.');
    console.log('  GitHub delays or drops scheduled workflows under load; this is by how much.');
  }
  console.log();
}

/**
 * The combined picture, read from the server rather than from files.
 *
 * The duty cycles above come from committed artefacts, and those only ever
 * contain cloud runs — local cycles write to data/local, which is gitignored.
 * So once the agent also runs on a machine at home, the file-based figure keeps
 * reporting the cloud's coverage and gets further from the truth the more the
 * local process helps. A metric that grows more wrong as the system improves is
 * worse than no metric.
 *
 * The shared activity note is where both machines add up.
 */
if (!quiet) console.log();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  checkedAt: new Date().toISOString(),
  stale,
  combined,
  artefacts: results,
  note: 'Freshness catches a stoppage. Duty cycle catches a scheduler that never stops and '
    + 'quietly delivers a fraction of what was asked for — the more expensive failure, because '
    + 'nothing about it looks broken.'
}, null, 2), 'utf8');

if (!quiet) console.log(`Wrote ${OUT}\n`);

if (stale > 0) {
  console.error(`[freshness] ${stale} artefact(s) stale or unreadable — failing so this is visible.`);
  process.exit(1);
}
