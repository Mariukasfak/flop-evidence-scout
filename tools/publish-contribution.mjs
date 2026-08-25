/**
 * Signs a technocore-contribution-v1 proof for one artifact at one exact commit,
 * records it in the repo, and announces it in a room.
 *
 * Deliberately manual. The swarm's version of this is automated and points at
 * whatever URL is handy; ours runs when there is something real to point at, and
 * refuses to announce anything without a specific summary of what the work is.
 *
 * Run: node tools/publish-contribution.mjs \
 *        --url https://github.com/... --commit <sha> \
 *        --summary "what this actually is" [--room technocore] [--post]
 *
 * Without --post it prints and files the proof but sends nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadOrCreateIdentity } from '../src/identity.mjs';
import { TechnocoreClient } from '../src/technocore-client.mjs';
import { Guardrails } from '../src/guardrails.mjs';
import {
  createContributionProof,
  verifyContributionProof,
  contributionAnnouncement
} from '../src/contribution.mjs';

const PROOFS_PATH = path.resolve('docs/contributions.json');

function parseArgs(argv) {
  const out = { url: null, commit: null, summary: null, room: 'technocore', post: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--post') out.post = true;
    else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--commit' && argv[i + 1]) out.commit = argv[++i];
    else if (a === '--summary' && argv[i + 1]) out.summary = argv[++i];
    else if (a === '--room' && argv[i + 1]) out.room = argv[++i];
  }
  return out;
}

function headCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) throw new Error('--url is required (an https URL to the published artifact)');
  if (!args.summary) throw new Error('--summary is required: say what the work actually is');

  const commit = args.commit || headCommit();
  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');

  const proof = createContributionProof(identity, args.url, commit);
  verifyContributionProof(proof);   // never publish a proof we have not checked
  const line = contributionAnnouncement(proof, { summary: args.summary });

  console.log('\nProof (verifies against the DID alone):');
  console.log(JSON.stringify(proof, null, 2));
  console.log(`\nAnnouncement (${line.length} chars):\n${line}\n`);

  let existing = [];
  if (fs.existsSync(PROOFS_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(PROOFS_PATH, 'utf8')); } catch { existing = []; }
  }
  const record = { ...proof, summary: args.summary, announcedIn: args.post ? args.room : null, at: new Date().toISOString() };
  existing = existing.filter((e) => !(e.artifact_url === proof.artifact_url && e.commit === proof.commit));
  existing.push(record);
  fs.mkdirSync(path.dirname(PROOFS_PATH), { recursive: true });
  fs.writeFileSync(PROOFS_PATH, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`Recorded in ${PROOFS_PATH}`);

  if (!args.post) {
    console.log('Not posted (--post not given).');
    return;
  }

  const client = new TechnocoreClient({ baseUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat' });
  const guardrails = new Guardrails({ maxPerHour: 4, minCooldownMs: 0 });
  const check = guardrails.canSendMessage(line);
  if (!check.allowed) throw new Error(`Guardrails refused: ${check.reason}`);

  await client.postMessage(args.room, line, identity);
  console.log(`Announced in /r/${args.room}.`);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
