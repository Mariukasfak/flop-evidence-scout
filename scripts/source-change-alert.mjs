/**
 * Turns a watched-source change into a GitHub issue comment, so the operator
 * hears about it by email instead of by refreshing a page.
 *
 * One rolling issue rather than one per change: this fires hourly and a stream
 * of new issues would be indistinguishable from noise. New findings land as
 * comments on the open tracker.
 *
 * Run by .github/workflows/watch-sources.yml; a no-op locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CHANGE_PATH = path.resolve('data/source-change.json');
const STATE_PATH = path.resolve('docs/watch/state.json');
const TRACKER_LABEL = 'source-watch';
const TRACKER_TITLE = 'Source watch: official Flop Labs / Technocore sources';

/**
 * How many consecutive failed checks make a source a blind spot.
 *
 * Six hourly checks. Below that it is a blip and saying so would train the
 * reader to skim these; above it, "we watch this source" has stopped being true
 * and the only person who can fix it is the one reading the email.
 */
const BLIND_AFTER = 6;

/** Read the watcher's own state to find sources it has stopped being able to read. */
function blindSources() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return Object.entries(state.sources || {})
      .filter(([, v]) => v.error && (v.consecutiveFailures || 0) >= BLIND_AFTER)
      .map(([id, v]) => ({ id, ...v }));
  } catch {
    return [];
  }
}

/**
 * Announced on crossing, then once a day.
 *
 * A blind source stays blind until somebody acts, and repeating it hourly is
 * how a tracker gets muted — which is the failure mode this whole file exists
 * to avoid.
 */
const worthSaying = (n) => n === BLIND_AFTER || n % 24 === 0;

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.stderr || err.message}`);
  }
}

const blind = blindSources().filter((s) => worthSaying(s.consecutiveFailures));

let change = { detectedAt: new Date().toISOString() };
if (fs.existsSync(CHANGE_PATH)) {
  try { change = JSON.parse(fs.readFileSync(CHANGE_PATH, 'utf8')); } catch { /* keep the stub */ }
}
const { changes = [], newRooms = [] } = change;

if (changes.length === 0 && newRooms.length === 0 && blind.length === 0) {
  console.log('Nothing to report: no source moved and none has gone blind.');
  process.exit(0);
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log('Change detected but no GH token here; skipping issue.');
  process.exit(0);
}

const lines = [`**${change.detectedAt}**`, ''];

if (changes.length > 0) {
  lines.push('| Source | Was | Now |', '| --- | --- | --- |');
  for (const c of changes) {
    lines.push(`| [\`${c.id}\`](${c.url}) | ${c.was ?? '—'} | **${c.now ?? '—'}** |`);
  }
  lines.push('');
}

if (newRooms.length > 0) {
  lines.push('**New rooms matching faucet / testnet / task / quest / bounty / claim:**', '');
  for (const r of newRooms) lines.push(`- \`/r/${r}\``);
  lines.push('');
  lines.push('> A room name is a string a stranger chose. Not evidence of anything official.');
  lines.push('> Confirm against flop.finance before acting, and never connect a wallet on the strength of a name.');
  lines.push('');
}

if (blind.length > 0) {
  lines.push('**Sources we have stopped being able to read:**', '');
  lines.push('| Source | Failing since | Checks | Error |', '| --- | --- | --- | --- |');
  for (const s of blind) {
    lines.push(`| [\`${s.id}\`](${s.url}) | ${s.failingSince || '?'} | ${s.consecutiveFailures} | \`${s.error}\` |`);
  }
  lines.push('');
  lines.push('> This is a blind spot, not a change. Until it is fixed, treat this source as unwatched —');
  lines.push('> the last digest on file is the last time anyone actually looked.');
  lines.push('');
}

lines.push('---');
lines.push('_X/Twitter is deliberately not watched here: reading it reliably needs API credentials,');
lines.push('and third-party mirrors are the kind of unverified relay this project will not act on._');

const body = lines.join('\n');
const bodyFile = path.resolve('data/source-change-body.md');
fs.writeFileSync(bodyFile, body, 'utf8');

gh(['label', 'create', TRACKER_LABEL, '--color', '0E8A16', '--description', 'Official source changed'], { allowFailure: true });

const existing = gh(
  ['issue', 'list', '--state', 'open', '--label', TRACKER_LABEL, '--json', 'number', '--jq', '.[0].number // empty'],
  { allowFailure: true }
);

if (existing) {
  gh(['issue', 'comment', existing, '--body-file', bodyFile]);
  console.log(`Commented on source-watch tracker #${existing}`);
} else {
  const url = gh(['issue', 'create', '--title', TRACKER_TITLE, '--label', TRACKER_LABEL, '--body-file', bodyFile]);
  console.log('Opened source-watch tracker:', url);
}
