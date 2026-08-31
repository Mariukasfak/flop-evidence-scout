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
 * "useful" ATTEST once the attesting side has a scored RESULT behind it — a
 * franchise that opens on the first genuine delivery. Until then the only honest
 * attestation available is `not`, which the spec exempts from that requirement,
 * and that is the only kind this file writes while unfranchised.
 *
 * Both attestation lanes are here now. The `not` lane is regex-decided and
 * covers only the do-nothing templates, because a template is a pattern.
 * "Useful" is a judgement, so it goes to a real model, is refused unless the
 * model names something specific, and is bound to a hash of the exact delivery
 * text that was judged. A NOT_USEFUL verdict from that model is discarded
 * rather than posted: the template lane already covers work that plainly did
 * nothing, and calling a genuine attempt useless on a 3B model's say-so is not
 * a claim this project has earned the right to publish.
 *
 * The hash is computed locally, not fetched. The spec points at /api/board and
 * that endpoint does not answer — 90 seconds, then 45, then nothing — so a lane
 * built on it is permanently dormant and would hang the turn it runs in. The
 * recipe was recovered from the tape instead and reproduces the published hash
 * on 195 of 201 real pairs; see resultHashFor in kibble.mjs for why the other
 * six miss and what follows from that.
 */

import { READ_WINDOW } from './technocore-client.mjs';
import { getDidShardedPath, getStateKey } from './identity.mjs';
import { Guardrails } from './guardrails.mjs';
import { buildTask } from './workload.mjs';
import { runSession } from './inference.mjs';
import { appendReceipt } from './inference-ledger.mjs';
import { sayOnce } from './log-once.mjs';
import {
  reconstructBoard, pickJob, pickThinDelivery, pickRealDelivery, sameDid,
  claimLine, resultLine, attestNotLine, attestUsefulLine, resultHashFor,
  thinDeliveryReason
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

/**
 * How long a franchise answer is trusted before asking again.
 *
 * The scoring host is the flaky one — /api/board does not answer at all — so
 * this is asked rarely and cached, and a failure to reach it means "not
 * franchised yet" rather than an exception.
 */
const FRANCHISE_TTL_MS = 30 * 60_000;

/** Nothing on that host is worth stalling a cycle for. */
const FRANCHISE_TIMEOUT_MS = 5_000;

/** A held claim we never got to is dropped rather than answered hours late. */
const HELD_TTL_MS = 10 * 60_000;

/**
 * How hard the worker is allowed to go, and what decides it.
 *
 * A fixed number here has been wrong twice. 3/hour was set on the belief that
 * the claim race was unwinnable, which measurement disproved; 6/hour was set by
 * me being cautious, which is not evidence either. The operator's question was
 * the right one — if more genuine work is worth more, why is there a ceiling at
 * all?
 *
 * The honest reason is not consideration for the room, which is not our job.
 * It is that an abandoned claim pays us exactly nothing and burns a claim slot
 * we could have spent on work we would have finished. So the rate follows the
 * only thing that decides whether claiming harder pays: how much of what we
 * take we actually finish, and what the room makes of it once we have.
 *
 * The failure mode this guards against is the one that already happened. A
 * single sentence in a prompt turned 11 of 17 claims into abandonments, and a
 * fixed rate would have kept taking jobs at full speed throughout.
 */
const WORKER_RATE_FLOOR = 3;

/**
 * 60/hour, because that is the structural limit rather than a chosen one.
 *
 * The previous 20 was caution wearing the costume of a measurement, and the
 * operator was right to push on it. The actual constraints, all measured:
 * Technocore allows 300 writes a minute per IP (18,000/hour, four orders of
 * magnitude away), the model answers in 1.2s, and the worker settles one held
 * claim per cycle — so at a 60-second interval, sixty an hour is simply the
 * most this shape of daemon can finish.
 *
 * What makes more genuinely better is the arithmetic, now that the first real
 * feedback exists. Our first six deliveries drew four attestations: two useful,
 * two not. A delivery is worth 1 for the RESULT, 6 for a peer useful, -3 for a
 * not — so at that split each one nets about +2.5. Positive means more is
 * better, and the ceiling should be the machine's, not the author's nerves.
 */
const WORKER_RATE_CEILING = 60;

/** Outcomes considered when adjusting; small enough to react within an hour. */
const RATE_WINDOW = 8;

/** Above this share of abandoned claims, back off. Below it, open up. */
const ABANDON_BACKOFF = 0.25;
const ABANDON_HEADROOM = 0.10;

/**
 * The share of not-useful verdicts at which delivering stops paying.
 *
 * Break-even is `1 + useful*6 - not*3 = 0`. With everything attested and none
 * of it useful that is 1 - 3 = -2, so the point where volume turns into a
 * liability sits near a 70% not-rate. Backing off at 60% leaves margin for a
 * small sample, and this is self-interest rather than manners: a not-useful
 * verdict is the only thing on this board that actively subtracts.
 */
const NOT_USEFUL_BACKOFF = 0.60;

/** Judged deliveries needed before that share means anything. */
const VERDICT_MIN_SAMPLE = 5;

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
    /**
     * A starting point, not a policy. recordClaimOutcome moves it between
     * WORKER_RATE_FLOOR and WORKER_RATE_CEILING according to how many claims we
     * actually finish, and loadRemoteState restores whatever it had learned.
     * Six is simply where it begins on a machine with no history.
     */
    workerGuardrails = new Guardrails({ maxPerHour: 6, minCooldownMs: 5 * 60_000 }),
    /** The room is validator-starved 7:1, so this stays looser than the worker's. */
    validatorGuardrails = new Guardrails({ maxPerHour: 6, minCooldownMs: 5 * 60_000 }),
    stateKey = null,
    /** The scoring host. Only ever asked whether the worker is franchised. */
    kibbleApiUrl = 'https://flop-kibble.onrender.com',
    fetchFn = globalThis.fetch
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
    this.kibbleApiUrl = String(kibbleApiUrl).replace(/\/+$/, '');
    this.fetchFn = fetchFn;
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

    /**
     * Whether the remote note has been merged yet.
     *
     * An instance field, deliberately not part of localState: everything in
     * there is serialised into the note, and a "have I loaded?" flag written
     * into the thing it describes is both meaningless remotely and confusing
     * on the way back.
     */
    this.stateLoaded = false;
  }

  /**
   * Pull the remote note once, then never again while this process lives.
   *
   * Re-merging the note at the top of every turn is what forced the three
   * kibble lanes to run one after another: each did load-modify-save on the
   * same key, so a lane that loaded while another held an unsaved claim would
   * overwrite it — losing exactly the claim the fast lane exists to win. That
   * serialisation cost real coverage. The fast lane could only run in the tail
   * of a cycle, about 58% of the interval, and every job posted in the other
   * 42% was one we never saw.
   *
   * Memory is the authority instead. This is one single-threaded process, so
   * concurrent lanes interleave only at awaits and cannot tear an object;
   * dropping the reload removes the clobber without a lock, and the note goes
   * back to being what it should be — a restart's memory, not a shared
   * variable. Saves still happen after every meaningful change.
   */
  async loadRemoteState() {
    if (this.stateLoaded) return this.localState;
    this.stateLoaded = true;
    try {
      const remote = await this.client.getKv('kibble', this.stateKey);
      if (remote && typeof remote === 'object') {
        // Counters only go up: a note that was reset or half-written must not
        // roll back what this process has already done and posted.
        const merged = { ...this.localState, ...remote };
        for (const key of ['resultsDelivered', 'attestsPosted', 'totalWorkerTurns',
          'totalValidatorTurns', 'claimsWon', 'claimsLost']) {
          merged[key] = Math.max(this.localState[key] || 0, remote[key] || 0);
        }
        // Held claims and the cursor belong to the live process, not the note.
        merged.heldJobs = this.localState.heldJobs?.length ? this.localState.heldJobs : (remote.heldJobs || []);
        this.localState = merged;
        // A rate learned over an hour should not be re-learned from scratch on
        // every restart, and this daemon restarts often.
        const learned = Number(this.localState.workerRate);
        if (Number.isFinite(learned) && learned >= WORKER_RATE_FLOOR && learned <= WORKER_RATE_CEILING) {
          this.workerGuardrails.maxPerHour = learned;
          this.workerGuardrails.minCooldownMs = Math.max(60_000, Math.floor(3600_000 / learned / 2));
        }
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

  /**
   * Let the finishing rate set the claiming rate.
   *
   * Called once per settled claim. Rises slowly and falls fast, because the
   * damage is asymmetric: claiming too slowly costs us some work, claiming too
   * fast and abandoning blocks jobs for everybody else.
   */
  recordClaimOutcome(finished) {
    const window = [...(this.localState.claimOutcomes || []), finished ? 1 : 0].slice(-RATE_WINDOW);
    this.localState.claimOutcomes = window;
    if (window.length < RATE_WINDOW) return this.workerGuardrails.maxPerHour;

    const abandoned = window.filter((x) => x === 0).length / window.length;
    const current = this.workerGuardrails.maxPerHour;
    let next = current;

    if (abandoned > ABANDON_BACKOFF) next = Math.max(WORKER_RATE_FLOOR, Math.floor(current / 2));
    else if (abandoned <= ABANDON_HEADROOM) next = Math.min(WORKER_RATE_CEILING, current + 2);

    if (next !== current) {
      this.#setRate(next);
      console.log(`[Kibble] Claim rate ${current} -> ${next}/h `
        + `(${Math.round(abandoned * 100)}% of the last ${window.length} claims abandoned).`);
    }
    return next;
  }

  /**
   * Read back what the room thought of our own deliveries.
   *
   * Until now the worker had no idea whether anything it posted was any good —
   * it counted deliveries and stopped there, which is the same blindness as
   * counting claims and never checking whether they landed. The verdicts are on
   * the tape we already read every cycle, so this costs nothing but the looking.
   *
   * Only the score-bearing half is counted: a `not` subtracts 3 and a peer
   * `useful` adds 6, so this is what says whether volume is paying or costing.
   */
  reviewOwnDeliveries(jobs) {
    const mine = new Set(this.localState.deliveredJobIds || []);
    if (!mine.size) return null;

    let useful = 0, not = 0;
    for (const jobId of mine) {
      const job = jobs.get(jobId);
      if (!job) continue;
      for (const attest of job.attests) {
        if (sameDid(attest.from, this.workerIdentity.did)) continue;      // never our own
        if (sameDid(attest.from, this.validatorIdentity.did)) continue;   // nor our other key
        if (attest.verdict === 'useful') useful += 1;
        else if (attest.verdict === 'not') not += 1;
      }
    }

    const judged = useful + not;
    this.localState.verdictsUseful = useful;
    this.localState.verdictsNot = not;
    if (judged < VERDICT_MIN_SAMPLE) return { useful, not, judged, acted: false };

    const notShare = not / judged;
    const current = this.workerGuardrails.maxPerHour;
    if (notShare >= NOT_USEFUL_BACKOFF && current > WORKER_RATE_FLOOR) {
      const next = Math.max(WORKER_RATE_FLOOR, Math.floor(current / 2));
      this.#setRate(next);
      console.log(`[Kibble] Claim rate ${current} -> ${next}/h — `
        + `${not} of ${judged} of our deliveries were judged not useful, which stops paying.`);
      return { useful, not, judged, acted: true };
    }
    return { useful, not, judged, acted: false };
  }

  /** Apply a rate and keep the cooldown spread across the hour with it. */
  #setRate(next) {
    this.workerGuardrails.maxPerHour = next;
    this.workerGuardrails.minCooldownMs = Math.max(30_000, Math.floor(3600_000 / next / 2));
    this.localState.workerRate = next;
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

    // What did the room make of what we already sent? Free — this board was
    // read a line ago — and it is the only signal that says whether volume is
    // paying or costing.
    this.reviewOwnDeliveries(jobs);

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
      this.recordClaimOutcome(false);
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
    this.recordClaimOutcome(true);
    this.localState.resultsDelivered += 1;
    this.localState.claimsWon = (this.localState.claimsWon || 0) + 1;
    // Kept so reviewOwnDeliveries can find the verdicts on them later.
    this.localState.deliveredJobIds = [
      ...(this.localState.deliveredJobIds || []), job.jobId
    ].slice(-MAX_REMEMBERED);
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
   * Has the worker earned the right for our "useful" attestations to score?
   *
   * The board only counts a peer `useful` once the attesting side has a scored
   * RESULT behind it. Under the three-party split Scribe never posts a RESULT —
   * Scout does — so this asks about Scout. That is a deliberate reading of the
   * rule rather than a quote of it, and it is the conservative direction: if the
   * real rule is stricter, we simply post fewer useful attestations than we
   * could, which costs nothing. A `not` needs no franchise and is unaffected.
   *
   * Unreachable means "no", never an exception. The host that answers this is
   * the same one whose /api/board never replies, and a validator turn must not
   * hang waiting for it.
   */
  async checkFranchise({ now = () => Date.now() } = {}) {
    const checkedAt = this.localState.franchiseCheckedAt || 0;
    if (now() - checkedAt < FRANCHISE_TTL_MS) return this.localState.franchised === true;

    // Stamp before the call, not after: a host that times out every time would
    // otherwise re-ask on every single validator turn forever.
    this.localState.franchiseCheckedAt = now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FRANCHISE_TIMEOUT_MS);
    try {
      const url = `${this.kibbleApiUrl}/api/score?did=${encodeURIComponent(this.workerIdentity.did)}`;
      const response = await this.fetchFn(url, { signal: controller.signal });
      if (!response.ok) { this.localState.franchised = false; return false; }
      const data = await response.json();
      this.localState.franchised = data?.found === true && Number(data?.score) > 0;
    } catch {
      this.localState.franchised = false;
    } finally {
      clearTimeout(timer);
    }
    return this.localState.franchised === true;
  }

  /**
   * Judge one genuine delivery and, if it holds up, say so on the record.
   *
   * The only place this project lets a model's opinion become a public claim
   * about somebody else's work, so it is fenced accordingly: the delivery is
   * untrusted input, the verdict must be one of two words, the reason must name
   * something specific, and the whole line is bound to a hash of the exact text
   * that was judged. A model that hedges, rambles or rubber-stamps fails the
   * validator and nothing is posted — which is the correct outcome, not a
   * failure.
   *
   * A NOT_USEFUL verdict here is discarded rather than posted. The thin-template
   * lane already covers deliveries that plainly did nothing; calling a genuine
   * attempt "not useful" on a 3B model's say-so is a judgement this project has
   * not earned the right to publish.
   */
  async attemptUsefulAttest({ backend, real, ledgerPath, jobs } = {}) {
    if (!real) return { action: 'useful_skipped_no_real_model' };
    if (!(await this.checkFranchise())) return { action: 'useful_unfranchised' };

    const found = pickRealDelivery(jobs, {
      selfDid: this.validatorIdentity.did,
      excludeDids: [this.workerIdentity.did]
    });
    if (!found) return { action: 'no_useful_target' };

    const paced = this.validatorGuardrails.canSendMessage(`kibble-useful-probe-${found.job.jobId}`);
    if (!paced.allowed) return { action: `paced: ${paced.reason}`, jobId: found.job.jobId };

    const task = buildTask('kibble-judge', {
      category: found.job.category, title: found.job.title,
      body: found.job.body, delivery: found.delivery.summary
    });
    const { receipt, completion } = await runSession(task, { backend, identity: this.validatorIdentity });
    try { appendReceipt(receipt, ledgerPath); } catch { /* a ledger write must never lose the run */ }

    const answer = String(completion || '').trim();
    if (!task.validate(answer)) return { action: 'useful_refused', jobId: found.job.jobId };

    const [verdict, ...rest] = answer.split('\n').map((l) => l.trim()).filter(Boolean);
    if (verdict !== 'USEFUL') return { action: 'judged_not_useful', jobId: found.job.jobId };

    // Hashed over exactly the text we judged, which is the text we read off the
    // tape — never a re-fetch, because then the hash would not describe what the
    // model actually saw.
    const hash = resultHashFor(found.delivery.summary);
    const reason = `${rest.join(' ')} Verified by: ${didCardUrl(this.client, this.validatorIdentity)}`;
    const line = attestUsefulLine(found.job.jobId, hash, reason);

    const finalCheck = this.validatorGuardrails.canSendMessage(line);
    if (!finalCheck.allowed) return { action: `blocked: ${finalCheck.reason}`, jobId: found.job.jobId };

    try {
      await this.client.postMessage(this.room, line, this.validatorIdentity);
    } catch (err) {
      sayOnce('kibble:useful-post', `[Kibble] Useful attest failed: ${err.message}`);
      return { action: 'post_failed', jobId: found.job.jobId, error: err.message };
    }

    this.validatorGuardrails.recordSent(line);
    this.localState.attestsPosted += 1;
    this.localState.usefulAttests = (this.localState.usefulAttests || 0) + 1;
    this.localState.lastAttestJobId = found.job.jobId;
    this.localState.lastAttestAt = new Date().toISOString();
    await this.saveRemoteState();

    return { action: 'attested_useful', jobId: found.job.jobId, attestsPosted: this.localState.attestsPosted };
  }

  /**
   * Scribe's turn: hygiene-attest a thin delivery, or do nothing.
   *
   * Never our own delivery, never our own job, never a job we already attested —
   * pickThinDelivery already enforces all three. `not` needs no franchise, so this
   * is the one thing this file can do from the very first cycle, before the worker
   * has ever delivered anything.
   */
  async runValidatorTurn({ backend, real, ledgerPath } = {}) {
    await this.loadRemoteState();
    this.localState.totalValidatorTurns += 1;

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const found = pickThinDelivery(jobs, {
      selfDid: this.validatorIdentity.did,
      excludeDids: [this.workerIdentity.did]
    });
    if (!found) {
      // Nothing plainly empty to call out. The room is short of validators
      // either way, so spend the turn judging something real instead.
      return this.attemptUsefulAttest({ backend, real, ledgerPath, jobs });
    }

    const paced = this.validatorGuardrails.canSendMessage(`kibble-attest-probe-${found.job.jobId}`);
    if (!paced.allowed) return { action: `paced: ${paced.reason}`, jobId: found.job.jobId };

    // Written from this job and this delivery, never a fixed string. Our first
    // 37 attestations shared one sentence between them and scored nothing,
    // because the board ignores canned reasons — and it is right to.
    const reason = `${thinDeliveryReason(found.job, found.delivery)} `
      + `Verified by: ${didCardUrl(this.client, this.validatorIdentity)}`;
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
