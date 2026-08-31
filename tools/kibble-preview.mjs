/**
 * Show exactly what the agent would post to the kibble board, and post nothing.
 *
 * The pattern this project uses for anything outward-facing: build it, prove it
 * against the live source, let the operator read the actual bytes, and only then
 * let it write. The X publisher has the same shape and for the same reason —
 * "it will post something sensible" is a claim, and a claim is worth less than
 * the line itself on screen.
 *
 * Run: npm run kibble-preview
 */

import { TechnocoreClient } from '../src/technocore-client.mjs';
import { loadOrCreateIdentity } from '../src/identity.mjs';
import { selectBackend } from '../src/inference-backends.mjs';
import { buildTask } from '../src/workload.mjs';
import { runSession } from '../src/inference.mjs';
import {
  reconstructBoard, pickJob, pickThinDelivery,
  claimLine, resultLine, attestNotLine
} from '../src/kibble.mjs';

const ROOM = 'kibble';

function line(char = '─') {
  console.log(char.repeat(74));
}

async function main() {
  // Read-only: this client is never handed a write. The daemon's own guard
  // (assertWritable) would refuse anyway, but not asking is better than being
  // refused.
  const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat', allowWrites: false });
  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');

  console.log('\nKibble board preview — nothing here is posted.\n');
  console.log(`Our DID: ${identity.did}`);

  line();
  console.log('Reading the tape…');
  const started = Date.now();
  const { messages } = await client.readRoom(ROOM, { limit: 200 });
  console.log(`  ${messages.length} messages in ${Date.now() - started} ms`);

  const jobs = reconstructBoard(messages);
  const known = [...jobs.values()].filter((j) => j.known);
  const delivered = [...jobs.values()].filter((j) => j.results.length > 0);
  console.log(`  ${jobs.size} job ids seen, ${known.length} with a readable JOB line, ${delivered.length} already delivered`);

  // ── what we would deliver ────────────────────────────────────────────────
  line();
  const job = pickJob(jobs, { selfDid: identity.did });
  if (!job) {
    console.log('No job in this window is worth claiming right now.');
    console.log('That is a normal outcome: jobs are claimed within seconds, and a');
    console.log('window with nothing free means the board is busy, not broken.');
  } else {
    console.log(`Would claim: ${job.jobId}  [${job.category}]`);
    console.log(`  title: ${job.title}`);
    console.log(`  body:  ${job.body.slice(0, 260)}${job.body.length > 260 ? '…' : ''}`);
    console.log(`  posted by: ${job.poster ?? 'unknown'}`);
    console.log('');
    console.log(`  LINE 1 → ${claimLine(job.jobId)}`);

    const { backend, real } = await selectBackend({});
    console.log('');
    console.log(`  Model: ${backend.id}${backend.model ? ` (${backend.model})` : ''}${real ? '' : ' — SIMULATED, not a real answer'}`);

    const task = buildTask('kibble-answer', {
      category: job.category, title: job.title, body: job.body
    });
    const session = await runSession(task, { backend, identity });
    const answer = (session.completion ?? session.receipt?.completion ?? '').trim();

    if (!answer) {
      console.log('  The model returned nothing. Nothing would be delivered.');
    } else if (!task.validate(answer)) {
      console.log('  Answer REFUSED by the validator — nothing would be delivered.');
      console.log(`  (it said: ${answer.slice(0, 200)}…)`);
      console.log('  Not delivering is free. Delivering slop costs -3 on the board.');
    } else {
      console.log('');
      console.log(`  LINE 2 → ${resultLine(job.jobId, answer)}`);
    }
  }

  // ── what we would attest ─────────────────────────────────────────────────
  line();
  const thin = pickThinDelivery(jobs, { selfDid: identity.did });
  if (!thin) {
    console.log('No delivery in this window matches a known do-nothing template.');
  } else {
    console.log(`Would attest against: ${thin.job.jobId}`);
    console.log(`  their delivery: ${thin.delivery.summary.slice(0, 200)}`);
    console.log('');
    const reason = 'The delivery is a status line restating the title and contains none of '
      + 'the specific content the job asked for, so nothing in it can be checked against '
      + 'the success condition.';
    console.log(`  LINE  → ${attestNotLine(thin.job.jobId, reason)}`);
  }

  line();
  console.log('Nothing above was sent. To let the agent do this for real, see');
  console.log('PROJEKTAS.md — the switch is KIBBLE_WRITES and it is off by default.\n');
}

main().catch((err) => {
  console.error('Preview failed:', err.message);
  process.exit(1);
});
