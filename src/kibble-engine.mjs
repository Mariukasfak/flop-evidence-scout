/**
 * The daemon-facing half of kibble.mjs: actually posting, not just deciding what to post.
 *
 * kibble.mjs and tools/kibble-preview.mjs already answer "what would we do?" — this
 * answers "who does it, how often, and what happens after". Two identities, two jobs,
 * on purpose: the spec requires poster, worker and validator to be three different
 * parties, so the same DID can never claim a job and then judge one. Scout works,
 * Scribe validates.
 *
 * Bootstrapping matters here specifically: the board's own scorer only counts a
 * "useful" ATTEST once the attesting DID has at least one RESULT of its own — a
 * franchise that opens on the first genuine delivery. Until then the only honest
 * attestation available is `not`, which the spec exempts from that requirement, so
 * that is the only kind this file ever writes. A "useful" ATTEST needs a result hash
 * bound to a delivery we actually read, and never our own — that is real work,
 * deliberately left undone rather than half-done.
 */

import { READ_WINDOW } from './technocore-client.mjs';
import { getDidShardedPath, getStateKey } from './identity.mjs';
import { Guardrails } from './guardrails.mjs';
import { buildTask } from './workload.mjs';
import { runSession } from './inference.mjs';
import { appendReceipt } from './inference-ledger.mjs';
import { sayOnce } from './log-once.mjs';
import {
  reconstructBoard, pickJob, pickThinDelivery, sameDid,
  claimLine, resultLine, attestNotLine
} from './kibble.mjs';

/** How many refused job ids to remember, so a bad answer is not regenerated forever. */
const MAX_REMEMBERED = 200;

/**
 * Claims we hold but have not yet answered.
 *
 * Small on purpose. A claim we do not deliver on is the debris this file was
 * originally written to avoid, and holding a queue of them would turn a race we
 * are trying to win honestly into hoarding.
 */
const MAX_HELD = 2;

/** A held claim we never got to is dropped rather than answered hours late. */
const HELD_TTL_MS = 10 * 60_000;

/**
 * The URL a reader can click straight from the public tape to the DID note that
 * proves who posted a line — the same note publishDidProfile() writes, turning an
 * opaque did:key into "Addressable, not just audible" the way the rest of this
 * project already is. Built from the client's own baseUrl rather than a literal, so
 * a test server or a future endpoint gets a URL that actually resolves.
 */
export function didCardUrl(client, identity) {
  return `${client.baseUrl}${getDidShardedPath(identity.did).fullPath}`;
}

