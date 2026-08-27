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
 * DO NOT turn this into a probe. /auth.md says plainly: "There is no
 * registration, provisioning, claim or token endpoint at any path ... Please do
 * not probe for one." This reads published documents — openapi.json, llms.txt,
 * agent.json, the repo — which is how the service asks to be discovered. Adding
 * speculative requests to guessed paths would be both rude and useless: a route
 * cannot ship without appearing in openapi.json, so waiting for it there is
 * strictly faster than guessing.
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
const KEYWORDS = /faucet|testnet|airdrop|\btasks?\b|\bquests?\b|\bbount(?:y|ies)\b|\bdrip\b|\bclaims?\b/i;
// Word boundaries are not decoration here: the first version matched
// `room-permissions` on "mission", and an unbounded `quest` would fire on every
// room with "request" or "question" in the name. Room names are [a-z0-9_-], so
// a hyphen counts as a boundary and `flop-testnet-faucet` still matches.

const SOURCES = [
  // openapi.json is the highest-signal source there is: upstream's own
  // CONTRIBUTING requires a new route to land in the manifest in the same
  // change, and CI fails on an undocumented status code. A faucet endpoint
  // therefore cannot ship without appearing here first.
  { id: 'openapi', url: 'https://technocore.chat/openapi.json', kind: 'openapi' },
  { id: 'agent-json', url: 'https://technocore.chat/.well-known/agent.json', kind: 'json' },
  // Added 2026-08-27, the day upstream 0.9.7 shipped it. This is the highest-value
  // limits document there is: it publishes the values THIS process enforces, read
  // from the same bindings the handlers read, so they cannot disagree with
  // behaviour. It already corrected a cap we had hardcoded wrongly for weeks.
  { id: 'config', url: 'https://technocore.chat/config', kind: 'json' },
  { id: 'manual', url: 'https://technocore.chat/llms.txt', kind: 'text' },
  { id: 'patterns', url: 'https://technocore.chat/patterns.md', kind: 'text' },
  { id: 'skill', url: 'https://technocore.chat/skill.md', kind: 'text' },
  { id: 'flop-finance', url: 'https://flop.finance/', kind: 'html' },
  // Added 2026-08-26, the day this watcher failed to notice the most important
  // document Flop Labs has published. The Teaser appeared at /teaser/ — a path
  // that did not exist when the source list was written — and the apex page only
  // gained a link to it. Watching the apex was never going to be enough, so the
  // teaser is watched directly AND link discovery below reports any new path.
  { id: 'flop-teaser', url: 'https://flop.finance/teaser/', kind: 'html' },
  { id: 'upstream-commits', url: 'https://api.github.com/repos/flop-labs/technocore-chat/commits?per_page=5', kind: 'gh' },
  { id: 'upstream-releases', url: 'https://api.github.com/repos/flop-labs/technocore-chat/releases?per_page=1', kind: 'gh' }
];

/**
 * Hayes said on 2026-08-25 that allocation will depend on testnet activity and
 * that the faucet will live on technocore.chat behind a DID key. The first
 * appearance of any of these words in a source that never carried them is a
 * louder signal than any hash change, so it is reported separately — a digest
 * moving tells you something changed, this tells you what to care about.
 */
const SIGNAL_WORDS = [
  'faucet', 'testnet', 'inference', 'wallet', 'balance', 'mint',
  'credit', 'quota', 'settle', 'payment', 'ledger',
  // Added 2026-08-26: Hayes said tokenomics materials are due within a week and
  // the whitepaper within weeks. Those are the documents that turn every UNKNOWN
  // on the status board into an answer, so their first appearance is the single
  // most valuable thing this watcher can catch.
  'tokenomics', 'whitepaper', 'supply', 'halving', 'genesis', 'staking', 'governance',
  // Added 2026-08-26 from the Teaser v0.1's own vocabulary. The Yellow Paper is
  // the document that turns every provisional figure into a final one, so its
  // first mention anywhere is the loudest signal this watcher can carry.
  'yellow', 'slashing', 'slashed', 'validator', 'miner', 'emission', 'unlock',
  'vesting', 'snapshot', 'toploc', 'attestation', 'mempool'
];

function signalHits(body) {
  const found = [];
  for (const word of SIGNAL_WORDS) {
    // "token bucket" is the rate limiter, not a token — require a word boundary
    // and skip the phrases we already know are innocent.
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = body.match(re);
    if (matches) found.push(`${word}×${matches.length}`);
  }
  return found;
}

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
    if (id === 'openapi') {
      const paths = Object.keys(JSON.parse(body).paths || {}).sort();
      return `${paths.length} paths`;
    }
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

/**
 * Every first-party path flop.finance links to.
 *
 * The Teaser did not change a watched source — it *was* a new source, at a path
 * that did not exist the day before. Digest-watching a fixed list can only ever
 * catch edits to documents we already knew about, so this reports the appearance
 * of a path instead, which is how a new document actually arrives.
 */
