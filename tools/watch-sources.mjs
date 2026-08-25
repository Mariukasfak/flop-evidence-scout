/**
 * Watches the official first-party sources for change and reports what moved.
 *
 * Scope is deliberate: only sources that can be fetched deterministically and
 * that Flop Labs actually controls. X/Twitter is not here — reading it reliably
 * needs API credentials, and third-party mirrors are exactly the kind of
 * unverified relay this project refuses to act on. The operator still reads X;
 * this covers everything a machine can check honestly.
 *
 * State lives in docs/watch/state.json (committed), so a change is detected
 * across scheduled runs on ephemeral CI machines.
 *
 * Run: node tools/watch-sources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_PATH = path.resolve('docs/watch/state.json');
const CHANGE_PATH = path.resolve('data/source-change.json');

/**
 * Room names worth knowing about the moment they appear. "task" and "quest"
 * were added after Hayes said on 2026-08-25 that there would be specific tasks
 * requiring a DID key — a task room appearing is the event we cannot be late for.
 */
const KEYWORDS = /faucet|testnet|\btask\b|\btasks\b|quest|bounty|mission|\bdrip\b|airdrop|claim/i;

const SOURCES = [
  { id: 'agent-json', url: 'https://technocore.chat/.well-known/agent.json', kind: 'json' },
  { id: 'manual', url: 'https://technocore.chat/llms.txt', kind: 'text' },
  { id: 'patterns', url: 'https://technocore.chat/patterns.md', kind: 'text' },
  { id: 'skill', url: 'https://technocore.chat/skill.md', kind: 'text' },
  { id: 'flop-finance', url: 'https://flop.finance/', kind: 'html' },
  { id: 'upstream-commits', url: 'https://api.github.com/repos/flop-labs/technocore-chat/commits?per_page=1', kind: 'gh' },
  { id: 'upstream-releases', url: 'https://api.github.com/repos/flop-labs/technocore-chat/releases?per_page=1', kind: 'gh' }
];

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

async function fetchText(url) {
  const headers = { 'user-agent': 'FLOP-Scout-Watch/1.0 (+github.com/Mariukasfak/flop-evidence-scout)' };
  if (url.startsWith('https://api.github.com') && process.env.GH_TOKEN) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Strip the parts of a page that change without the content changing. */
function normalise(kind, body) {
  if (kind === 'html') {
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return body.trim();
}

/** A human-readable marker per source, so a diff says something, not just "hash changed". */
function summarise(id, kind, body) {
  try {
    if (id === 'agent-json') return `version ${JSON.parse(body).version}`;
    if (id === 'upstream-commits') {
      const c = JSON.parse(body)[0];
      return c ? `${c.sha.slice(0, 7)} — ${c.commit.message.split('\n')[0].slice(0, 80)}` : 'no commits';
    }
    if (id === 'upstream-releases') {
      const r = JSON.parse(body)[0];
      return r ? `${r.tag_name} — ${r.name || ''}`.trim() : 'no releases';
    }
  } catch { /* fall through to the byte count */ }
  return `${normalise(kind, body).length} chars`;
}

async function checkRooms() {
  const body = await fetchText('https://technocore.chat/rooms');
  const names = body.split('\n')
    .filter((l) => l.startsWith('/r/'))
    .map((l) => l.slice(3).split(/\s+/)[0])
    .filter((n) => KEYWORDS.test(n));
  return [...new Set(names)].sort();
}

async function main() {
  const now = new Date().toISOString();

  let previous = {};
  if (fs.existsSync(STATE_PATH)) {
    try { previous = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { previous = {}; }
  }
  const prevSources = previous.sources || {};
  const prevRooms = previous.interestingRooms || [];

  const sources = {};
  const changes = [];

  for (const source of SOURCES) {
    try {
      const body = await fetchText(source.url);
      const digest = sha(normalise(source.kind, body));
      const summary = summarise(source.id, source.kind, body);
      sources[source.id] = { url: source.url, digest, summary, checkedAt: now };

      const before = prevSources[source.id];
      if (before && before.digest !== digest) {
        changes.push({
          id: source.id,
          url: source.url,
          was: before.summary,
          now: summary
        });
      }
    } catch (err) {
      // A source being unreachable is not news; record it and move on.
      sources[source.id] = {
        url: source.url,
        error: err.message,
        digest: prevSources[source.id]?.digest || null,
        summary: prevSources[source.id]?.summary || null,
        checkedAt: now
      };
      console.warn(`[watch] ${source.id}: ${err.message}`);
    }
  }

  let interestingRooms = prevRooms;
  const newRooms = [];
  try {
    interestingRooms = await checkRooms();
    for (const room of interestingRooms) {
      if (!prevRooms.includes(room)) newRooms.push(room);
    }
  } catch (err) {
    console.warn(`[watch] rooms: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    checkedAt: now,
    sources,
    interestingRooms
  }, null, 2), 'utf8');

  const isFirstRun = Object.keys(prevSources).length === 0;
  if (isFirstRun) {
    console.log(`[watch] Baseline recorded for ${Object.keys(sources).length} sources. No comparison on a first run.`);
    return;
  }

  if (changes.length === 0 && newRooms.length === 0) {
    console.log('[watch] No change in any watched source.');
    if (fs.existsSync(CHANGE_PATH)) fs.rmSync(CHANGE_PATH);
    return;
  }

  fs.mkdirSync(path.dirname(CHANGE_PATH), { recursive: true });
  fs.writeFileSync(CHANGE_PATH, JSON.stringify({ detectedAt: now, changes, newRooms }, null, 2), 'utf8');

  console.log(`[watch] ${changes.length} source change(s), ${newRooms.length} new room(s) of interest.`);
  for (const c of changes) console.log(`  ${c.id}: ${c.was}  ->  ${c.now}`);
  for (const r of newRooms) console.log(`  new room: ${r}`);
}

main().catch((err) => {
  console.error('[watch] failed:', err.message);
  process.exit(1);
});
