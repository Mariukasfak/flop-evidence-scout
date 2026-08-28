/**
 * Measures technocore.chat and writes a dated dataset to docs/measurements/.
 *
 * Everything here is read-only and comes from documented endpoints. The point is
 * that the numbers are reproducible: run it again and you get a comparable file,
 * which is what makes the field guide worth reading months from now.
 *
 * Run: node tools/measure-network.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.TECHNOCORE_URL || 'https://technocore.chat';
const OUT_DIR = path.resolve('docs/measurements');

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { 'user-agent': 'FLOP-Scout-Measure/1.0' } });
  if (!res.ok) throw new Error(`GET ${pathname} -> HTTP ${res.status}`);
  return res.text();
}

/** Room reads are line-structured; the banner lines simply do not match. */
function parseMessages(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^\[(\d+)\]\s+(\S+)\s+<([^>]+)>\s+(.*)$/);
    if (m) out.push({ seq: Number(m[1]), ts: m[2], from: m[3], text: m[4] });
  }
  return out;
}

/** Observed rate, from the seq the server assigns — not from a sample we counted. */
async function measureRate(room, seconds = 20) {
  const first = parseMessages(await get(`/r/${room}?limit=1`));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const second = parseMessages(await get(`/r/${room}?limit=1`));
  const elapsed = (Date.now() - t0) / 1000;
  if (!first.length || !second.length) return null;
  const delta = second[second.length - 1].seq - first[first.length - 1].seq;
  return {
    room,
    seqDelta: delta,
    elapsedSeconds: Number(elapsed.toFixed(1)),
    messagesPerMinute: Number(((delta / elapsed) * 60).toFixed(1))
  };
}

/**
 * DID notes are sharded by the first 2 hex chars of the fingerprint, so any one
 * shard is a uniform 1/256 sample of the population. Sampling several shards and
 * scaling is far cheaper than enumerating 256 namespaces, and the spread across
 * shards is itself the error bar.
 */
/**
 * The namespace cap, read from the service rather than remembered.
 *
 * This was hardcoded as 40960 in two places. Upstream 0.9.7 published GET
 * /config, and the real figure is now 50960 — the cap was raised and our
 * instrument kept reporting the old one, so `legacyAtCap` would have gone false
 * and the note would have printed a number that was simply wrong.
 *
 * It moved again on 2026-08-28, to 131072. That is the argument settled: the cap
 * has now changed twice in the life of this file, and each time the reading was
 * right only because it comes from the service. The fallback is the last value
 * actually observed, not a guess, and it is labelled when it is used.
 */
async function readNamespaceCap() {
  try {
    const config = JSON.parse(await get('/config'));
    const cap = config?.settings?.max_notes_per_ns;
    if (Number.isFinite(cap) && cap > 0) return { cap, source: 'GET /config' };
  } catch { /* fall through */ }
  return { cap: 131072, source: 'fallback — /config unreadable; last observed value' };
}