function discoverLinks(html, origin = 'https://flop.finance') {
  const paths = new Set();
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    let href = m[1];
    if (href.startsWith(origin)) href = href.slice(origin.length) || '/';
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const path = href.split(/[?#]/)[0];
    // Locale mirrors of the same page are not new documents.
    if (/^\/(ar|de|es|fr|ja|ko|pt-BR|ru|tr|zh)\/?$/.test(path)) continue;
    if (/\.(svg|png|jpg|jpeg|ico|css|js|woff2?|xml|txt)$/i.test(path)) continue;
    paths.add(path);
  }
  return [...paths].sort();
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
  let stateWasCorrupt = false;
  if (fs.existsSync(STATE_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (err) {
      // This used to be `catch { previous = {}; }`, and that silence cost us the
      // single most important document Flop Labs has published. A merge landed
      // conflict markers in this file; the parse failed; the run reported
      // "Baseline recorded ... no comparison on a first run" and exited 0. Every
      // run after it did the same. The watcher looked healthy and was blind.
      //
      // An unreadable state file is not a first run. It is a fault, and it is
      // reported as one — a missing file is the only honest first run.
      stateWasCorrupt = true;
      previous = {};
      console.error(`[watch] STATE FILE UNREADABLE (${err.message}). Rebuilding the baseline.`);
      console.error('[watch] No change can be detected on this run. This is a fault, not a first run.');
    }
  }
  const prevSources = previous.sources || {};
  const prevRooms = previous.interestingRooms || [];

  const sources = {};
  const changes = [];
  const signalAlerts = [];

  for (const source of SOURCES) {
    try {
      const body = await fetchText(source.url);
      const normalised = normalise(source.kind, body);
      const digest = sha(normalised);
      const summary = summarise(source.id, source.kind, body);
      const signals = signalHits(normalised);
      const paths = source.id === 'openapi'
        ? Object.keys(JSON.parse(body).paths || {}).sort()
        : undefined;

      const links = source.kind === 'html' ? discoverLinks(body) : undefined;

      sources[source.id] = { url: source.url, digest, summary, signals, paths, links, checkedAt: now };

      const before = prevSources[source.id];
      if (before && before.digest !== digest) {
        const change = { id: source.id, url: source.url, was: before.summary, now: summary };

        // A route appearing is the event; the digest moving is just how we noticed.
        // A path appearing on the apex is how the Teaser arrived. Report it the
        // same way a new API route is reported, because it is the same event.
        if (links && Array.isArray(before.links)) {
          const addedLinks = links.filter((l) => !before.links.includes(l));
          if (addedLinks.length) change.addedLinks = addedLinks;
        }

        if (paths && Array.isArray(before.paths)) {
          const added = paths.filter((p) => !before.paths.includes(p));
          const removed = before.paths.filter((p) => !paths.includes(p));
          if (added.length) change.addedPaths = added;
          if (removed.length) change.removedPaths = removed;
        }

        if (source.kind === 'text') {
          const beforeLines = new Set((before.body || '').split('\n'));
          const added = normalised.split('\n')
            .filter((l) => l.trim() && !beforeLines.has(l))
            .slice(0, 12);
          if (added.length && before.body) change.addedLines = added;
        }

        changes.push(change);
      }

      // Report a signal word the first time it shows up in a source that never
      // carried it, whether or not anything else about the source changed.
      if (before) {
        const seenBefore = new Set((before.signals || []).map((s) => s.split('×')[0]));
        const fresh = signals.map((s) => s.split('×')[0]).filter((w) => !seenBefore.has(w));
        if (fresh.length) {
          signalAlerts.push({ id: source.id, url: source.url, words: fresh });
        }
      }

      // Keep the body only where a line diff is cheap and useful.
      if (source.kind === 'text' && normalised.length < 40000) {
        sources[source.id].body = normalised;
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

  if (stateWasCorrupt) {
    // Exit non-zero so the scheduled workflow goes red instead of green. The
    // baseline above has already been rewritten, so the next run compares
    // normally — but this run must not be mistaken for a quiet one.
    console.error('[watch] Baseline rebuilt from a corrupt state file. Failing loudly by design.');
    process.exitCode = 1;
    return;
  }

  const isFirstRun = Object.keys(prevSources).length === 0;
  if (isFirstRun) {
    console.log(`[watch] Baseline recorded for ${Object.keys(sources).length} sources. No comparison on a first run.`);
    return;
  }

  if (changes.length === 0 && newRooms.length === 0 && signalAlerts.length === 0) {
    console.log('[watch] No change in any watched source.');
    if (fs.existsSync(CHANGE_PATH)) fs.rmSync(CHANGE_PATH);
    return;
  }

  fs.mkdirSync(path.dirname(CHANGE_PATH), { recursive: true });
  fs.writeFileSync(CHANGE_PATH, JSON.stringify({ detectedAt: now, changes, newRooms, signalAlerts }, null, 2), 'utf8');

  console.log(`[watch] ${changes.length} source change(s), ${newRooms.length} new room(s), ${signalAlerts.length} signal-word alert(s).`);
  for (const c of changes) {
    console.log(`  ${c.id}: ${c.was}  ->  ${c.now}`);
    if (c.addedPaths) console.log(`    NEW ROUTES: ${c.addedPaths.join(', ')}`);
    if (c.addedLinks) console.log(`    NEW PAGES: ${c.addedLinks.join(', ')}`);
  }
  for (const r of newRooms) console.log(`  new room: ${r}`);
  for (const a of signalAlerts) console.log(`  SIGNAL in ${a.id}: ${a.words.join(', ')}`);
}

main().catch((err) => {
  console.error('[watch] failed:', err.message);
  process.exit(1);
});
