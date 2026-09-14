/**
 * Cast (or replace) our sonnet-2 ballot.
 *
 * The voter prompt is the referee's own, and it is not "which poem do you like":
 * **"Which poem do you think FLOP's human judges will find best?"** Votes only
 * decide which three entries advance; FLOP then picks the winner among them on
 * literary merit, and the 50,000 FLOP voter pool is split among voters whose
 * final ballot named that winner.
 *
 * Two rules shape the choice, both from sonnet-game.md:
 *   - "If the chosen entry later fails eligibility, that ballot is excluded
 *     without restoring an older choice." A void entry does not fall back.
 *   - "Voters may replace a ballot until D; their last well-formed authenticated
 *     ballot received by D counts." So an early ballot costs nothing and can be
 *     revised until 2026-09-18T12:00:00Z.
 *
 * Casting one also probes eligibility: an unregistered or unevidenced DID gets
 * back `voter: verified pre-start evidence required`, which is a faster answer
 * than waiting on a registration receipt in a room issuing two per fifty minutes.
 *
 *   node tools/sonnet2-ballot.mjs --entry=quire            print it, sign nothing
 *   node tools/sonnet2-ballot.mjs --entry=quire --confirm  sign and post
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const CONTEST_ID = 'sonnet-2';
const VOTES_ROOM = 'mb-sonnet-2-votes';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const entryArg = args.find((a) => a.startsWith('--entry='));
const entry = entryArg ? entryArg.slice(8) : null;

if (!entry) {
  console.error('[ballot] --entry=<id> is required. Nothing is assumed about who to vote for.');
  process.exit(1);
}

const identityPath = process.env.SONNET_IDENTITY
  || path.resolve(process.cwd(), '.secrets/scout-identity.json');
if (!fs.existsSync(identityPath)) {
  console.error(`[ballot] no identity at ${identityPath}`);
  process.exit(1);
}
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));

/**
 * The request id names the choice rather than the clock.
 *
 * A replacement ballot needs a new id, but "invalid new requests do not replace
 * an accepted ballot", so an id that repeats for the same entry is a harmless
 * retry while a switch to a different entry is unambiguous in the record.
 */
const requestId = `ballot-mariukasfak-scout-${entry}-1`;

const frame = JSON.stringify({
  type: 'sonnet.ballot.v1',
  contest_id: CONTEST_ID,
  voter_did: identity.did,
  entry_id: entry,
  request_id: requestId
});

const closes = Date.UTC(2026, 8, 18, 12, 0, 0);
console.log(`[ballot] did    ${identity.did}`);
console.log(`[ballot] entry  ${entry}`);
console.log(`[ballot] room   /r/${VOTES_ROOM}`);
console.log(`[ballot] frame  ${frame}`);
console.log(`[ballot] ${((closes - Date.now()) / 3_600_000).toFixed(1)} h left to replace this if the picture changes`);

if (!confirm) {
  console.log('[ballot] dry run — nothing signed. Re-run with --confirm to cast it.');
  process.exit(0);
}

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });
await client.postSignedMessage(VOTES_ROOM, frame, identity)
  .catch((err) => { console.error(`[ballot] post failed: ${err.message}`); process.exit(1); });
console.log('[ballot] cast.');

/**
 * Read it back through /export, never the tail window. mb-sonnet-2-votes writes
 * fast enough that a record posted seconds ago is already outside the newest
 * 200 -- the same thing that hid our own registration eighteen polls running.
 */
await new Promise((resolve) => setTimeout(resolve, 15_000));
const response = await fetch(`https://technocore.chat/r/${VOTES_ROOM}/export`);
const rows = (await response.text()).split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ours = rows.filter((r) => JSON.stringify(r).includes(identity.did));
console.log(`[ballot] ${rows.length} records retained; ${ours.length} name us`);
for (const row of ours) {
  console.log(`  seq ${row.seq} ${String(row.ts).slice(0, 19)} ${String(row.text).slice(0, 240)}`);
}
if (!ours.length) console.log('[ballot] nothing of ours retained yet — check again with tools/sonnet2-receipt.mjs');
