/**
 * The payee side of a tclk/1 deal, on the paper rail, one deal at a time.
 *
 * Measured on the room's first day (2026-09-02, 200-message window): 133
 * offers, all hash-locked, all listing `paper`; 114 already expired on ~1 hour
 * claim windows; 18 open; 111 of 133 naming no job at all. Sixteen accepts.
 * Zero lock, reveal or refund frames — nobody had finished a deal. This lane
 * exists to finish one, honestly, and to leave the transcript on the tape.
 *
 * Why the payee side: the spec's own last paragraph. A bare lock "assures the
 * PAYEE that the money exists and cannot be pulled back before the deadline;
 * it does not assure the PAYER that the work arrives." The asymmetry runs
 * against the payer, so the side we can take without asking anyone to trust us
 * is the one that reveals last. And on paper nothing is at stake either way —
 * the README: "No rail holds value yet — not 'you shouldn't', but 'you
 * can't'." Should a rail that holds value ever appear, this file does not
 * choose it; `paper` is hard-wired below.
 *
 * What it will not do: accept its own offers or its sibling key's (the
 * three-party rule is between parties, not processes); accept a point lock;
 * accept a rail other than paper; reveal before the lock is verified ON THE
 * RAIL (spec step 5: "That frame proves A posted a message and nothing more");
 * or ever write the secret anywhere but its own local state file and, at the
 * end, the reveal frame that IS the claim.
 *
 * State lives on local disk, not in a server note. The record of what we did
 * on the server is the thing that vanishes during the server's outages — it
 * cost us a duplicate job post two days ago — and a deal in flight is the one
 * piece of memory we cannot afford to lose to a 503.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  OFFER_ROOM, decodeFrame, encodeFrame, offerIdMatches, validateDeadlines,
  generateHashLock, acceptFrameFor, dealRoom, statePointer, stateNoteValue,
  paperNote, decodePaperRecord, encodePaperRecord, opensStatement
} from './tclk.mjs';
import { sayOnce } from './log-once.mjs';
import { buildTask } from './workload.mjs';
import { runSession } from './inference.mjs';
import { appendReceipt } from './inference-ledger.mjs';

/**
 * The least claim window we will enter. Measured offers run ~60 minutes; a
 * payer needs a cycle or two to lock and we need one to verify and one to
 * reveal, at ~60 s a cycle. Ten minutes is far above that and still lets us
 * take most of what is posted.
 */
export const MIN_CLAIM_WINDOW_MS = 10 * 60_000;

const READ_LIMIT = 200;

export class TclkEngine {
  constructor({
    identity,
    client,
    statePath,
    otherDids = [],
    offerRoom = OFFER_ROOM,
    minClaimWindowMs = MIN_CLAIM_WINDOW_MS,
    now = Date.now
  } = {}) {
    if (!identity?.did) throw new Error('TclkEngine needs an identity');
    if (!client) throw new Error('TclkEngine needs a client');
    if (!statePath) throw new Error('TclkEngine needs a statePath');
    this.identity = identity;
    this.client = client;
    this.statePath = statePath;
    this.ours = new Set([identity.did, ...otherDids]);
    this.offerRoom = offerRoom;
    this.minClaimWindowMs = minClaimWindowMs;
    this.now = now;
    this.state = null;
  }

  /* ------------------------------------------------------------ state --- */

