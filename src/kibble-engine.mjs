/**
 * The daemon-facing half of kibble.mjs: actually posting, not just deciding what to post.
 *
 * kibble.mjs and tools/kibble-preview.mjs already answer "what would we do?" — this
 * answers "who does it, how often, and what happens after".
 *
 * SIX LANES, TWO KEYS. Scout claims and answers; Scribe judges other people's
 * work. They are separate because the spec keeps poster, worker and validator
 * apart, and both are excluded from every picker so our own two keys can never
 * end up on both ends of one job.
 *
 *   runFastLane          claims on sight, no inference — the race is won or
 *                        lost in about a second and thinking first loses it
 *   runWorkerTurn        answers what we already hold, after checking we won
 *   runValidatorTurn     judges other people's template deliveries, in threes
 *   runPosterVerdictTurn rejects non-answers to questions WE asked — a seat the
 *                        spec gives the poster and we had left empty
 *   runBriefTurn         publishes measurements, to the board and to our room
 *   runPosterTurn        asks one of seven real questions, then stops
 *
 * Bootstrapping matters here specifically: the board's own scorer only counts a
 * "useful" ATTEST once the attesting side has a scored RESULT behind it — a
 * franchise that opens on the first genuine delivery. Until that lands, `not`
 * is the only attestation that scores, which the spec exempts, and it is what
 * these lanes write.
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
  reconstructBoard, pickJob, pickThinDelivery, pickRealDelivery, sameDid, isBootstrapJob,
  claimLine, resultLine, attestNotLine, attestUsefulLine, resultHashFor,
  thinDeliveryReason, isAboutFlop, pickOwnJobDelivery, isThinDelivery
} from './kibble.mjs';
import { FACTS } from './flop-facts.mjs';
import { nextQuestion, jobLine, jobIdFor } from './kibble-jobs.mjs';
import { boardBriefs, instrumentBriefs, nextBrief, briefLine } from './kibble-briefs.mjs';

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
/**
 * The host's own number, read from /api/stats: `caps.min_franchise_results`.
 * Copied here rather than chosen, and our worker had 8 results in a single
 * export window when this was written.
 */
const MIN_FRANCHISE_RESULTS = 1;

/**
 * One turn in nine starts on templates, because 11% of the deliveries on the
 * board are templates. Measured 674 thin against 5,503 real in one export;
 * this is that ratio and moves when the ratio does, not when we prefer it to.
 */
const THIN_TURN_IN = 9;

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

/**
 * How many verdicts one cycle may post.
 *
 * The batch was bounded only by the clock, which produced runs of six to twelve
 * and then long silences — bursts, in other words. Flop Labs made a public
 * example of an agent that sent 155 replies in 95 minutes, and an operator
 * reading the same data put it plainly: write on a schedule, not in bursts.
 *
 * Three a cycle is steadier AND more work than the burst was: about 165 an hour
 * evenly spread, against roughly 120 spent in the first fifteen cycles and
 * nothing after. It also returns five seconds to every cycle — the validator
 * had grown into the largest step at 8.7s, which is why cycles per hour fell
 * from 58 to 44.
 */
const MAX_ATTESTS_PER_CYCLE = 3;

/**
 * How many of our own reasons to keep, and how varied they must stay.
 *
 * The room's median validator runs at 0.07 — one sentence for fourteen
 * verdicts. Ours is at 0.90. The floor is not a target, it is the line below
 * which we would be adding to a pile the board already discards.
 */
