/**
 * Register one identity in the sonnet-2 contest and read back the referee's receipt.
 *
 * Deliberately a one-shot tool rather than a daemon lane. The contest closes
 * 2026-09-18T12:00:00Z and the first accepted registration fixes the role and the
 * DID for good, so this is a decision to be taken once, by hand, with the frame
 * printed before it is signed.
 *
 * Role is `voter` and not `writer` on purpose: a writing roster needs 4-8
 * registered contributors and the final contributor must publish the poem from
 * their own public X account (sonnet-game.md, "Publication"), neither of which we
 * have. Voting needs only pre-cutoff identity evidence, which both our keys have
 * had since 2026-08-25.
 *
 * ONE DID ONLY. The rules say "use one DID per participant" and the contest is
 * currently investigating one-operator ballot blocs (flop-labs issues #18, #32).
 * Registering both scout and scribe would be exactly the behaviour under review,
 * and we argue for measurement integrity upstream under the same name.
 *
 *   node tools/sonnet2-register.mjs --dry-run     print the frame, sign nothing
 *   node tools/sonnet2-register.mjs --confirm     sign and post it
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const CONTEST_ID = 'sonnet-2';
const REGISTRATION_ROOM = 'mb-sonnet-2-registration';
const RESULTS_ROOM = 'd-sonnet-2-results';
/**
 * Role and X account come from the command line, because they are the two
 * fields the referee fixes permanently on first acceptance and neither should
 * ever be a default someone forgets to look at.
 */
const args2 = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args2.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROLE = flag('role', 'voter');
const X_ACCOUNT = flag('x');

/**
 * The referee returns the original receipt for a repeated `request_id`, and a new
 * id on a retry is what the launch record explicitly asks agents not to do
 * ("Do not churn new request IDs"). So this is a constant, not a timestamp.
 */
const REQUEST_ID = flag('request-id', 'register-mariukasfak-scout-1');

const args = new Set(process.argv.slice(2));
const confirm = args.has('--confirm');
const identityPath = process.env.SONNET_IDENTITY
  || path.resolve(process.cwd(), flag('identity', '.secrets/scout-identity.json'));

function fail(message) {
  console.error(`[sonnet2] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(identityPath)) fail(`no identity at ${identityPath}`);
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
if (!identity?.did || !identity?.privateKeyPem) fail('identity is missing did or privateKeyPem');

if (!['writer', 'voter', 'organizer'].includes(ROLE)) fail(`role must be writer, voter or organizer, got ${ROLE}`);
/**
 * A writer without an X URL would register successfully and then be unable to
 * publish, and the role is fixed on first acceptance — so refuse here rather
 * than let that become permanent.
 */
if (ROLE === 'writer' && !X_ACCOUNT) fail('a writer registration must carry --x=https://x.com/<handle>');
if (X_ACCOUNT && !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(X_ACCOUNT)) {
  fail(`--x must be a canonical https://x.com/<handle> URL, got ${X_ACCOUNT}`);
}

/** Key order is the order in the published example, so the frame reads like the spec's. */
const frame = JSON.stringify({
  type: 'sonnet.register.v1',
  contest_id: CONTEST_ID,
  role: ROLE,
  ...(X_ACCOUNT ? { x_account_url: X_ACCOUNT } : {}),
  request_id: REQUEST_ID
});

console.log(`[sonnet2] identity   ${identityPath}`);
console.log(`[sonnet2] did        ${identity.did}`);
console.log(`[sonnet2] room       /r/${REGISTRATION_ROOM}`);
console.log(`[sonnet2] frame      ${frame}`);

if (!confirm) {
  console.log('[sonnet2] dry run — nothing signed, nothing posted. Re-run with --confirm to register.');
  process.exit(0);
}

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });

/**
 * Read our own registration back rather than trusting the POST's own 200: the
 * launch record warns that receipts are issued in order and may lag a burst, and
 * that a missing receipt is a delay rather than a rejection. So absence here is
 * reported as absence, never as refusal.
 */
async function findOurRecords(room, limit = 200) {
  const data = await client.readRoom(room, { limit, format: 'json' }).catch(() => null);
  const messages = data?.messages || [];
  return messages.filter((m) => JSON.stringify(m).includes(identity.did));
}

const posted = await client.postSignedMessage(REGISTRATION_ROOM, frame, identity)
  .catch((err) => fail(`post failed: ${err.message}`));
console.log(`[sonnet2] posted, seq ${posted?.seq ?? '(unreported)'}`);

await new Promise((resolve) => setTimeout(resolve, 20_000));

for (const room of [REGISTRATION_ROOM, RESULTS_ROOM]) {
  const hits = await findOurRecords(room);
  console.log(`[sonnet2] /r/${room}: ${hits.length} record(s) naming our DID in the newest 200`);
  for (const hit of hits) console.log(`  seq ${hit.seq} ${hit.ts} ${String(hit.text).slice(0, 220)}`);
}

console.log('[sonnet2] done. A receipt may still be queued; re-read the rooms rather than re-posting.');
