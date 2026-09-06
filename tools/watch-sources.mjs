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
    /**
   * Thirty, because five was a window and not a record.
   *
   * The page size only bounds how far behind this watch may fall before it
   * starts losing commits outright. At the observed upstream rate an hourly
   * run needs a handful; thirty covers a run that fails for most of a day.
   * `windowOverflowed` says when even that was not enough.
   */
  { id: 'upstream-commits', url: 'https://api.github.com/repos/flop-labs/technocore-chat/commits?per_page=30', kind: 'gh' },
  { id: 'upstream-releases', url: 'https://api.github.com/repos/flop-labs/technocore-chat/releases?per_page=1', kind: 'gh' },
  /**
   * Hayes writes here, and this list did not have him.
   *
   * Everything above watches Flop Labs the organisation — its site, its teaser,
   * its server. The person who announces things about Flop Network was missing
   * entirely, and the reported collaboration mechanism is exactly the kind of
   * thing that gets said in a post before it appears on a product page.
   *
   * The RSS feed rather than X: it is public, needs no credential, and scraping
   * X would breach its terms. Found by cross-checking a second FLOP project of
   * this operator's, which listed the Substack as a first-party link while this
   * watcher had never heard of it.
   */
  { id: 'hayes-substack', url: 'https://cryptohayes.substack.com/feed', kind: 'rss' }
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
  /**
   * An RSS feed is watched for its POSTS, not its bytes.
   *
   * Hayes's feed carries full post bodies and runs to 1.4 MB, so digesting the
   * whole thing would fire on every edit, re-render and changed tracking
   * parameter. An alert that cries wolf hourly is one nobody reads — the exact
   * failure this file has already had twice — so only the item titles count.
   */
  if (kind === 'rss') {
    const titles = [...body.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{0,120})/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    return titles.slice(0, 20).join(' | ');
  }
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

/**
 * Every commit the fetch returned, newest first, so a change can name the ones
 * that landed rather than only the last one.
 *
 * `summarise` reports the newest commit and always did. That was the whole bug:
 * the request asked for five commits and the summary read `[0]`, so four of
 * every five were fetched, parsed and thrown away. Two of the largest upstream
 * changes of 2026-09-05 — the 0.12.1 release and `feat(humans)`, which added
 * did:key sign-in, passkeys and agent delegation — landed between hourly runs
 * behind a newer commit and were never reported. The operator brought both to
 * this project by hand.
 *
 * It is the same failure this project reported upstream as
 * flop-labs/technocore-chat#481 on 2026-09-05: a consumer that falls further
 * behind than its window silently loses records and cannot tell. Worth saying
 * plainly, since we filed that one.
 */
