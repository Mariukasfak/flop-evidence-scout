/**
 * Turns a faucet-radar hit into a GitHub issue, which is how the operator
 * actually gets notified (issue -> email/push) without watching a dashboard.
 *
 * Why this reads the network itself rather than a file.
 *
 * It used to read `data/faucet-alert.json` and nothing else. That file is
 * written by the daemon, and since 2026-09-04 the daemon runs on the server
 * while this script runs in CI, where the token is — two machines that share
 * no disk. So every run since then printed "radar clear" and every hit went
 * nowhere, including a real one on 2026-09-05 at 05:12Z. A notifier whose
 * input is written on a machine it cannot see is not a notifier.
 *
 * Detecting here costs one request and removes the coupling entirely. The
 * file is still read when it happens to be present, so a CI-side daemon pass
 * still contributes what it saw.
 *
 * Deliberately conservative: one open issue at a time. A hit that fires on
 * every 15-minute tick would otherwise bury the signal it exists to deliver.
 *
 * Run by .github/workflows/flop-scout-daemon.yml; prints and exits without a
 * token, so it stays a no-op locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { looksLikeFaucet } from '../src/scribe-engine.mjs';

const BASE_URL = process.env.TECHNOCORE_URL || 'https://technocore.chat';
const ALERT_PATHS = ['data/faucet-alert.json', 'data/local/faucet-alert.json'];

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`gh ${args[0]} failed: ${err.stderr || err.message}`);
  }
}

/** Rooms the venue lists right now whose names look like a faucet. */
async function fromListing() {
  // A cleared timer rather than AbortSignal.timeout: the latter leaves a live
  // handle behind and Node prints a libuv assertion at exit on Windows, which
  // in a CI log reads exactly like a crash in a script that in fact succeeded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE_URL}/rooms?format=json`, { signal: controller.signal });
    if (!res.ok) {
      console.log(`Room listing unavailable (HTTP ${res.status}); falling back to the alert file.`);
      return [];
    }
    const json = await res.json();
    const rows = Array.isArray(json) ? json : (json.rooms || []);
    return rows
      .map((row) => (typeof row === 'string' ? row : (row?.room ?? row?.name ?? '')))
      .map((name) => String(name).trim())
      .filter((name) => name && looksLikeFaucet(name));
  } catch (err) {
    // A radar that fails the build when the venue has a bad minute is worse
    // than one that misses a tick: the next run is fifteen minutes away.
    console.log(`Room listing read failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Whatever a daemon pass on this same machine happened to record. */
function fromAlertFile() {
  for (const rel of ALERT_PATHS) {
    const file = path.resolve(rel);
    if (!fs.existsSync(file)) continue;
    try {
      const alert = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rooms = (alert.rooms || []).map((r) => r.room).filter(Boolean);
      if (rooms.length) return { rooms, detectedAt: alert.detectedAt, seq: alert.eventsSeq, file: rel };
    } catch (err) {
      console.error(`Alert file ${rel} is unreadable: ${err.message}`);
    }
  }
  return { rooms: [], detectedAt: null, seq: null, file: null };
}

/**
 * Returns rather than `process.exit`, on purpose. Exiting while undici still
 * holds a keep-alive socket aborts the process on Windows with a libuv
 * assertion — output already correct, exit code not — which in a CI log is
 * indistinguishable from a real crash.
 */
async function main() {
const listed = await fromListing();
const filed = fromAlertFile();
const rooms = [...new Set([...listed, ...filed.rooms])];

if (rooms.length === 0) {
  console.log('Faucet radar clear — nothing faucet-shaped in the room listing or the alert file.');
  return;
}

console.log(`Faucet radar: ${rooms.join(', ')} (listing: ${listed.length}, file: ${filed.rooms.length})`);

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log('No GH token here; skipping the issue.');
  return;
}

const open = gh(['issue', 'list', '--state', 'open', '--label', 'faucet-radar', '--json', 'number'], { allowFailure: true });
if (open && open !== '[]') {
  console.log('An open faucet-radar issue already exists; not filing another.');
  return;
}

gh(['label', 'create', 'faucet-radar', '--color', 'B60205', '--description', 'Testnet faucet radar hit'], { allowFailure: true });

const body = [
  'Rooms whose names look like a faucet:',
  '',
  ...rooms.map((r) => `- \`${r}\`${listed.includes(r) ? ' — listed in `/rooms` now' : ' — seen announced on `/r/events`'}`),
  '',
  filed.detectedAt ? `Alert file (${filed.file}) recorded: ${filed.detectedAt} (events seq #${filed.seq ?? '?'})` : 'No alert file on this machine; detected from the live room listing.',
  '',
  '## Before acting on this',
  '',
  'A room name is a string a stranger chose. This is **not** evidence that Flop Labs',
  'launched anything. Confirm against flop.finance and the official accounts first —',
  'as of 2026-09-05 `flop.finance/faucet` still answers 404.',
  '',
  'And a busy faucet-shaped room is not a launch either. On 2026-09-05 `/r/faucet`',
  'took 20,468 messages from 20,440 distinct DIDs in thirty minutes, nearly all of',
  'them an identical claim line. That is the shape of a sybil flood, not of a',
  'distribution anyone can show is real.',
  '',
  'Never connect a wallet, sign a financial transaction, or paste a private key on the',
  'strength of a room name. A fake "faucet" room is the cheapest phishing vector on a',
  'world-writable network.',
  '',
  'The agent itself does not interact with the room. This issue is a notification only.'
].join('\n');

const bodyFile = path.resolve('data/faucet-issue-body.md');
fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
fs.writeFileSync(bodyFile, body, 'utf8');

const url = gh([
  'issue', 'create',
  '--title', `Faucet radar: ${rooms.slice(0, 3).join(', ')}`,
  '--label', 'faucet-radar',
  '--body-file', bodyFile
]);

console.log('Filed faucet-radar issue:', url);
}

await main();
