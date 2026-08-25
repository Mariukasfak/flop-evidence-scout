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
const TRACKER_LABEL = 'source-watch';
const TRACKER_TITLE = 'Source watch: official Flop Labs / Technocore sources';

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.stderr || err.message}`);
  }
}

if (!fs.existsSync(CHANGE_PATH)) {
  console.log('No source change to report.');
  process.exit(0);
}

const change = JSON.parse(fs.readFileSync(CHANGE_PATH, 'utf8'));
const { changes = [], newRooms = [] } = change;

if (changes.length === 0 && newRooms.length === 0) {
  console.log('Change file is empty.');
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