export class KibbleEngine {
  constructor({
    workerIdentity,
    validatorIdentity,
    client,
    room = 'kibble',
    /** Sparingly, by design: the claim race is lost before a cycle can even enter it (see kibble.mjs), so the only thing rate-limiting buys is not hammering a board we cannot win a race on anyway. */
    workerGuardrails = new Guardrails({ maxPerHour: 3, minCooldownMs: 15 * 60_000 }),
    /** The room is validator-starved 7:1, so this stays looser than the worker's. */
    validatorGuardrails = new Guardrails({ maxPerHour: 6, minCooldownMs: 5 * 60_000 }),
    stateKey = null
  }) {
    if (!workerIdentity?.did || !workerIdentity?.privateKeyPem) {
      throw new Error('Valid Ed25519 workerIdentity is required for KibbleEngine');
    }
    if (!validatorIdentity?.did || !validatorIdentity?.privateKeyPem) {
      throw new Error('Valid Ed25519 validatorIdentity is required for KibbleEngine');
    }
    if (!client) {
      throw new Error('Technocore client is required for KibbleEngine');
    }

    this.workerIdentity = workerIdentity;
    this.validatorIdentity = validatorIdentity;
    this.client = client;
    this.room = room;
    this.workerGuardrails = workerGuardrails;
    this.validatorGuardrails = validatorGuardrails;
    this.stateKey = stateKey || getStateKey(workerIdentity.did, 'kibble');
    this.localState = {
      totalWorkerTurns: 0,
      totalValidatorTurns: 0,
      resultsDelivered: 0,
      attestsPosted: 0,
      lastResultJobId: null,
      lastResultAt: null,
      lastAttestJobId: null,
      lastAttestAt: null,
      // Jobs whose answer we generated and the validator refused. Remembered so a
      // job that will never pass is not re-answered — and re-billed to a real
      // model — every single cycle it stays open.
      refusedJobIds: [],
      // Jobs we have claimed and still owe an answer on. See runFastLane.
      heldJobs: [],
      // Where the fast lane's long-poll got to, so it resumes instead of
      // re-reading a window it has already judged.
      cursor: null,
      claimsWon: 0,
      claimsLost: 0
    };
    this.lastStateError = null;
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('kibble', this.stateKey);
      if (remote && typeof remote === 'object') {
        this.localState = { ...this.localState, ...remote };
      }
    } catch (err) {
      this.lastStateError = err.message;
    }
    return this.localState;
  }

  async saveRemoteState() {
    try {
      await this.client.setKv('kibble', this.stateKey, this.localState);
      this.lastStateError = null;
      return true;
    } catch (err) {
      this.lastStateError = err.message;
      sayOnce('kibble:state-write', `[Kibble] /kv/ state write failed: ${err.message}`);
      return false;
    }
  }

  async readBoard() {
    const { messages } = await this.client.readRoom(this.room, { limit: READ_WINDOW });
    return reconstructBoard(messages);
  }

  /**
   * Claim first, think second.
   *
   * The original order here was read the board, generate an answer, then claim —
   * chosen so a claim always had a delivery behind it. Measured against the live
   * tape, that order lost every single time: three deliveries, three jobs
   * claimed by somebody else 3-4 messages before us, all three dropped by the
   * board as non-claimant RESULTs. Real work from a real model, scored zero.
   *
   * The cause was not the competition. Jobs are claimed a median 1.0s after they
   * are posted, and generating an honest answer takes five to thirty seconds, so
   * a design that thinks before claiming is late by construction — it cannot win
   * even against a slow opponent.
   *
   * So the lanes are split. This one holds a long poll open and claims the
   * instant an unclaimed job lands, which costs one request and no inference.
   * runWorkerTurn then answers what we hold, and checks first that we actually
   * won before spending a session on it. The cost is that a claim we cannot
   * answer becomes debris; MAX_HELD and the guardrails bound how much, and an
   * abandoned claim scores nothing either way, while a late RESULT wastes a real
   * model run every time.
   */
  async runFastLane({ maxMs = 20_000, now = () => Date.now() } = {}) {
    await this.loadRemoteState();
    const deadline = now() + maxMs;
    let claimed = 0;

    // Start at the live end of the room. Without this the first poll replays the
    // last 200 messages, whose jobs are all long since taken.
    if (this.localState.cursor == null) {
      try {
        const { messages } = await this.client.readRoom(this.room, { limit: 1 });
        this.localState.cursor = messages.at(-1)?.seq ?? null;
      } catch (err) {
        return { action: 'read_failed', error: err.message, claimed };
      }
    }

    this.#expireHeldJobs(now);

    while (now() < deadline && (this.localState.heldJobs || []).length < MAX_HELD) {
      const remainingMs = deadline - now();
      // wait= is clamped to 10 and only works with since=; asking for less than a
      // second just spins.
      const wait = Math.min(10, Math.floor(remainingMs / 1000));
      if (wait < 1) break;

      let messages;
      const askedAt = now();
      try {
        ({ messages } = await this.client.readRoom(this.room, {
          since: this.localState.cursor, wait, limit: READ_WINDOW
        }));
      } catch (err) {
        await this.saveRemoteState();
        return { action: 'read_failed', error: err.message, claimed };
      }

      // An empty reply after the full wait is normal — re-issue with the same
      // cursor, exactly as the protocol document says to.
      //
      // But the server holds only a bounded number of waiters and answers
      // immediately once that cap is hit. Re-issuing on an empty reply that came
      // back instantly is then a tight loop against a room doing a thousand
      // messages a minute — the protocol document says to sleep roughly the wait
      // you asked for when that happens, and this is that sleep.
      if (!messages.length) {
        const heldFor = now() - askedAt;
        if (heldFor < wait * 500) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(wait * 1000, deadline - now())));
        }
        continue;
      }
      this.localState.cursor = messages.at(-1).seq;

      const skipJobIds = new Set([
        ...(this.localState.refusedJobIds || []),
        ...(this.localState.heldJobs || []).map((h) => h.jobId)
      ]);
      const job = pickJob(reconstructBoard(messages), {
        selfDid: this.workerIdentity.did, skipJobIds
      });
      if (!job) continue;

      const paced = this.workerGuardrails.canSendMessage(`kibble-claim-${job.jobId}`);
      if (!paced.allowed) break;

      const line = claimLine(job.jobId);
      try {
        await this.client.postMessage(this.room, line, this.workerIdentity);
      } catch (err) {
        sayOnce('kibble:claim-post', `[Kibble] Claim failed: ${err.message}`);
        break;
      }

      this.localState.heldJobs = [
        ...(this.localState.heldJobs || []),
        { jobId: job.jobId, category: job.category, title: job.title, body: job.body, claimedAt: now() }
      ];
      claimed += 1;
    }

    await this.saveRemoteState();
    return { action: claimed ? 'claimed' : 'nothing_to_claim', claimed, held: (this.localState.heldJobs || []).length };
  }

  /** Forget claims too old to answer honestly. */
  #expireHeldJobs(now = () => Date.now()) {
    const cutoff = now() - HELD_TTL_MS;
    const held = this.localState.heldJobs || [];
    this.localState.heldJobs = held.filter((h) => (h.claimedAt ?? 0) > cutoff);
  }

  /**
   * Did we actually get there first?
   *
   * The board ignores competing CLAIMs and any RESULT from a non-first claimant,
   * so a session spent answering a job we lost is a session spent on a line that
   * will be discarded. Checked before the model runs, never after.
   */
  #wonClaim(jobs, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.claims.length === 0) return null;   // not visible yet — decide later
    const first = [...job.claims].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
    return sameDid(first.from, this.workerIdentity.did);
  }

  /**
   * Scout's turn: answer one job, for real, or do nothing.
   *
   * `real` gates the whole thing — kibble.mjs is explicit that a real model never
   * templates, so a simulated backend is not a smaller version of this work, it is
   * not this work. Claiming happens only once a validated answer is already in
   * hand: a CLAIM with no RESULT behind it is exactly the debris the tape is full
   * of (17,129 open jobs, claimants who never came back), and this never adds to it.
   */
  async runWorkerTurn({ backend, real, ledgerPath } = {}) {
    await this.loadRemoteState();
    this.localState.totalWorkerTurns += 1;

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    // Only jobs we already hold a claim on. Picking a fresh one here is what
    // guaranteed we arrived second; runFastLane does the picking now.
    this.#expireHeldJobs();
    const held = this.localState.heldJobs || [];
    if (!held.length) return { action: 'no_job' };

    // Drop the ones we lost before spending anything on them.
    const kept = [];
    let lost = 0;
    for (const candidate of held) {
      const won = this.#wonClaim(jobs, candidate.jobId);
      if (won === false) { lost += 1; continue; }
      kept.push(candidate);
    }
    if (lost) {
      this.localState.claimsLost = (this.localState.claimsLost || 0) + lost;
      this.localState.heldJobs = kept;
      await this.saveRemoteState();
    }
    if (!kept.length) return { action: 'claims_lost', lost };

    const job = kept[0];

    if (!real) {
      return { action: 'skipped_no_real_model', jobId: job.jobId };
    }

    const task = buildTask('kibble-answer', { category: job.category, title: job.title, body: job.body });
    const { receipt, completion } = await runSession(task, { backend, identity: this.workerIdentity });
    try { appendReceipt(receipt, ledgerPath); } catch { /* a ledger write must never lose the run */ }

    const answer = String(completion || '').trim();
    const release = () => {
      this.localState.heldJobs = (this.localState.heldJobs || []).filter((h) => h.jobId !== job.jobId);
    };

    if (!answer || !task.validate(answer)) {
      // We hold a claim we cannot honestly answer. Let it go rather than post
      // something the board would rightly score at -3, and never pay for this
      // job's answer again.
      this.localState.refusedJobIds = [
        ...(this.localState.refusedJobIds || []), job.jobId
      ].slice(-MAX_REMEMBERED);
      release();
      await this.saveRemoteState();
      return { action: 'refused', jobId: job.jobId, reason: answer ? 'failed validator' : 'empty completion' };
    }

    const withCard = `${answer}\n\n(verified worker: ${didCardUrl(this.client, this.workerIdentity)})`;
    const line = resultLine(job.jobId, withCard);

    // The real gate — content safety, length, dedup — against the actual line.
    const finalCheck = this.workerGuardrails.canSendMessage(line);
    if (!finalCheck.allowed) return { action: `blocked: ${finalCheck.reason}`, jobId: job.jobId };

    // The CLAIM already went out in the fast lane; posting it again here would
    // be the competing claim we are trying not to file.
    try {
      await this.client.postMessage(this.room, line, this.workerIdentity);
    } catch (err) {
      sayOnce('kibble:worker-post', `[Kibble] Worker post failed: ${err.message}`);
      return { action: 'post_failed', jobId: job.jobId, error: err.message };
    }

    this.workerGuardrails.recordSent(line);
    release();
    this.localState.resultsDelivered += 1;
    this.localState.claimsWon = (this.localState.claimsWon || 0) + 1;
    this.localState.lastResultJobId = job.jobId;
    this.localState.lastResultAt = new Date().toISOString();
    await this.saveRemoteState();

    return {
      action: 'delivered',
      jobId: job.jobId,
      category: job.category,
      resultsDelivered: this.localState.resultsDelivered
    };
  }

  /**
   * Scribe's turn: hygiene-attest a thin delivery, or do nothing.
   *
   * Never our own delivery, never our own job, never a job we already attested —
   * pickThinDelivery already enforces all three. `not` needs no franchise, so this
   * is the one thing this file can do from the very first cycle, before the worker
   * has ever delivered anything.
   */
  async runValidatorTurn() {
    await this.loadRemoteState();
    this.localState.totalValidatorTurns += 1;

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const found = pickThinDelivery(jobs, { selfDid: this.validatorIdentity.did });
    if (!found) return { action: 'no_target' };

    const paced = this.validatorGuardrails.canSendMessage(`kibble-attest-probe-${found.job.jobId}`);
    if (!paced.allowed) return { action: `paced: ${paced.reason}`, jobId: found.job.jobId };

    const reason = 'The delivery is a status line restating the title and contains none of the '
      + 'specific content the job asked for, so nothing in it can be checked against the success '
      + `condition. Verified by: ${didCardUrl(this.client, this.validatorIdentity)}`;
    const line = attestNotLine(found.job.jobId, reason);

    const finalCheck = this.validatorGuardrails.canSendMessage(line);
    if (!finalCheck.allowed) return { action: `blocked: ${finalCheck.reason}`, jobId: found.job.jobId };

    try {
      await this.client.postMessage(this.room, line, this.validatorIdentity);
    } catch (err) {
      sayOnce('kibble:validator-post', `[Kibble] Validator post failed: ${err.message}`);
      return { action: 'post_failed', jobId: found.job.jobId, error: err.message };
    }

    this.validatorGuardrails.recordSent(line);
    this.localState.attestsPosted += 1;
    this.localState.lastAttestJobId = found.job.jobId;
    this.localState.lastAttestAt = new Date().toISOString();
    await this.saveRemoteState();

    return { action: 'attested_not', jobId: found.job.jobId, attestsPosted: this.localState.attestsPosted };
  }
}
