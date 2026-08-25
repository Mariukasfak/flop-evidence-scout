/**
 * Turns a faucet-radar hit into a GitHub issue, which is how the operator
 * actually gets notified (issue -> email/push) without watching a dashboard.
 *
 * Deliberately conservative: one open issue at a time. A hit that fires on every
 * 15-minute tick would otherwise bury the signal it exists to deliver.
 *
 * Run by .github/workflows/flop-scout-daemon.yml; a no-op locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ALERT_PATH = path.resolve('data/faucet-alert.json');

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`gh ${args[0]} failed: ${err.stderr || err.message}`);
  }
}

if (!fs.existsSync(ALERT_PATH)) {
  console.log('Faucet radar clear — no alert file.');
  process.exit(0);
}

let alert;
try {
  alert = JSON.parse(fs.readFileSync(ALERT_PATH, 'utf8'));
} catch (err) {
  console.error('Alert file is unreadable:', err.message);
  process.exit(0);
}

const rooms = (alert.rooms || []).map((r) => r.room).filter(Boolean);
if (rooms.length === 0) {
  console.log('Alert file carries no room names — nothing to report.');
  process.exit(0);
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log(`Faucet radar hit (${rooms.join(', ')}) but no GH token here; skipping issue.`);
  process.exit(0);
}

const open = gh(['issue', 'list', '--state', 'open', '--label', 'faucet-radar', '--json', 'number'], { allowFailure: true });
if (open && open !== '[]') {
  console.log('An open faucet-radar issue already exists; not filing another.');
  process.exit(0);
}

gh(['label', 'create', 'faucet-radar', '--color', 'B60205', '--description', 'Testnet faucet radar hit'], { allowFailure: true });

const body = [
  'The Sentinel Scribe saw these room names announced on `/r/events`:',
  '',
  ...rooms.map((r) => `- \`${r}\``),
  '',
  `Detected at: ${alert.detectedAt || 'unknown'} (events seq #${alert.eventsSeq ?? '?'})`,
  '',
  '## Before acting on this',
  '',
  'A room name is a string a stranger chose. This is **not** evidence that Flop Labs',
  'launched anything. Confirm against flop.finance and the official accounts first.',
  '',
  'Never connect a wallet, sign a financial transaction, or paste a private key on the',
  'strength of a room name. A fake "faucet" room is the cheapest phishing vector on a',
  'world-writable network.',
  '',
  'The agent itself does not interact with the room. This issue is a notification only.'
].join('\n');

const bodyFile = path.resolve('data/faucet-issue-body.md');
fs.writeFileSync(bodyFile, body, 'utf8');

const url = gh([
  'issue', 'create',
  '--title', `Faucet radar: ${rooms.slice(0, 3).join(', ')} appeared on /r/events`,
  '--label', 'faucet-radar',
  '--body-file', bodyFile
]);

console.log('Filed faucet-radar issue:', url);
