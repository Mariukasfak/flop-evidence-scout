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
async function estimateDidPopulation(shards = ['00', '3f', '85', 'c1', 'e0']) {
  const counts = [];
  for (const shard of shards) {
    const body = await get(`/kv/did-${shard}`);
    counts.push(body.split('\n').filter((l) => l.startsWith(`/kv/did-${shard}/`)).length);
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return {
    shardsSampled: shards,
    countsPerShard: counts,
    estimatedTotal: Math.round(mean * 256),
    note: 'Scaled from a uniform 1/256 sharding of SHA-256(did:key). Spread across shards is the error bar.'
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
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('Measurement failed:', err.message);
  process.exit(1);
});
