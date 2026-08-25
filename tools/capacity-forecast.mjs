/**
 * Forecasts when technocore.chat's declared caps bind, from observed fill rate.
 *
 * The service publishes both the current fill and the cap on one line of /rooms:
 *
 *   # 50 of 7921 rooms (cap 10240, 59.2M of 5.0G stored), newest first
 *   # notes 122600 of 327680 (9.0M total, 40960 per namespace, ...)
 *
 * So the forecast needs no privileged access and no probing — two reads far
 * enough apart, and the arithmetic. Storage is deliberately not forecast: it
 * moves both ways because the reaper reclaims idle rooms, so a naive slope there
 * is meaningless.
 *
 * Run: node tools/capacity-forecast.mjs [--samples 3] [--interval 300]
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.TECHNOCORE_URL || 'https://technocore.chat';
const OUT_DIR = path.resolve('docs/measurements');

function parseArgs(argv) {
  const out = { samples: 3, intervalSeconds: 300 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--samples' && argv[i + 1]) out.samples = Number(argv[++i]);
    else if (argv[i] === '--interval' && argv[i + 1]) out.intervalSeconds = Number(argv[++i]);
  }
  return out;
}

async function sample() {
  const res = await fetch(`${BASE}/rooms`, {
    headers: { 'user-agent': 'FLOP-Scout-Capacity/1.0 (+github.com/Mariukasfak/flop-evidence-scout)' }
  });
  if (!res.ok) throw new Error(`GET /rooms -> HTTP ${res.status}`);
  const body = await res.text();

  const roomLine = body.split('\n').find((l) => /^#\s*\d+ of \d+ rooms/.test(l)) || '';
  const noteLine = body.split('\n').find((l) => /^#\s*notes \d+ of \d+/.test(l)) || '';

  const rooms = roomLine.match(/of (\d+) rooms \(cap (\d+)/);
  const notes = noteLine.match(/notes (\d+) of (\d+)/);
  if (!rooms || !notes) throw new Error('Could not parse the /rooms summary lines');

  return {
    at: Date.now(),
    rooms: { used: Number(rooms[1]), cap: Number(rooms[2]) },
    notes: { used: Number(notes[1]), cap: Number(notes[2]) }
  };
}

function forecast(label, first, last) {
  const hours = (last.at - first.at) / 3_600_000;
  const delta = last.used - first.used;
  const perHour = delta / hours;
  const remaining = last.cap - last.used;

  return {
    metric: label,
    used: last.used,
    cap: last.cap,
    percentFull: Number(((last.used / last.cap) * 100).toFixed(1)),
    observedPerHour: Number(perHour.toFixed(0)),
    remaining,
    // A negative or zero rate means it is not filling; say so rather than
    // printing an infinity or a nonsense date.
    hoursToCap: perHour > 0 ? Number((remaining / perHour).toFixed(1)) : null,
    bindsAt: perHour > 0 ? new Date(last.at + (remaining / perHour) * 3_600_000).toISOString() : null,
    windowHours: Number(hours.toFixed(2))
  };
}

async function main() {
  const { samples, intervalSeconds } = parseArgs(process.argv);
  console.log(`Sampling ${BASE}/rooms ${samples}x every ${intervalSeconds}s\n`);

  const taken = [];
  for (let i = 0; i < samples; i++) {
    const s = await sample();
    taken.push(s);
    console.log(
      `${new Date(s.at).toISOString()}  rooms ${s.rooms.used}/${s.rooms.cap}  notes ${s.notes.used}/${s.notes.cap}`
    );
    if (i < samples - 1) await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }

  const first = taken[0];
  const last = taken[taken.length - 1];
  const result = {
    measuredAt: new Date(last.at).toISOString(),
    server: BASE,
    samples: taken.map((s) => ({ at: new Date(s.at).toISOString(), rooms: s.rooms.used, notes: s.notes.used })),
    forecasts: [
      forecast('notes', { ...first.notes, at: first.at }, { ...last.notes, at: last.at }),
      forecast('rooms', { ...first.rooms, at: first.at }, { ...last.rooms, at: last.at })
    ]
  };

  console.log('');
  for (const f of result.forecasts) {
    const eta = f.hoursToCap === null ? 'not filling' : `${f.hoursToCap} h  (~${f.bindsAt})`;
    console.log(`${f.metric.padEnd(6)} ${f.used}/${f.cap} (${f.percentFull}%)  +${f.observedPerHour}/h  ->  ${eta}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `capacity-${new Date(last.at).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error('Capacity forecast failed:', err.message);
  process.exit(1);
});