function commitList(body) {
  try {
    return JSON.parse(body).map((c) => ({
      sha: c.sha.slice(0, 7),
      title: c.commit.message.split('\n')[0].slice(0, 100)
    }));
  } catch {
    return undefined;
  }
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
      const commits = source.id === 'upstream-commits' ? commitList(body) : undefined;

      sources[source.id] = { url: source.url, digest, summary, signals, paths, links, commits, checkedAt: now };

      const before = prevSources[source.id];

      /**
       * A source coming back from an outage is not a content change.
       *
       * `hayes-substack` has answered the scheduled runner 403 since 2026-08-30
       * while answering this machine 200, so its stored digest is null. Compared
       * against null, every local run reported the whole feed as "changed" and
       * every word in it as a fresh signal — "SIGNAL: genesis", hourly, about a
       * feed nobody had edited. This file already warns twice that an alert
       * which cries wolf is one nobody reads; this was the third time.
       */
      const recovered = Boolean(before && !before.digest && before.error);
      if (recovered) {
        changes.push({ id: source.id, url: source.url, recovered: true,
          was: `unreachable ×${before.consecutiveFailures || 1} since ${(before.failingSince || '').slice(0, 10)}`,
          now: summary });
      }

      if (before && before.digest && before.digest !== digest) {
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

        /**
         * Name every commit since the last run, not just the newest.
         *
         * When every commit in the page is new the gap is at least the page and
         * possibly larger, which is the one thing a windowed consumer can still
         * honestly say about what it lost.
         */
        if (commits && Array.isArray(before.commits)) {
          const seen = new Set(before.commits.map((c) => c.sha));
          const added = commits.filter((c) => !seen.has(c.sha));
          if (added.length) change.addedCommits = added;
          if (added.length === commits.length) change.windowOverflowed = commits.length;
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
      if (before && !recovered) {
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
      /**
       * One failure is not news. A week of them is.
       *
       * A source being unreachable was recorded and forgotten, which is right
       * for a blip and wrong for a block: Substack answers this machine with a
       * 200 and the GitHub Actions runner with a 403, so `hayes-substack` had
       * been failing every hour while the project went on describing it as
       * watched. Nothing anywhere said we had stopped looking.
       *
       * Counting the run gives the alert something to fire on, and gives the
       * status page a way to say "watched" and "blind" as different words.
       */
      const prev = prevSources[source.id] || {};
      const failures = (prev.error ? (prev.consecutiveFailures || 1) : 0) + 1;
      sources[source.id] = {
        url: source.url,
        error: err.message,
        digest: prev.digest || null,
        summary: prev.summary || null,
        checkedAt: now,
        consecutiveFailures: failures,
        failingSince: prev.error ? (prev.failingSince || prev.checkedAt || now) : now
      };
      console.warn(`[watch] ${source.id}: ${err.message} (${failures} in a row)`);
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

  /**
   * Advancing the baseline is how an alert gets consumed.
   *
   * The baseline is committed, and CI reports a change by diffing against it. So
   * a local run that writes and commits the new baseline silently destroys the
   * alert CI would have raised — the next scheduled run compares against a state
   * that already contains the finding and reports nothing.
   *
   * That is not hypothetical. On 2026-08-27 a room called `faucet` appeared, a
   * local run detected it, the new baseline was committed, and the hourly
   * workflow was left with nothing to say about the single event this watcher
   * was built to catch.
   *
   * So writing the baseline is now opt-in. Locally the tool is a read-only check
   * by default and prints what it found; CI passes --commit-baseline because CI
   * is the one place that also delivers the alert.
   */
  const commitBaseline = process.argv.includes('--commit-baseline') || process.env.CI === 'true';

  if (commitBaseline) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      checkedAt: now,
      sources,
      interestingRooms
    }, null, 2), 'utf8');
  } else if (changes.length || newRooms.length || signalAlerts.length) {
    console.log('[watch] Baseline NOT advanced — this was a local read-only check.');
    console.log('[watch] The findings below are still pending for the scheduled run to report.');
    console.log('[watch] Pass --commit-baseline only if you are also delivering the alert.');
  }

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
    console.log(`  ${c.id}: ${c.was}  ->  ${c.now}${c.recovered ? '   (source recovered — not a content change)' : ''}`);
    if (c.addedPaths) console.log(`    NEW ROUTES: ${c.addedPaths.join(', ')}`);
    if (c.addedLinks) console.log(`    NEW PAGES: ${c.addedLinks.join(', ')}`);
    // Every commit since the last run, oldest last, because a list that shows
    // only its newest entry is the bug this reporting exists to end.
    if (c.addedCommits) {
      console.log(`    ${c.addedCommits.length} NEW COMMIT(S):`);
      for (const k of c.addedCommits) console.log(`      ${k.sha}  ${k.title}`);
    }
    if (c.windowOverflowed) {
      console.log(`    WINDOW OVERFLOWED: all ${c.windowOverflowed} fetched commits were new, `
        + 'so at least that many landed and possibly more were missed.');
    }
  }
  for (const r of newRooms) console.log(`  new room: ${r}`);
  for (const a of signalAlerts) console.log(`  SIGNAL in ${a.id}: ${a.words.join(', ')}`);
}

main().catch((err) => {
  console.error('[watch] failed:', err.message);
  process.exit(1);
});
