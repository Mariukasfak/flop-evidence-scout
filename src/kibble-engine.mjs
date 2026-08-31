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
  reconstructBoard, pickJob, pickThinDelivery,
  claimLine, resultLine, attestNotLine
} from './kibble.mjs';

/** How many refused job ids to remember, so a bad answer is not regenerated forever. */
const MAX_REMEMBERED = 200;

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
      refusedJobIds: []
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

    const skipJobIds = new Set(this.localState.refusedJobIds || []);
    const job = pickJob(jobs, { selfDid: this.workerIdentity.did, skipJobIds });
    if (!job) return { action: 'no_job' };

    if (!real) {
      return { action: 'skipped_no_real_model', jobId: job.jobId };
    }

    // Cheap pacing check before spending a real inference session on it.
    const paced = this.workerGuardrails.canSendMessage(`kibble-probe-${job.jobId}`);
    if (!paced.allowed) return { action: `paced: ${paced.reason}`, jobId: job.jobId };

    const task = buildTask('kibble-answer', { category: job.category, title: job.title, body: job.body });
    const { receipt, completion } = await runSession(task, { backend, identity: this.workerIdentity });
    try { appendReceipt(receipt, ledgerPath); } catch { /* a ledger write must never lose the run */ }

    const answer = String(completion || '').trim();
    if (!answer || !task.validate(answer)) {
      this.localState.refusedJobIds = [...skipJobIds, job.jobId].slice(-MAX_REMEMBERED);
      await this.saveRemoteState();
      return { action: 'refused', jobId: job.jobId, reason: answer ? 'failed validator' : 'empty completion' };
    }

    const withCard = `${answer}\n\n(verified worker: ${didCardUrl(this.client, this.workerIdentity)})`;
    const line = resultLine(job.jobId, withCard);

    // The real gate — content safety, length, dedup — against the actual line.
    const finalCheck = this.workerGuardrails.canSendMessage(line);
    if (!finalCheck.allowed) return { action: `blocked: ${finalCheck.reason}`, jobId: job.jobId };

    try {
      await this.client.postMessage(this.room, claimLine(job.jobId), this.workerIdentity);
      await this.client.postMessage(this.room, line, this.workerIdentity);
    } catch (err) {
      sayOnce('kibble:worker-post', `[Kibble] Worker post failed: ${err.message}`);
      return { action: 'post_failed', jobId: job.jobId, error: err.message };
    }

    this.workerGuardrails.recordSent(line);
    this.localState.resultsDelivered += 1;
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