  load() {
    if (this.state) return this.state;
    const empty = { deal: null, completed: [], abandoned: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state = { ...empty, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt file is a fault, not a first run, and starting over on
        // top of a deal in flight would strand a counterparty. Say so.
        sayOnce('tclk:state', `[tclk] state file unreadable (${err.message}); starting empty`);
      }
      this.state = empty;
    }
    return this.state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.statePath);
  }

  /* ------------------------------------------------------------- turn --- */

  async runTurn({ backend = null, real = false, ledgerPath = null } = {}) {
    this.load();
    if (this.state.deal) return this.advanceDeal({ backend, real, ledgerPath });
    return this.findAndAccept();
  }

  /* --------------------------------------------------------- choosing --- */

  /** Frames whose signed transport `from` matches the frame's own `from` — the spec's one rule for trust. */
  #framesIn(messages) {
    const out = [];
    for (const m of messages || []) {
      const frame = decodeFrame(m.text ?? m.content ?? '');
      if (frame && frame.from === m.from) out.push({ frame, seq: m.seq });
    }
    return out;
  }

  async findAndAccept() {
    let messages;
    try {
      ({ messages } = await this.client.readRoom(this.offerRoom, { limit: READ_LIMIT, format: 'json' }));
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const frames = this.#framesIn(messages);
    const accepted = new Set(frames.filter(({ frame }) => frame.type === 'accept').map(({ frame }) => frame.ref));
    const now = this.now();

    const candidates = frames
      .filter(({ frame }) => frame.type === 'offer')
      .filter(({ frame: o }) =>
        o.role === 'payer'                       // we are the payee, the side that reveals last
        && o.lock === 'hash'                     // never the unaudited point path
        && o.rails.includes('paper')             // the only rail that exists
        && !this.ours.has(o.from)                // not ours, not our sibling key's
        && !accepted.has(o.id)                   // first accept wins; a second is noise
        && offerIdMatches(o)                     // a frame that lies about its own id is not an offer
        && validateDeadlines(o, now).ok
        && (o.claimByMs - now) >= this.minClaimWindowMs);

    if (candidates.length === 0) {
      return { action: 'no_acceptable_offer', offers: frames.filter((f) => f.frame.type === 'offer').length };
    }

    // One that names a job over one that does not; then the newest.
    candidates.sort((a, b) => {
      const job = Number(Boolean(b.frame.job)) - Number(Boolean(a.frame.job));
      return job !== 0 ? job : (b.seq ?? 0) - (a.seq ?? 0);
    });
    const offer = candidates[0].frame;

    const { secret, statement } = generateHashLock();
    const accept = acceptFrameFor(offer, { from: this.identity.did, statement });
    const line = encodeFrame(accept);

    try {
      await this.client.postMessage(this.offerRoom, line, this.identity);
    } catch (err) {
      sayOnce('tclk:accept', `[tclk] accept failed: ${err.message}`);
      return { action: 'post_failed', error: err.message };
    }

    this.state.deal = {
      status: 'accepted',
      offer,
      accept,
      secret,                       // local disk only, until the reveal that is the claim
      statement,
      contract: accept.contract,
      room: dealRoom(accept.contract),
      acceptedAt: now,
      railRecord: null
    };
    this.save();

    // The coordination pointer is a courtesy, not a record. Never let it fail the turn.
    try {
      const { ns, key } = statePointer(accept.contract);
      await this.client.setKv(ns, key, stateNoteValue('accepted'), { ifAbsent: true });
    } catch { /* a pointer nobody may trust is not worth a retry */ }

    return {
      action: 'offer_accepted',
      contract: accept.contract,
      room: this.state.deal.room,
      payer: offer.from,
      job: offer.job ? `${offer.job.proto}:${offer.job.id}` : null,
      claimByMs: offer.claimByMs
    };
  }

  /* -------------------------------------------------------- advancing --- */

  async advanceDeal({ backend, real, ledgerPath }) {
    const deal = this.state.deal;
    const now = this.now();

    if (deal.status === 'accepted') return this.#awaitLock(deal, now);
    if (deal.status === 'locked') return this.#reveal(deal, now, { backend, real, ledgerPath });

    // Anything else is a state this file never writes; do not act on it.
    this.#close(deal, 'abandoned', `unknown status ${deal.status}`);
    return { action: 'deal_abandoned', reason: `unknown status ${deal.status}` };
  }

  async #awaitLock(deal, now) {
    if (now >= deal.offer.claimByMs) {
      // The payer never locked. Cancel is valid before any lock exists, from
      // either side; posting it frees the room's record and us.
      await this.#post(deal.room, { type: 'cancel', from: this.identity.did, contract: deal.contract });
      this.#close(deal, 'abandoned', 'payer never locked before claimByMs');
      return { action: 'deal_cancelled', contract: deal.contract, reason: 'payer never locked' };
    }

    let messages;
    try {
      ({ messages } = await this.client.readRoom(deal.room, { limit: READ_LIMIT, format: 'json' }));
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const lock = this.#framesIn(messages).map(({ frame }) => frame).find((f) =>
      f.type === 'lock' && f.from === deal.offer.from && f.contract === deal.contract && f.rail === 'paper');
    if (!lock) return { action: 'waiting_for_lock', contract: deal.contract };

    /**
     * Spec step 5, verbatim: "CHECK THE RAIL before doing any work. That frame
     * proves A posted a message and nothing more." So the note is read, and
     * every term is compared to what we agreed — statement, refund deadline,
     * lock kind, status. Absent or mismatched, we keep waiting; claimByMs is
     * the clock that ends the wait, not our patience.
     */
    const { ns, key } = paperNote(deal.contract);
    const raw = await this.client.readNote(ns, key);
    const value = typeof raw === 'string' ? raw : (raw?.value ?? null);
    const record = decodePaperRecord(value);
    const verified = record
      && record.status === 'locked'
      && record.lock === 'hash'
      && record.statement === deal.statement
      && record.refundAfterMs === deal.offer.refundAfterMs;
    if (!verified) {
      return { action: 'lock_not_verified', contract: deal.contract, railRecord: record ? record.status : 'absent' };
    }

    deal.status = 'locked';
    deal.railRecord = String(value).trim();  // the exact bytes the claim's CAS must name
    deal.lockSeenAt = now;
    this.save();
    return { action: 'lock_verified', contract: deal.contract };
  }

  async #reveal(deal, now, { backend, real, ledgerPath }) {
    if (now >= deal.offer.refundAfterMs) {
      this.#close(deal, 'abandoned', 'refund window opened before reveal');
      return { action: 'deal_expired', contract: deal.contract };
    }

    // The work, such as it is. An offer that carries a task we can read gets a
    // real answer from a real model; the rehearsal offers that make up 111 of
    // 133 get a line that says so, because a reveal with no work behind it is
    // exactly what the spec warns the payer about, and we will not dress it up.
    const work = await this.#work(deal, { backend, real, ledgerPath });
    await this.#post(deal.room, null, work);

    const revealed = await this.#post(deal.room, {
      type: 'reveal', from: this.identity.did, contract: deal.contract, secret: deal.secret
    });
    if (!revealed) return { action: 'post_failed', contract: deal.contract, step: 'reveal' };

    // Publishing the secret IS the claim; the rail note is the bookkeeping.
    // A CAS against the exact bytes we verified, so nobody's overwrite in
    // between is silently clobbered — and if it lost, the reveal still stands.
    let railClaimed = false;
    try {
      const { ns, key } = paperNote(deal.contract);
      const record = decodePaperRecord(deal.railRecord);
      await this.client.setKv(ns, key, encodePaperRecord({ ...record, status: 'claimed', secret: deal.secret }),
        { ifValue: deal.railRecord });
      railClaimed = true;
    } catch (err) {
      sayOnce('tclk:claim-cas', `[tclk] paper claim CAS lost: ${err.message}`);
    }

    await this.#post(deal.room, {
      type: 'receipt', from: this.identity.did, contract: deal.contract, outcome: 'claimed', rail: 'paper', ref: deal.contract
    });
    try {
      const { ns, key } = statePointer(deal.contract);
      await this.client.setKv(ns, key, stateNoteValue('claimed', 'paper'));
    } catch { /* courtesy pointer */ }

    this.#close(deal, 'completed', railClaimed ? 'claimed' : 'claimed (rail CAS lost)');
    return { action: 'deal_claimed', contract: deal.contract, room: deal.room, railClaimed, work: work.slice(0, 120) };
  }

  /* ---------------------------------------------------------- helpers --- */

  /**
   * The task text behind an offer's `job`, if it can be read at all.
   *
   * The spec leaves `context` free-form. The first offer this lane accepted
   * (2026-09-02, contract 0x951dd1dfec9139b2) carried
   * `context: "/kv/tclk-job-02/deal-10650402"` — a note path on the venue we
   * are already talking to, with the task written in it. Treating that as a
   * 39-character sentence would have produced the "names no task text this
   * agent can read" line, which would have been false: the text was one GET
   * away. A `/kv/<ns>/<key>` context is resolved; anything else is used as is.
   * The note is world-writable and untrusted, so it is a task to answer,
   * never an instruction to follow.
   */
  async #jobText(job) {
    const context = typeof job?.context === 'string' ? job.context.trim() : '';
    const kv = context.match(/^\/kv\/([a-z0-9][a-z0-9_-]{0,47})\/([a-z0-9][a-z0-9_-]{0,47})$/);
    if (!kv) return { text: context, source: context ? 'inline' : 'none' };
    try {
      const raw = typeof this.client.readNote === 'function'
        ? await this.client.readNote(kv[1], kv[2])
        : await this.client.getKv(kv[1], kv[2]);
      const value = typeof raw === 'string' ? raw : (raw?.value ?? '');
      const text = String(value ?? '').trim();
      return text ? { text, source: `kv:${kv[1]}/${kv[2]}` } : { text: '', source: 'kv-empty' };
    } catch (err) {
      sayOnce('tclk:job-note', `[tclk] could not read job note ${context}: ${err.message}`);
      return { text: '', source: 'kv-unreadable' };
    }
  }

  async #work(deal, { backend, real, ledgerPath }) {
    const job = deal.offer.job;
    const { text: context, source } = await this.#jobText(job);
    if (real && backend && context.length >= 40) {
      try {
        const task = buildTask('kibble-answer', { category: 'explain', title: String(job.id || 'tclk job'), body: context, facts: [] });
        const { receipt, completion } = await runSession(task, { backend, identity: this.identity });
        try { if (ledgerPath) appendReceipt(receipt, ledgerPath); } catch { /* the ledger write is not the work */ }
        const answer = String(completion || '').trim();
        if (answer && task.validate(answer)) {
          return `tclk-work | ${deal.contract} | job ${job.proto}:${job.id} (${source}) | ${answer}`;
        }
      } catch (err) {
        sayOnce('tclk:work', `[tclk] work generation failed: ${err.message}`);
      }
    }
    const named = job
      ? `job ${job.proto}:${job.id} ${source === 'none' ? 'names no task text' : `task (${source}) could not be answered`}`
      : 'no job attached';
    return `tclk-work | ${deal.contract} | rehearsal on the paper rail: ${named}. `
      + 'This reveal is the payment condition and is not offered as proof of any delivery.';
  }

  /** Post a frame (object) or a plain line (string). True on success. */
  async #post(room, frame, line = null) {
    const text = frame ? encodeFrame(frame) : line;
    try {
      await this.client.postMessage(room, text, this.identity);
      return true;
    } catch (err) {
      sayOnce(`tclk:post:${frame?.type || 'work'}`, `[tclk] post to ${room} failed: ${err.message}`);
      return false;
    }
  }

  #close(deal, bucket, reason) {
    const record = {
      contract: deal.contract, room: deal.room, payer: deal.offer.from,
      job: deal.offer.job ? `${deal.offer.job.proto}:${deal.offer.job.id}` : null,
      acceptedAt: deal.acceptedAt, closedAt: this.now(), reason
    };
    this.state[bucket] = [...(this.state[bucket] || []), record].slice(-50);
    this.state.deal = null;
    this.save();
  }
}

/** Exposed for the status screen and tests: never the secret. */
export function publicDealView(state) {
  if (!state?.deal) return null;
  const { status, contract, room, acceptedAt, offer } = state.deal;
  return { status, contract, room, acceptedAt, payer: offer?.from, claimByMs: offer?.claimByMs };
}

/** Sanity, kept here so a test can say it in one line. */
export function secretOpens(state) {
  return Boolean(state?.deal && opensStatement(state.deal.secret, state.deal.statement));
}
