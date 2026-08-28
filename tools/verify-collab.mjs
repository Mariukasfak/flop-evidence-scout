/**
 * Check this project's collaboration record without trusting this project.
 *
 * The claim is "these two agents work together". A claim like that is worth
 * nothing unless someone who distrusts both keys can test it, so this script
 * fetches the record straight from technocore.chat, re-derives every signed
 * payload, and verifies each signature against the key that claims to have made
 * it. Nothing here reads local state, and it needs no key of its own.
 *
 * It reports what fails as loudly as what passes. A record where every
 * acknowledgement carries the same key is one agent talking to itself, and this
 * prints that rather than a pair of green ticks.
 *
 * Run: node tools/verify-collab.mjs [did-a] [did-b]
 * With no arguments it reads the two DIDs this repository publishes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { TechnocoreClient } from '../src/technocore-client.mjs';
import { readRecord, summariseRecord, verifyExchange, COLLAB_NS, pairKey } from '../src/collaboration.mjs';

function publishedDids() {
  // docs/ is what a stranger can see, so a stranger's check starts there rather
  // than from .secrets/, which they do not have and must not need.
  const candidates = ['docs/claim-rehearsal-receipt.json', 'docs/contributions.json', 'docs/audit-history.json'];
  for (const file of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const found = JSON.stringify(json).match(/did:key:z6M[1-9A-HJ-NP-Za-km-z]{40,}/g);
      if (found && found.length >= 2) return [...new Set(found)].slice(0, 2);
    } catch { /* try the next one */ }
  }
  return null;
}

const args = process.argv.slice(2).filter((a) => a.startsWith('did:key:'));
const dids = args.length === 2 ? args : publishedDids();

if (!dids || dids.length !== 2) {
  console.error('Need two did:key values — pass them as arguments, or run this from a checkout that publishes them.');
  process.exit(2);
}

const client = new TechnocoreClient({ baseUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat', readOnly: true });

console.log('\n=== COLLABORATION RECORD, CHECKED FROM SOURCE ===\n');
console.log(`  note      /kv/${COLLAB_NS}/${pairKey(dids[0], dids[1])}`);
for (const did of [...dids].sort()) console.log(`  identity  ${did}`);
console.log();

const { reachable, record, error } = await readRecord(client, dids[0], dids[1]);

if (!reachable) {
  console.error(`  Technocore is unreachable (${error}). That is not a failed verification — nothing was checked.`);
  process.exit(3);
}
if (error) console.log(`  NOTE: ${error}\n`);

const summary = summariseRecord(record);

if (summary.onRecord === 0) {
  console.log('  No exchanges on record yet.\n');
  process.exit(0);
}

for (const exchange of record.exchanges) {
  const verdict = verifyExchange(exchange, { pair: record.pair });
  const mark = verdict.ok ? 'OK  ' : 'FAIL';
  console.log(`  [${mark}] seq ${String(exchange.seq).padStart(6)}  ${exchange.at}`);
  console.log(`         from ${exchange.fromDid}`);
  console.log(`         ack  ${exchange.ackBy}`);
  if (!verdict.ok) console.log(`         ^ ${verdict.reason}`);
}

console.log(`\n  exchanges on record        ${summary.onRecord}`);
console.log(`  signatures verified        ${summary.verified}`);
console.log(`  signatures rejected        ${summary.rejected}`);
console.log(`  distinct acknowledgers     ${summary.distinctAcknowledgers}`);
console.log(`  note size                  ${summary.noteChars} of 8192 characters`);
for (const [direction, count] of Object.entries(summary.lifetime)) {
  console.log(`  lifetime  ${direction}  ${count}`);
}

console.log(
  summary.mutual
    ? '\n  MUTUAL: both identities have signed acknowledgements. This is an exchange.'
    : '\n  NOT MUTUAL: every acknowledgement carries one key. That is one agent, not two working together.'
);

console.log(
  '\n  What this proves: two keys signed statements about the same messages.\n'
  + '  What it does not prove: that either agent is honest, useful, or independent.\n'
  + '  Both keys belong to one operator, which is stated rather than hidden.\n'
);

if (summary.rejected > 0) process.exitCode = 1;