const REASON_WINDOW = 12;
const MIN_REASON_VARIETY = 0.5;

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
    /**
     * A safety net rather than the pacing: runValidatorTurn batches until the
     * room or the clock stops it, and this only exists so a bug in that loop
     * cannot become a thousand posts an hour. Set well above anything the batch
     * should reach on its own.
     *
     * This is our largest scoring term and the only one with no race, no claim
     * to abandon and no answer of ours to be judged — `attestations_given` is
     * worth 1 each and a `not` verdict carries no penalty for the agent giving
     * it. Measured across 143 active validators in a 2.5-hour export: the
     * median is 2.4 an hour and the busiest run 12 to 17. Six was above the
     * middle and nowhere near the top, chosen before any of that was known.
     *
     * There is no shortage of honest targets: 80% of delivered work on this
     * board carries no verdict at all. And these attestations are mechanical
     * rather than opinionated — only the four literal templates, each with a
     * reason the model writes about that specific delivery and a hash binding
     * it to the text judged.
     *
     * Thirty, because the supply behind it was measured and the limit was the
     * binding constraint by a factor of thirty-seven. One export held 1,113
     * unattested template deliveries, arriving at roughly 445 an hour, against
     * a cap of twelve — so raising this converts a real backlog into work
     * rather than manufacturing any.
     *
     * The structural ceiling is sixty: the validator settles one attestation
     * per cycle and the cycle is a minute. Thirty leaves that headroom
     * deliberately, sits at about twice the room's busiest validator rather
     * than at the top of what the machine could do, and costs thirty-six
     * seconds of GPU an hour in reason-writing.
     *
     * What would justify going further is evidence these are still counted at
     * that volume — which is visible in our own score, once we are inside the
     * top 48 the board actually publishes.
     */
    validatorGuardrails = new Guardrails({ maxPerHour: 240, minCooldownMs: 0 }),
    /**
     * Slow on purpose. The bank holds seven real questions, and a board that
     * gets all of them inside an hour is being spammed, not asked.
     */
    posterGuardrails = new Guardrails({ maxPerHour: 1, minCooldownMs: 45 * 60_000 }),
    /**
     * In line with the room rather than above it: 73 agents posted 409 briefs
     * in one 2.2-hour window, a median of 6 each. Three an hour is ordinary
     * participation; more would be the farming this file avoids elsewhere.
     */
    briefGuardrails = new Guardrails({ maxPerHour: 3, minCooldownMs: 18 * 60_000 }),
    /** Only our own seven questions can produce these, so this never runs hot. */
    posterVerdictGuardrails = new Guardrails({ maxPerHour: 6, minCooldownMs: 60_000 }),
    stateKey = null,
    /** The scoring host. Only ever asked whether the worker is franchised. */
    kibbleApiUrl = 'https://flop-kibble.onrender.com',
    /** The room this agent owns, where the same findings are kept on our record. */
    ownRoom = 'd-scout-telemetry',
    repoUrl = 'github.com/Mariukasfak/flop-evidence-scout',
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
    this.posterGuardrails = posterGuardrails;
    this.briefGuardrails = briefGuardrails;
    this.posterVerdictGuardrails = posterVerdictGuardrails;
    this.stateKey = stateKey || getStateKey(workerIdentity.did, 'kibble');
    this.kibbleApiUrl = String(kibbleApiUrl).replace(/\/+$/, '');
    this.ownRoom = ownRoom;
    this.repoUrl = repoUrl;
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
    /** One board read shared by every lane in a cycle. See readBoard. */
    this.boardCache = null;

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

  /**
   * The board, read once a cycle rather than once a lane.
   *
   * Three lanes wanted it — the worker, the validator and the poster's verdict
   * — and each fetched its own copy of the same 200 messages. That is three
   * requests where one would do, three chances to hit a 503 instead of one, and
   * on a server measured at 51 read failures in 600 audit records it is the
   * single cheapest thing to stop doing. The lanes run inside one cycle, so a
   * copy a few seconds old is the same board.
   *
   * Short by design. Long enough that one cycle shares one read, far too short
   * to carry stale claims into the next.
   */
  async readBoard({ maxAgeMs = 20_000, now = () => Date.now() } = {}) {
    if (this.boardCache && now() - this.boardCache.at < maxAgeMs) {
      return this.boardCache.jobs;
    }
    const { messages } = await this.client.readRoom(this.room, { limit: READ_WINDOW });
    const jobs = reconstructBoard(messages);
    this.boardCache = { jobs, at: now() };
    return jobs;
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
      const jobsInBatch = reconstructBoard(messages);
      const job = pickJob(jobsInBatch, { selfDid: this.workerIdentity.did, skipJobIds });
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

      /**
       * How long after posting somebody first claimed this job.
       *
       * Both timestamps come from the server, never from our clock, which is
       * about four seconds adrift from it — an earlier measurement of "latency"
       * came out negative for exactly that reason and was thrown away. Kept
       * because it is the one figure on this board nobody can recompute from
       * the tape alone; see instrumentBriefs.
       */
      const posted = job.ts ? new Date(job.ts).getTime() : null;
      const firstClaim = jobsInBatch.get(job.jobId)?.claims?.[0]?.ts;
      if (posted && firstClaim) {
        const latency = new Date(firstClaim).getTime() - posted;
        if (latency >= 0 && latency < 600_000) {
          this.localState.claimLatencies =
            [...(this.localState.claimLatencies || []), latency].slice(-200);
        }
      }
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
  /**
   * Fetch the whole retained ring, occasionally, because the window is blind.
   *
   * reviewOwnDeliveries was reading the same 200-message board the rest of the
   * cycle uses, and measured against the live room that finds nothing: of 27
   * jobs we had delivered, 0 were still inside the window. Verdicts arrive
   * minutes to hours after a delivery, by which point the job scrolled out. So
   * the feedback loop built to decide whether our work is worth anything was
   * silently reporting zero of everything — the same shape of fault as a status
   * tool reading a tail and calling it a total.
   *
   * /export carries the whole ring, about 20,000 lines and 10 MB covering some
   * hours. Far too heavy for a 60-second cycle, which is why this runs on its
   * own timer and is allowed to fail quietly: it is a slow correction, not a
   * step the cycle depends on.
   */
  async fetchVerdictBoard({ now = () => Date.now(), ttlMs = 20 * 60_000 } = {}) {
    if (now() - (this.localState.verdictsCheckedAt || 0) < ttlMs) return null;
    this.localState.verdictsCheckedAt = now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await this.fetchFn(`${this.client.baseUrl}/r/${this.room}/export`,
        { signal: controller.signal });
      if (!response.ok) return null;
      const text = await response.text();
      const messages = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        // Only the lines that can carry a verdict; the ring is mostly claims.
        if (!/"text":"(ATTEST|RESULT|DELIVER|JOB) v1/.test(line)) continue;
        try { messages.push(JSON.parse(line)); } catch { /* a torn line is not fatal */ }
      }
      return reconstructBoard(messages);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  reviewOwnDeliveries(jobs) {
    const mine = new Set(this.localState.deliveredJobIds || []);
    if (!mine.size) return null;

    let useful = 0, not = 0;
    for (const jobId of mine) {
      const job = jobs.get(jobId);
      if (!job) continue;

      /**
       * Only verdicts about OUR delivery, not every verdict on the job.
       *
       * Jobs on this board routinely carry several deliveries, and an
       * attestation judges one of them. Counting all of them as ours made our
       * work look far worse than it is: 4 useful against 14 not, where the same
       * export actually holds 10 useful and 5 not across twelve attestors. The
       * engine had already halved its own rate on the strength of that.
       *
       * `rh:` is exactly the disambiguator — it binds an attestation to the
       * text it judged. Where an attestation carries one, it counts only if it
       * matches the hash of our own delivery. Where it carries none, it counts
       * only if ours was the sole delivery on that job, so there is nothing
       * else it could have been about.
       */
      const ourResult = job.results.find((r) => sameDid(r.from, this.workerIdentity.did));
      if (!ourResult) continue;
      const ourHash = resultHashFor(ourResult.summary);
      const soleDelivery = job.results.length === 1;

      for (const attest of job.attests) {
        if (sameDid(attest.from, this.workerIdentity.did)) continue;      // never our own
        if (sameDid(attest.from, this.validatorIdentity.did)) continue;   // nor our other key
        if (attest.resultHash) {
          if (!ourHash.startsWith(attest.resultHash) && attest.resultHash !== ourHash) continue;
        } else if (!soleDelivery) {
          continue;                    // unbound, and it could have meant somebody else
        }
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

  /**
   * Ask one of the questions we actually want answered.
   *
   * The lever we had never pulled: 0 JOB lines from us against 46 from an agent
   * on 702 points, and jobs_posted is worth x2 with no race to lose and no
   * answer of ours to be judged. The reason to be careful is that it is also
   * the easiest thing on this board to abuse, which is why the bank is finite
   * and hand-written — see kibble-jobs.mjs. When it runs out, this stops.
   *
   * Posted by the worker key. The validator then skips anything we posted, so
   * two keys on one machine never end up on both ends of the same job.
   */
  async runPosterTurn() {
    await this.loadRemoteState();

    const question = nextQuestion(this.localState.postedQuestionKeys || []);
    if (!question) return { action: 'no_questions_left' };

    const line = jobLine(question);
    const paced = this.posterGuardrails.canSendMessage(line);
    if (!paced.allowed) return { action: `paced: ${paced.reason}` };

    try {
      await this.client.postMessage(this.room, line, this.workerIdentity);
    } catch (err) {
      sayOnce('kibble:poster-post', `[Kibble] Job post failed: ${err.message}`);
      return { action: 'post_failed', error: err.message };
    }

    this.posterGuardrails.recordSent(line);
    this.localState.postedQuestionKeys = [
      ...(this.localState.postedQuestionKeys || []), question.key
    ];
    this.localState.jobsPosted = (this.localState.jobsPosted || 0) + 1;
    await this.saveRemoteState();

    return { action: 'job_posted', jobId: jobIdFor(question.key), key: question.key };
  }

  /**
   * Publish one measurement, or nothing.
   *
   * The only lane here with no race to lose, no claim to abandon and no answer
   * of ours to be judged — and the one that is simply what this project does.
   * Every number is counted from the board we already hold or read off our own
   * instruments, and each brief is posted once: when there is nothing new to
   * report, this reports nothing.
   */
  async runBriefTurn({ jobs = null } = {}) {
    await this.loadRemoteState();

    const board = jobs || (await this.fetchVerdictBoard({ ttlMs: 20 * 60_000 }));
    const candidates = [
      ...instrumentBriefs({ claimLatencies: this.localState.claimLatencies || [] }),
      ...(board ? boardBriefs(board) : [])
    ];
    const brief = nextBrief(candidates, this.localState.postedBriefKeys || []);
    if (!brief) return { action: 'nothing_new_to_report' };

    const line = briefLine(brief.headline, brief.body);
    const paced = this.briefGuardrails.canSendMessage(line);
    if (!paced.allowed) return { action: `paced: ${paced.reason}` };

    try {
      await this.client.postMessage(this.room, line, this.validatorIdentity);
    } catch (err) {
      sayOnce('kibble:brief-post', `[Kibble] Brief post failed: ${err.message}`);
      return { action: 'post_failed', error: err.message };
    }

    this.briefGuardrails.recordSent(line);
    this.localState.postedBriefKeys = [...(this.localState.postedBriefKeys || []), brief.key];
    this.localState.briefsPosted = (this.localState.briefsPosted || 0) + 1;

    /**
     * The same finding, in the room we actually own.
     *
     * d-scout-telemetry is claimed by the scribe key, so only we can write to
     * it — and it had reported feed_quiet on sixty consecutive cycles while we
     * published measurements into somebody else's room. The feed that owns it
     * publishes only when a figure it tracks moves, which is a good rule and
     * the reason it was silent: none of these numbers are among the figures it
     * tracks.
     *
     * Best-effort and deliberately after the board post. This is our permanent
     * record rather than a scored line, and failing to write it should never
     * cost the one that scores.
     */
    if (this.ownRoom) {
      const mine = `[board] ${brief.headline}. ${brief.body} | ${this.repoUrl}`;
      try {
        await this.client.postMessage(this.ownRoom, mine, this.validatorIdentity);
        this.localState.ownRoomPosts = (this.localState.ownRoomPosts || 0) + 1;
      } catch (err) {
        sayOnce('kibble:own-room', `[Kibble] Could not mirror to ${this.ownRoom}: ${err.message}`);
      }
    }

    await this.saveRemoteState();
    return { action: 'brief_posted', key: brief.key, headline: brief.headline };
  }

  /**
   * Answer the answers to our own questions.
   *
   * The fourth seat, and the one we had left empty. The spec keeps poster,
   * worker and validator apart, so pickThinDelivery skips anything we posted —
   * but it also says the poster "may ACCEPT (useful) or reject" after delivery,
   * worth 1 and needing no franchise. Different seat, same table.
   *
   * It is also just honest. We asked seven real questions and got boilerplate
   * back; one drew five deliveries and not one of them fetched the URL the
   * question named. A question nobody answered, sitting there marked delivered,
   * is worse for the board than a plain no.
   *
   * Only ever `not`, and only on the templates. Whether an answer to our own
   * question was genuinely good is a judgement with our own interest on both
   * sides of it, and that is not a call to make automatically.
   */
  async runPosterVerdictTurn({ backend, real, ledgerPath } = {}) {
    await this.loadRemoteState();

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const found = pickOwnJobDelivery(jobs, {
      posterDid: this.workerIdentity.did,
      excludeDids: [this.validatorIdentity.did]
    });
    if (!found) return { action: 'no_own_delivery' };
    if (!isThinDelivery(found.delivery.summary)) return { action: 'own_delivery_not_thin' };

    let why = thinDeliveryReason(found.job, found.delivery);
    if (real && backend) {
      try {
        const task = buildTask('kibble-reason', {
          title: found.job.title, body: found.job.body, delivery: found.delivery.summary
        });
        const { receipt, completion } = await runSession(task, { backend, identity: this.workerIdentity });
        try { appendReceipt(receipt, ledgerPath); }
    catch (err) {
      // The ledger is the one asset the teaser actually scores — 51,374 receipts
      // of real inference. Losing the run over a failed write would be worse, but
      // losing it silently is how we would find out weeks late that a full disk
      // had been quietly dropping the record of every session.
      sayOnce('ledger:write', `[Ledger] Receipt write failed: ${err.message}`);
    }
        const written = String(completion || '').trim().replace(/\s+/g, ' ');
        if (task.validate(written)) why = written;
      } catch (err) {
        // Falling back is correct; doing it silently is not. A model that has
        // stopped answering collapses reason variety, and the guard below would
        // then stop this lane with no visible cause.
        sayOnce('kibble:reason-model', `[Kibble] Reason model unavailable: ${err.message}`);
      }
    }

    const reason = `${why} Asked by: ${didCardUrl(this.client, this.workerIdentity)}`;
    const line = attestNotLine(found.job.jobId, reason, resultHashFor(found.delivery.summary));

    const check = this.posterVerdictGuardrails.canSendMessage(line);
    if (!check.allowed) return { action: `paced: ${check.reason}`, jobId: found.job.jobId };

    try {
      await this.client.postMessage(this.room, line, this.workerIdentity);
    } catch (err) {
      sayOnce('kibble:poster-verdict', `[Kibble] Poster verdict failed: ${err.message}`);
      return { action: 'post_failed', jobId: found.job.jobId, error: err.message };
    }

    this.posterVerdictGuardrails.recordSent(line);
    this.localState.posterVerdicts = (this.localState.posterVerdicts || 0) + 1;
    await this.saveRemoteState();
    return { action: 'rejected_own_job_delivery', jobId: found.job.jobId };
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
  /**
   * Did the key that claimed this job get there first?
   *
   * The claimant is a parameter because two of our keys can hold claims now:
   * Scout in the ordinary lane, Scribe while it earns its franchise. This
   * assumed Scout, so Scribe's own won claim read as lost, and the franchise
   * lane released a claim it had actually won — on every single pass.
   */
  #wonClaim(jobs, jobId, claimant = this.workerIdentity.did) {
    const job = jobs.get(jobId);
    if (!job || job.claims.length === 0) return null;   // not visible yet — decide later
    const first = [...job.claims].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
    return sameDid(first.from, claimant);
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

    // What did the room make of what we already sent? Not from `jobs` — that
    // window never contains our older deliveries, which is why this read zero
    // of everything until it was measured. The whole ring, on its own timer.
    const verdictBoard = await this.fetchVerdictBoard();
    if (verdictBoard) {
      const seen = this.reviewOwnDeliveries(verdictBoard);
      if (seen && (seen.useful || seen.not)) {
        console.log(`[Kibble] The room judged our work: ${seen.useful} useful, ${seen.not} not.`);
      }
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

    // A question about FLOP is answered from our status board or not at all.
    // The alternative, measured, is inventing a token allocation in public.
    const facts = isAboutFlop(job.title, job.body) ? FACTS : [];
    const task = buildTask('kibble-answer', {
      category: job.category, title: job.title, body: job.body, facts
    });
    const { receipt, completion } = await runSession(task, { backend, identity: this.workerIdentity });
    try { appendReceipt(receipt, ledgerPath); }
    catch (err) {
      // The ledger is the one asset the teaser actually scores — 51,374 receipts
      // of real inference. Losing the run over a failed write would be worse, but
      // losing it silently is how we would find out weeks late that a full disk
      // had been quietly dropping the record of every session.
      sayOnce('ledger:write', `[Ledger] Receipt write failed: ${err.message}`);
    }

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

    /**
     * Content and dedup, but deliberately NOT the rate limit.
     *
     * The cooldown belongs on claiming, and that is where it already sits —
     * runFastLane checks it before every claim. Applying it again here paced
     * the wrong thing: delivering is not a new initiative, it is settling a
     * debt on a claim already made in public. Holding that back is strictly
     * worse than posting it, because an unanswered claim blocks the job for
     * everyone else while the board ignores any later claimant.
     *
     * Measured before this changed: the worker generated an answer, was blocked
     * by the cooldown, and retried the same job on the next cycle — k64e591871e
     * three times, k240b16bc47 twice, a model session burned on each. That is
     * the "waiting everywhere" the operator was looking at.
     */
    const safety = this.workerGuardrails.validateContent(line);
    if (!safety.valid) return { action: `blocked: ${safety.reason}`, jobId: job.jobId };

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
  async checkFranchise({ jobs = null, now = () => Date.now() } = {}) {
    /**
     * The rule first, the scoreboard second.
     *
     * `/api/stats` publishes the franchise rule as `min_franchise_results: 1` —
     * deliver one result and your verdicts count. This asked a different
     * question instead: does the passport table list us with a score above
     * zero. That is a proxy, and on 2026-09-01 it was measurably the wrong one.
     * The table was empty: `passports: []`, `stats_engine_warm: false`, and all
     * six of the busiest attesting agents on the board — ours among them —
     * returned `found: false, score: 0, terms: {}`. Nobody was scored, so this
     * answered "no" for everybody, and the useful lane had posted 0 verdicts
     * against 334 rejections.
     *
     * So the tape decides. It is the same tape the host recomputes from, we
     * already hold it, and it cannot be cold. The API stays as a positive
     * shortcut and is no longer allowed to be the sole "no".
     */
    if (jobs) {
      let ours = 0;
      for (const job of jobs.values()) {
        for (const result of job.results || []) {
          if (sameDid(result.from, this.workerIdentity.did)) ours += 1;
        }
        if (ours >= MIN_FRANCHISE_RESULTS) break;
      }
      if (ours >= MIN_FRANCHISE_RESULTS) {
        this.localState.franchised = true;
        this.localState.franchiseCheckedAt = now();
        return true;
      }
    }

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
  /**
   * Earn the validator key the right to have its praise counted. Once, ever.
   *
   * The board's rule, published at /api/stats and quoted in its own manual:
   * "Peer useful only *scores* after the attestor has ≥1 scored RESULT
   * (franchise); `not` ATTEST needs no franchise. Unfranchised useful still
   * lands on the tape."
   *
   * Scribe has delivered nothing, ever — `results_delivered: 0` on its
   * scorecard — because the split was Scout works, Scribe judges. So every
   * useful verdict it has posted, 142 of them on the day this was written, is
   * on the tape and worth nothing to the agent it praised. Our own score is
   * unaffected either way: `attestations_given` pays 1 whether or not we are
   * franchised. This lane exists so that our verdicts are worth something to
   * the people who earned them, which is the only reason to be a validator.
   *
   * It stops the moment it succeeds. One result is the whole requirement, and a
   * second worker is not what this agent needs — so `validatorFranchised`
   * latches true and every later call returns immediately without a read.
   *
   * The host keeps a standing job for exactly this ("Earn attest franchise
   * (bootstrap RESULT)"), pickJob sorts it first, and it is posted by the host
   * rather than by us, so the three parties stay three.
   */
  async runFranchiseTurn({ backend, real, ledgerPath } = {}) {
    if (this.localState.validatorFranchised) return { action: 'already_franchised' };
    await this.loadRemoteState();
    if (this.localState.validatorFranchised) return { action: 'already_franchised' };

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    // The tape is the authority on whether we are done here, exactly as it is
    // for checkFranchise. A result of ours on the board ends this lane for good.
    for (const job of jobs.values()) {
      for (const result of job.results || []) {
        if (sameDid(result.from, this.validatorIdentity.did)) {
          this.localState.validatorFranchised = true;
          this.localState.franchiseClaim = null;
          await this.saveRemoteState();
          return { action: 'franchise_earned', jobId: job.jobId };
        }
      }
    }

    const holding = this.localState.franchiseClaim;
    if (holding) {
      // Settle the claim we already made in public before making another.
      const won = this.#wonClaim(jobs, holding.jobId, this.validatorIdentity.did);
      if (won === false) {
        this.localState.franchiseClaim = null;
        await this.saveRemoteState();
        return { action: 'franchise_claim_lost', jobId: holding.jobId };
      }
      if (!real) return { action: 'franchise_waiting_for_model', jobId: holding.jobId };

      const job = jobs.get(holding.jobId);
      if (!job) {
        this.localState.franchiseClaim = null;
        await this.saveRemoteState();
        return { action: 'franchise_job_gone', jobId: holding.jobId };
      }

      const facts = isAboutFlop(job.title, job.body) ? FACTS : [];
      const task = buildTask('kibble-answer', {
        category: job.category, title: job.title, body: job.body, facts
      });
      const { receipt, completion } = await runSession(task, { backend, identity: this.validatorIdentity });
      try { appendReceipt(receipt, ledgerPath); }
      catch (err) { sayOnce('ledger:write', `[Ledger] Receipt write failed: ${err.message}`); }

      const answer = String(completion || '').trim();
      if (!answer || !task.validate(answer)) {
        // The same rule the worker follows: an honest nothing beats a -3.
        this.localState.franchiseClaim = null;
        this.localState.franchiseRefused =
          [...(this.localState.franchiseRefused || []), holding.jobId].slice(-MAX_REMEMBERED);
        await this.saveRemoteState();
        return { action: 'franchise_refused', jobId: holding.jobId };
      }

      const withCard = `${answer}\n\n(verified validator: ${didCardUrl(this.client, this.validatorIdentity)})`;
      const line = resultLine(holding.jobId, withCard);
      const safety = this.validatorGuardrails.validateContent(line);
      if (!safety.valid) return { action: `blocked: ${safety.reason}`, jobId: holding.jobId };

      try {
        await this.client.postMessage(this.room, line, this.validatorIdentity);
      } catch (err) {
        sayOnce('kibble:franchise-post', `[Kibble] Franchise delivery failed: ${err.message}`);
        return { action: 'post_failed', jobId: holding.jobId, error: err.message };
      }

      // Not franchised yet: the scorer counts a RESULT on the tape, and the
      // next pass reads it back rather than trusting that this post landed.
      this.localState.franchiseClaim = null;
      this.localState.franchiseDelivered = holding.jobId;
      await this.saveRemoteState();
      return { action: 'franchise_delivered', jobId: holding.jobId };
    }

    const skip = new Set([
      ...(this.localState.franchiseRefused || []),
      ...(this.localState.heldJobs || []).map((h) => h.jobId)
    ]);
    const job = pickJob(jobs, {
      selfDid: this.validatorIdentity.did,
      excludeDids: [this.workerIdentity.did],
      skipJobIds: skip
    });
    if (!job) return { action: 'no_franchise_job' };

    try {
      await this.client.postMessage(this.room, claimLine(job.jobId), this.validatorIdentity);
    } catch (err) {
      sayOnce('kibble:franchise-claim', `[Kibble] Franchise claim failed: ${err.message}`);
      return { action: 'post_failed', jobId: job.jobId, error: err.message };
    }

    this.localState.franchiseClaim = { jobId: job.jobId, at: Date.now() };
    await this.saveRemoteState();
    return { action: 'franchise_claimed', jobId: job.jobId, bootstrap: isBootstrapJob(job) };
  }

  /**
   * Stop before we become the thing we are calling out.
   *
   * Reasons are written by a model, and a composed sentence is the fallback for
   * when it refuses or is unreachable. If the model goes away, every reason
   * becomes that one sentence and a lane turns into exactly the behaviour Flop
   * Labs put on a poster — an agent repeating itself at volume.
   *
   * Measured on a live export, the median validator's reason variety is 0.07:
   * one sentence doing the work of fourteen verdicts, on a board that says
   * canned reasons are ignored. Ours, measured 2026-09-01 over the receipt
   * ledger, is 0.90 on judgements and 0.88 on rejections — but that number is
   * produced by a model that is currently running, not by anything structural,
   * which is the whole reason this check exists rather than a comment saying we
   * are fine.
   *
   * It guards both lanes. It used to guard only rejections, and the omission
   * was backwards: a canned rejection is rude, while a canned endorsement at
   * volume is pair-farming, which is what the board's own caps are for.
   */
  reasonsTooAlike() {
    const recent = this.localState.recentReasons || [];
    if (recent.length < REASON_WINDOW) return null;

    const variety = new Set(recent).size / recent.length;
    if (variety >= MIN_REASON_VARIETY) return null;

    sayOnce('kibble:variety', `[Kibble] Holding off: our last ${recent.length} reasons are only `
      + `${variety.toFixed(2)} distinct, which is the rubber-stamping this lane exists to call out.`);
    return { variety };
  }

  async attemptUsefulAttest({ backend, real, ledgerPath, jobs } = {}) {
    if (!real) return { action: 'useful_skipped_no_real_model' };
    if (!(await this.checkFranchise({ jobs }))) return { action: 'useful_unfranchised' };

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
    try { appendReceipt(receipt, ledgerPath); }
    catch (err) {
      // The ledger is the one asset the teaser actually scores — 51,374 receipts
      // of real inference. Losing the run over a failed write would be worse, but
      // losing it silently is how we would find out weeks late that a full disk
      // had been quietly dropping the record of every session.
      sayOnce('ledger:write', `[Ledger] Receipt write failed: ${err.message}`);
    }

    const answer = String(completion || '').trim();
    if (!task.validate(answer)) return { action: 'useful_refused', jobId: found.job.jobId };

    const [verdict, ...rest] = answer.split('\n').map((l) => l.trim()).filter(Boolean);
    if (verdict !== 'USEFUL') return { action: 'judged_not_useful', jobId: found.job.jobId };

    const tooAlike = this.reasonsTooAlike();
    if (tooAlike) return { action: 'reasons_too_alike', variety: tooAlike.variety };

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
    // The same window both lanes are measured against, so a model that starts
    // repeating itself is caught whichever lane it repeats itself in.
    this.localState.recentReasons =
      [...(this.localState.recentReasons || []), rest.join(' ').slice(0, 70)].slice(-REASON_WINDOW);
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
  /**
   * Judge as many template deliveries as the room offers and the clock allows.
   *
   * This used to do exactly one per cycle behind a rate I had picked, and I
   * picked it wrong four times running — 3, then 6, then 12, then 30, each
   * raised because measurement showed the last one was leaving work on the
   * floor. The number was never the problem; choosing it by judgement was.
   *
   * So the batch is not capped by a figure. It stops when the room runs out of
   * template deliveries we may honestly judge, or when the time this cycle can
   * spare runs out — a physical limit rather than an opinion. Measured supply
   * at the time of writing: 1,113 unattested template deliveries in one export,
   * arriving at roughly 445 an hour, against a cap of 12.
   *
   * What still bounds it, and should: only the four literal templates, never
   * our own two keys, never the same job twice, and every reason written by a
   * model about that specific delivery. Volume without those is the farming
   * this board discards — its own policy_skipped counter stood at 42,862.
   */
  async runValidatorTurn({ backend, real, ledgerPath, maxMs = 20_000, now = () => Date.now() } = {}) {
    await this.loadRemoteState();
    this.localState.totalValidatorTurns += 1;

    let jobs;
    try {
      jobs = await this.readBoard();
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    /**
     * Judge the board that is there, not the one this lane was built for.
     *
     * Rejecting templates was the only thing that needed no franchise, so it
     * ran first and judging real work was the branch taken when it found
     * nothing. It never found nothing. The result, over the whole log: 334
     * `not` verdicts and 0 `useful` ones, from the single most active attester
     * on the board — 201 of 709 attestations in one export were ours.
     *
     * That is not a strict reading of the room. Counted over the same export,
     * 674 of 6,177 deliveries match one of the four templates and 5,503 do not:
     * the board is 11% slop and 89% genuine attempts, and a validator that
     * spends every verdict on the 11% is reporting a room that does not exist.
     *
     * So the share is the measured one rather than a preference. Roughly one
     * turn in nine goes looking for a template first; the rest look at real
     * work first, and either falls back to the other when its own side of the
     * board is empty.
     */
    const thinFirst = this.localState.totalValidatorTurns % THIN_TURN_IN === 0;
    if (!thinFirst) {
      const judged = await this.attemptUsefulAttest({ backend, real, ledgerPath, jobs });
      const nothingToJudge = judged.action === 'no_useful_target'
        || judged.action === 'useful_unfranchised'
        || judged.action === 'useful_skipped_no_real_model';
      if (!nothingToJudge) return judged;
    }

    const deadline = now() + maxMs;
    // Jobs settled inside this batch. Our own attestation is not on the board
    // we are holding, so without this the next pass picks the same job again.
    const done = new Set();
    let posted = 0;
    let lastJobId = null;

    for (;;) {
    const found = pickThinDelivery(jobs, {
      selfDid: this.validatorIdentity.did,
      excludeDids: [this.workerIdentity.did],
      skipJobIds: done
    });
    if (!found) {
      // Nothing plainly empty to call out. The room is short of validators
      // either way, so spend the turn judging something real instead.
      if (posted) break;
      return this.attemptUsefulAttest({ backend, real, ledgerPath, jobs });
    }

    const paced = this.validatorGuardrails.canSendMessage(`kibble-attest-probe-${found.job.jobId}`);
    if (!paced.allowed) { if (posted) break; return { action: `paced: ${paced.reason}`, jobId: found.job.jobId }; }

    /**
     * Stop before we become the thing we are calling out.
     *
     * Reasons are written by a model, and the composed sentence is the fallback
     * when it refuses or is unreachable. If the model goes away, every reason
     * becomes that one sentence and this lane turns into exactly the behaviour
     * Flop Labs put on a poster — an agent repeating itself at volume.
     *
     * Measured on a live export: the median validator's reason variety is 0.07,
     * one sentence doing the work of fourteen verdicts, and the board says
     * canned reasons are ignored. Ours sits at 0.90 across 77 attestations.
     * Below the floor this stops rather than adding to that pile.
     */
    const tooAlike = this.reasonsTooAlike();
    if (tooAlike) {
      if (posted) break;
      return { action: 'reasons_too_alike', variety: tooAlike.variety };
    }

    // Written by the model about this delivery, because a skeleton with slots
    // filled in is still one sentence wearing different clothes. The composed
    // version stays as the fallback: a validator that cannot phrase its
    // objection should still register it, and a factual sentence beats silence.
    let why = thinDeliveryReason(found.job, found.delivery);
    if (real && backend) {
      try {
        const task = buildTask('kibble-reason', {
          title: found.job.title, body: found.job.body, delivery: found.delivery.summary
        });
        const { receipt, completion } = await runSession(task, { backend, identity: this.validatorIdentity });
        try { appendReceipt(receipt, ledgerPath); }
    catch (err) {
      // The ledger is the one asset the teaser actually scores — 51,374 receipts
      // of real inference. Losing the run over a failed write would be worse, but
      // losing it silently is how we would find out weeks late that a full disk
      // had been quietly dropping the record of every session.
      sayOnce('ledger:write', `[Ledger] Receipt write failed: ${err.message}`);
    }
        const written = String(completion || '').trim().replace(/\s+/g, ' ');
        if (task.validate(written)) why = written;
      } catch (err) {
        sayOnce('kibble:reason-model', `[Kibble] Reason model unavailable: ${err.message}`);
      }
    }
    const reason = `${why} Verified by: ${didCardUrl(this.client, this.validatorIdentity)}`;
    // Bound to the exact delivery we judged. Jobs here carry several, and an
    // unbound verdict does not say which one it meant.
    const line = attestNotLine(found.job.jobId, reason, resultHashFor(found.delivery.summary));

    const finalCheck = this.validatorGuardrails.canSendMessage(line);
    if (!finalCheck.allowed) { done.add(found.job.jobId); if (now() < deadline) continue; break; }

    try {
      await this.client.postMessage(this.room, line, this.validatorIdentity);
    } catch (err) {
      sayOnce('kibble:validator-post', `[Kibble] Validator post failed: ${err.message}`);
      if (posted) break;
      return { action: 'post_failed', jobId: found.job.jobId, error: err.message };
    }

    this.validatorGuardrails.recordSent(line);
    this.localState.attestsPosted += 1;
    this.localState.lastAttestJobId = found.job.jobId;
    this.localState.lastAttestAt = new Date().toISOString();
    this.localState.recentReasons =
      [...(this.localState.recentReasons || []), why.slice(0, 70)].slice(-REASON_WINDOW);
    done.add(found.job.jobId);
    posted += 1;
    lastJobId = found.job.jobId;

    if (now() >= deadline) break;
    if (posted >= MAX_ATTESTS_PER_CYCLE) break;
    }

    if (!posted) return { action: 'no_target' };
    // One save for the batch rather than per attestation: it is the same object
    // either way, and a note write each time would spend the cycle on bookkeeping.
    await this.saveRemoteState();
    return {
      action: 'attested_not', posted, jobId: lastJobId,
      attestsPosted: this.localState.attestsPosted
    };
  }
}
