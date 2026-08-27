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
    // The feed only gains an item when there is something new to say, so it is
    // checked for staleness far more loosely and never for duty cycle. Silence
    // here is a design goal, not a fault.
    cadenceMin: 240,
    toleranceMin: 60 * 48,
    dutyCycle: false,
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
  if (isStale) stale++;

  results.push({
    id: artefact.id,
    label: artefact.label,
    file: artefact.file,
    cadenceMin: artefact.cadenceMin,
    toleranceMin: artefact.toleranceMin,
    newest: new Date(newest).toISOString(),
    ageMin,
    state: isStale ? 'STALE' : 'FRESH',
    duty: artefact.dutyCycle === false ? null : dutyCycle(timestamps, artefact.cadenceMin)
  });
}

if (!quiet) {
  console.log('\n=== SCHEDULED WORK: IS IT ACTUALLY RUNNING? ===\n');
  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const age = r.ageMin == null ? '' : `${r.ageMin < 60 ? `${Math.round(r.ageMin)} min` : `${(r.ageMin / 60).toFixed(1)} h`} old`;
    console.log(`  [${r.state === 'FRESH' ? ' OK ' : 'STALE'}] ${r.label.padEnd(w)}  ${age.padEnd(10)} ${r.detail || ''}`);
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

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  checkedAt: new Date().toISOString(),
  stale,
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