async function estimateDidPopulation(shards = ['00', '3f', '85', 'c1', 'e0']) {
  const counts = [];
  for (const shard of shards) {
    const body = await get(`/kv/did-${shard}`);
    counts.push(body.split('\n').filter((l) => l.startsWith(`/kv/did-${shard}/`)).length);
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const shardedEstimate = Math.round(mean * 256);

  // The legacy flat namespace is a real, separate population and the first
  // version of this instrument missed it entirely — which understated the total
  // by more than half. It is also enumerable exactly, no sampling needed.
  const legacyBody = await get('/kv/did');
  const legacyCount = legacyBody.split('\n').filter((l) => l.startsWith('/kv/did/')).length;

  const { cap, source: capSource } = await readNamespaceCap();

  return {
    shardsSampled: shards,
    countsPerShard: counts,
    shardedEstimate,
    legacyCount,
    namespaceCap: cap,
    namespaceCapSource: capSource,
    legacyAtCap: legacyCount >= cap,
    estimatedTotal: shardedEstimate + legacyCount,
    note: 'Sharded figure is scaled from a uniform 1/256 sharding of SHA-256(did:key); '
      + 'spread across shards is the error bar. Legacy /kv/did is counted exactly. '
      + 'The total is an upper bound: an agent that wrote both paths is counted twice. '
      + `The namespace cap is ${cap} (${capSource}); legacy at that figure can accept no new `
      + 'agents, so growth then shows up only in the sharded figure.'
  };
}

async function main() {
  const at = new Date().toISOString();
  console.log(`Measuring ${BASE} at ${at}`);

  const agent = JSON.parse(await get('/.well-known/agent.json'));

  const roomsBody = await get('/rooms');
  const roomLines = roomsBody.split('\n').filter((l) => l.startsWith('/r/'));
  const header = roomsBody.split('\n').find((l) => l.includes('rooms (cap')) || '';
  const engagement = roomsBody.split('\n').find((l) => l.includes('engagement over')) || '';
  const notesLine = roomsBody.split('\n').find((l) => l.startsWith('# notes')) || '';

  const rates = [];
  for (const room of ['lobby', 'technocore', 'events']) {
    try {
      rates.push(await measureRate(room));
    } catch (err) {
      rates.push({ room, error: err.message });
    }
  }

  const lobbySample = parseMessages(await get('/r/lobby?limit=100'));
  const distinctWriters = new Set(lobbySample.map((m) => m.from)).size;

  const data = {
    measuredAt: at,
    server: { url: BASE, version: agent.version, limits: agent.limits },
    rooms: {
      headerLine: header.replace(/^#\s*/, ''),
      notesLine: notesLine.replace(/^#\s*/, ''),
      engagementLine: engagement.replace(/^#\s*/, ''),
      listedSample: roomLines.length
    },
    throughput: rates,
    lobbySample: {
      messages: lobbySample.length,
      distinctWriters,
      writerDiversity: lobbySample.length ? Number((distinctWriters / lobbySample.length).toFixed(2)) : null
    },
    didPopulation: await estimateDidPopulation()
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${at.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Wrote ${file}`);

  appendToSeries(data);
  console.log(JSON.stringify(data, null, 2));
}

/**
 * The daily file is overwritten each run, so on its own it is a snapshot, not a
 * series — and a guide whose charts have two points is not a guide. Append a
 * compact row instead, deduplicated to the minute so a re-run does not double up.
 */
function appendToSeries(data) {
  const seriesPath = path.join(OUT_DIR, 'timeseries.json');
  if (!fs.existsSync(seriesPath)) {
    console.warn('[measure] No timeseries.json to append to; skipping.');
    return;
  }

  let series;
  try {
    series = JSON.parse(fs.readFileSync(seriesPath, 'utf8'));
  } catch (err) {
    console.warn(`[measure] timeseries.json is unreadable (${err.message}); leaving it alone.`);
    return;
  }

  const roomsUsed = Number((data.rooms.headerLine.match(/of (\d+) rooms/) || [])[1]) || null;
  const notesUsed = Number((data.rooms.notesLine.match(/notes (\d+) of/) || [])[1]) || null;
  const lobby = data.throughput.find((t) => t.room === 'lobby');

  const row = {
    at: `${data.measuredAt.slice(0, 16)}Z`,
    sharded_did_estimate: data.didPopulation.shardedEstimate,
    legacy_did_count: data.didPopulation.legacyCount,
    notes_used: notesUsed,
    rooms_used: roomsUsed,
    lobby_msgs_per_min: lobby && !lobby.error ? Math.round(lobby.messagesPerMinute) : null,
    note: 'Appended automatically by tools/measure-network.mjs.'
  };

  if (row.notes_used === null || row.rooms_used === null || !row.sharded_did_estimate) {
    console.warn('[measure] Incomplete reading; not appending a partial row to the series.');
    return;
  }

  const already = series.observations.some((o) => o.at.slice(0, 16) === row.at.slice(0, 16));
  if (already) {
    console.log('[measure] A reading for this minute is already in the series.');
    return;
  }

  /**
   * Refresh the caps as well as the readings.
   *
   * This appended observations against a `caps` block written once and never
   * touched again, and the service raised its capacity twice underneath it. The
   * result was published: the telemetry feed posted "rooms 18845/10240 listed
   * (184%)" and "notes 625674/327680 (191%)" to /r/d-scout-telemetry, signed,
   * where anyone could read an agent confidently reporting 191% of a cap.
   *
   * A measurement carries the limits it was measured against, or the ratio it
   * feeds is arithmetic on two different days.
   */
  const limits = data.server?.limits || {};
  const freshCaps = {
    notes: limits.notes ?? series.caps?.notes,
    notes_per_namespace: data.didPopulation?.namespaceCap ?? series.caps?.notes_per_namespace,
    rooms: limits.rooms ?? series.caps?.rooms,
    room_bytes_total: limits.room_bytes_total ?? series.caps?.room_bytes_total
  };
  const capsMoved = JSON.stringify(freshCaps) !== JSON.stringify(series.caps);
  if (capsMoved) {
    console.log(`[measure] Caps changed: ${JSON.stringify(series.caps)} -> ${JSON.stringify(freshCaps)}`);
    series.caps = freshCaps;
  }
  row.caps = freshCaps;

  series.observations.push(row);
  series.observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  fs.writeFileSync(seriesPath, JSON.stringify(series, null, 2), 'utf8');
  console.log(`[measure] Appended reading to the series (${series.observations.length} total).`);
}

main().catch((err) => {
  console.error('Measurement failed:', err.message);
  process.exit(1);
});
