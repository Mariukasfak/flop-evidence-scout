/**
 * Tells the operator by email when the agent has actually stopped.
 *
 * Written after the agent was down for 21 hours and nobody noticed. The
 * monitoring was not broken — check-freshness caught it and the watcher workflow
 * went red at 14:28, 18:30, 00:20 and 06:40, exactly across the outage. The
 * failure was that a red build is a thing you have to go and look at, and the
 * whole point of an alarm is that it comes to you.
 *
 * So this turns a stoppage into a GitHub issue, which arrives as an email.
 *
 * One rolling issue, reopened rather than duplicated: this runs hourly, and a
 * fresh issue every hour during a weekend outage is indistinguishable from spam
 * — which is how an alarm gets muted, which is how the next outage goes
 * unnoticed for 21 hours again.
 *
 * It reports from the SHARED record, not from a local file, because the local
 * artefacts age by design whenever the other machine holds the lease. The shared
 * note is the only thing that can tell a standdown from a stoppage.
 *
 * Run by .github/workflows/watch-sources.yml; a no-op without gh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** How long a silence has to last before it is worth an email. */
const SILENT_MINUTES = 120;

const TRACKER_LABEL = 'agent-down';
const TRACKER_TITLE = 'Agent stopped: no cycles reaching the shared record';
const FRESHNESS = path.resolve('docs/freshness.json');

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.stderr || err.message}`);
  }
}

let freshness;
try {
  freshness = JSON.parse(fs.readFileSync(FRESHNESS, 'utf8'));
} catch {
  console.log('No freshness report to read; check-freshness runs before this.');
  process.exit(0);
}

const ageMin = freshness?.combined?.ageMin;

/**
 * No reading is not a stoppage.
 *
 * When Technocore is unreachable the combined view is absent, and this project
 * has already made the mistake of calling that "the agent stopped" three times.
 * Silence about it is correct: the next run that does reach the server reports.
 */
if (!Number.isFinite(ageMin)) {
  console.log('Combined record unreadable — nothing can be concluded, so nothing is filed.');
  process.exit(0);
}

const existing = gh(['issue', 'list', '--label', TRACKER_LABEL, '--state', 'all',
  '--limit', '1', '--json', 'number,state'], { allowFailure: true });
let tracker = null;
try {
  tracker = JSON.parse(existing || '[]')[0] || null;
} catch { /* no gh, or no issues */ }

if (ageMin <= SILENT_MINUTES) {
  // Recovered. Close the tracker so the next outage is a fresh notification
  // rather than a comment on something already open and already ignored.
  if (tracker && tracker.state === 'OPEN') {
    gh(['issue', 'comment', String(tracker.number), '--body',
      `Recovered. The shared record shows a cycle ${Math.round(ageMin)} minutes ago.`], { allowFailure: true });
    gh(['issue', 'close', String(tracker.number)], { allowFailure: true });
    console.log(`Agent recovered (${Math.round(ageMin)} min) — tracker closed.`);
  } else {
    console.log(`Agent healthy: last cycle ${Math.round(ageMin)} minutes ago.`);
  }
  process.exit(0);
}

const hours = (ageMin / 60).toFixed(1);
const body = [
  `**No cycle has reached the shared record for ${hours} hours.**`,
  '',
  'Both machines write to one activity note, so this is not a lease standdown —',
  'it means neither the local daemon nor the scheduled cloud run is completing cycles.',
  '',
  'Most likely, in order of how often it has actually happened:',
  '',
  '1. The operator\'s machine rebooted. Nothing starts the agent at logon, and',
  '   nothing starts Ollama either — so a restart takes both down silently.',
  '2. The launcher window was closed.',
  '3. Technocore has been refusing writes long enough that state stopped persisting.',
  '',
  'To restore: run `PARUOSTI-VISKA.bat`, then check `npm run readiness`.',
  '',
  '_Filed automatically. This issue closes itself when cycles resume._'
].join('\n');

if (tracker && tracker.state === 'OPEN') {
  gh(['issue', 'comment', String(tracker.number), '--body',
    `Still down — ${hours} hours since the last recorded cycle.`], { allowFailure: true });
  console.log(`Still down (${hours} h) — commented on #${tracker.number}.`);
} else {
  gh(['issue', 'create', '--title', TRACKER_TITLE, '--label', TRACKER_LABEL, '--body', body],
    { allowFailure: true });
  console.log(`Filed: agent down ${hours} hours.`);
}
