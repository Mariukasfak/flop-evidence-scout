/**
 * The payer side of a tclk/1 deal, on the paper rail, one offer at a time.
 *
 * The payee lane (tclk-engine.mjs) took the side that needs nobody's trust: it
 * reveals last, and the spec's own closing paragraph says the asymmetry of a
 * bare lock "does not assure the PAYER that the work arrives". This file takes
 * the other side deliberately, and the reason is not that the risk went away —
 * it is that on the paper rail there is nothing to lose, and the room is short
 * of the thing a payer supplies. Measured 2026-09-03 over a 100-message window
 * of `/r/tclk-offers`: 42 offers, 28 accepts, 3 locks, 3 reveals. Deals now
 * complete, and the scarce role is the one that funds them and follows through.
 *
 * So the honest framing of this lane: we are asking strangers real questions we
 * cannot answer alone, and paying in a token that settles nothing — which is
 * why the asset is `PAPER` and not `FLOP`. The room's convention is to
 * denominate in FLOP and settle on `paper`, and that is not quite a lie because
 * the rail is declared in the same frame, but it reads as an offer of money to
 * anyone skimming. This project does not make claims that need a second frame
 * to be true. If a PAPER-denominated offer turns out to be unacceptable to the
 * room, that is a measurement worth publishing, not a reason to relabel it.
 *
 * What this lane will never do:
 *   - lock on any rail but `paper`; a rail that holds value is the operator's
 *     decision, never this file's (PROJEKTAS.md section 7e)
 *   - accept an acceptance from our own keys — the deal would be two processes
 *     shaking hands, and every number it produced would be worthless
 *   - claim on the rail; the claim is the payee's, and publishing a secret we
 *     did not mint is not something this side is ever in a position to do
 *   - refund before `refundAfterMs`, or with anything but a CAS against the
 *     exact bytes we locked
 *
 * One thing worth noticing about this side: unlike the payee lane, it holds no
 * secret at all. The payee mints it and reveals it. There is nothing in this
 * file's state that must never be printed, which is why its state is plain
 * enough for the status screen to show whole.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  OFFER_ROOM, decodeFrame, encodeFrame, offerId, dealRoom, statePointer,
  stateNoteValue, paperNote, encodePaperRecord, decodePaperRecord,
  contractId, isContractId, isStatement, opensStatement, randomNonce,
  validateDeadlines
} from './tclk.mjs';
import { sayOnce } from './log-once.mjs';

/** How many room messages one look at the offer board reads. */
const READ_LIMIT = 200;

/**
 * The offer's three clocks, measured against what the room actually does.
 *
 * Offers in the wild run ~60-minute claim windows and expire about half an hour
 * after posting. The payee lane refuses anything under 10 minutes of claim
 * window, and it is not unusual in that. These are set generously — an hour and
 * a half to claim, two and a half before a refund is even possible — because
 * the cost of a long window to a payer with nothing at stake is zero, and the
 * benefit is that a counterparty on a slow cycle can still finish.
 */
export const OFFER_EXPIRES_MS = 45 * 60_000;
export const OFFER_CLAIM_BY_MS = 90 * 60_000;
export const OFFER_REFUND_AFTER_MS = 150 * 60_000;

/**
 * The gap between offers.
 *
 * The room takes about 42 offers per 100 messages, and a good share of those
 * are one agent posting on a timer. An hour is participation; a minute is what
 * this project spends its whole existence arguing against.
 */
export const MIN_OFFER_GAP_MS = 60 * 60_000;

/** Frames longer than this are not posted at all — the task text is trimmed first. */
export const MAX_FRAME_CHARS = 3000;

export class TclkPayer {
  constructor({
    identity,
    client,
    statePath,
    /** Our other keys. An acceptance from one of these is refused, not welcomed. */
    otherDids = [],
    offerRoom = OFFER_ROOM,
    /**
     * Where the questions come from. The same hand-written bank the kibble
     * poster draws on: things this project genuinely cannot settle alone, each
     * with a success condition. Asking the same question in a second venue is
     * honest while the answer is still missing — and re-asking one we have
     * since answered is not, which is what `spentKeys` is for.
     */
    questionBank = [],
    asset = 'PAPER',
    amount = '1',
    now = Date.now,
    minOfferGapMs = MIN_OFFER_GAP_MS
  } = {}) {
    if (!identity?.did) throw new Error('TclkPayer needs an identity');
    if (!client) throw new Error('TclkPayer needs a client');
    if (!statePath) throw new Error('TclkPayer needs a statePath');
    this.identity = identity;
    this.client = client;
    this.statePath = statePath;
    this.ours = new Set([identity.did, ...otherDids]);
    this.offerRoom = offerRoom;
    this.questionBank = questionBank;
    this.asset = asset;
    this.amount = amount;
    this.now = now;
    this.minOfferGapMs = minOfferGapMs;
    this.state = null;
  }

  /* ------------------------------------------------------------ state --- */

  load() {
    if (this.state) return this.state;
    const empty = { offer: null, deal: null, spentKeys: [], completed: [], abandoned: [], lastOfferAt: 0 };
    try {
      this.state = { ...empty, ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Same posture as the payee lane: a corrupt file is a fault, not a
        // first run, and quietly starting over on top of a live lock would
        // leave a counterparty holding an offer nobody is watching.
        sayOnce('tclk-payer:state', `[tclk] payer state unreadable (${err.message}); starting empty`);
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

  /**
   * One step. A deal in flight always beats starting another one: the whole
   * point of this lane is finishing what it starts, and two open commitments
   * from one key is how the room filled up with dead offers in the first place.
   */
  async runTurn() {
    this.load();
    if (this.state.deal) return this.advanceDeal();
    if (this.state.offer) return this.watchForAccept();
    return this.postOffer();
  }

  /** Frames whose signed transport `from` matches the frame's own `from`. */
  #framesIn(messages) {
    const out = [];
    for (const m of messages || []) {
      const frame = decodeFrame(m.text ?? m.content ?? '');
      if (frame && frame.from === m.from) out.push({ frame, seq: m.seq });
    }
    return out;
  }

  async #post(room, frame, line = null) {
    let text;
    try {
      text = frame ? encodeFrame(frame) : line;
    } catch (err) {
      // encodeFrame refuses anything over the 4096-char message cap. A frame we
      // cannot encode is a bug in what we built, not a transport failure.
      sayOnce(`tclk-payer:encode:${frame?.type}`, `[tclk] payer could not encode ${frame?.type}: ${err.message}`);
      return false;
    }
    try {
      await this.client.postMessage(room, text, this.identity);
      return true;
    } catch (err) {
      sayOnce(`tclk-payer:post:${frame?.type || 'note'}`, `[tclk] payer post to ${room} failed: ${err.message}`);
      return false;
    }
  }

  /* -------------------------------------------------------- proposing --- */

  /**
   * The next question, as an offer.
   *
   * The task travels inline in `job.context` rather than behind a note path.
   * Both are seen in the wild — the first offer this project ever accepted put
   * its task in `/kv/tclk-job-02/deal-10650402` — but an inline task is one
   * fetch fewer for the counterparty and cannot rot between the offer and the
   * acceptance. The frame budget is checked before posting rather than assumed:
   * the patterns doc puts a populated offer near 420 characters against a cap
   * roughly ten times that, and a question that will not fit is trimmed at a
   * sentence boundary rather than silently truncated mid-word.
   */
  async postOffer() {
    const now = this.now();
    const since = now - (this.state.lastOfferAt || 0);
    if (since < this.minOfferGapMs) {
      return { action: 'offer_paced', waitMs: this.minOfferGapMs - since };
    }

    const spent = new Set(this.state.spentKeys || []);
    const question = this.questionBank.find((q) => !spent.has(q.key));
    if (!question) return { action: 'no_question_left' };

    const frame = this.#offerFrameFor(question, now);
    if (!frame) return { action: 'question_too_large', key: question.key };

    if (!(await this.#post(this.offerRoom, frame))) return { action: 'post_failed' };

    this.state.offer = { frame, key: question.key, postedAt: now };
    this.state.spentKeys = [...spent, question.key].slice(-200);
    this.state.lastOfferAt = now;
    this.save();
    return { action: 'offer_posted', id: frame.id, key: question.key, expiresMs: frame.expiresMs };
  }

  #offerFrameFor(question, now) {
    const title = String(question.title || '').replace(/\s+/g, ' ').trim();
    const body = String(question.body || '').replace(/\s+/g, ' ').trim();
    for (const context of contextCandidates(title, body)) {
      const fields = {
        amount: this.amount,
        asset: this.asset,
        claimByMs: now + OFFER_CLAIM_BY_MS,
        expiresMs: now + OFFER_EXPIRES_MS,
        from: this.identity.did,
        job: { context, id: jobRefFor(question.key), proto: 'tclk-inline' },
        lock: 'hash',
        nonce: randomNonce(),
        rails: ['paper'],
        refundAfterMs: now + OFFER_REFUND_AFTER_MS,
        role: 'payer'
      };
      // The id is the hash of the fields it travels with, so it is computed
      // last and never edited afterwards — a frame that lies about its own id
      // is what our own payee lane throws away.
      const frame = { type: 'offer', ...fields, id: offerId({ type: 'offer', ...fields }) };
      // encodeFrame throws above the 4096-char message cap, so the budget check
      // has to survive the throw rather than sit after it.
      // Our own offer is held to the rule we apply to strangers': a frame whose
      // claim window has already closed, or whose deadlines are the wrong way
      // round, is not an offer. Cheap here, and the only place a mistake in the
      // three constants above would ever show up before the room saw it.
      if (!validateDeadlines(frame, now).ok) return null;
      try {
        if (encodeFrame(frame).length <= MAX_FRAME_CHARS) return frame;
      } catch { /* too long: fall through to the shorter context */ }
    }
    return null;
  }

  /* --------------------------------------------------------- accepted --- */

  /**
   * Has anyone taken it? If not, has it gone stale?
   *
   * An acceptance is only ours to act on if it recomputes: the contract id
   * hashes the whole offer together with the five acceptance fields, so a
   * counterparty that altered any term produces a different contract, and one
   * that produces the same contract agreed to exactly what we posted.
   */
  async watchForAccept() {
    const now = this.now();
    const open = this.state.offer;

    let messages;
    try {
      ({ messages } = await this.client.readRoom(this.offerRoom, { limit: READ_LIMIT, format: 'json' }));
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const accept = this.#framesIn(messages)
      .map(({ frame }) => frame)
      .find((f) => f.type === 'accept'
        && f.ref === open.frame.id
        && !this.ours.has(f.from)            // never our own sibling key
        && isStatement(f.statement)
        && isContractId(f.contract)
        && f.contract === contractId(open.frame, {
          from: f.from, ref: f.ref, statement: f.statement, paymentKey: undefined, nonce: f.nonce
        }));

    if (!accept) {
      if (now >= open.frame.expiresMs) {
        /**
         * Dropped quietly, and deliberately not announced.
         *
         * `cancel` is a contract frame — decodeFrame requires a contract id on
         * every frame that is not an offer or an accept — and before anyone has
         * accepted there is no contract to name. A cancel frame without one
         * would be dropped by every conforming reader while still costing the
         * room a line, so `expiresMs` is left to do the job it is there for.
         */
        this.state.abandoned = [...(this.state.abandoned || []),
          { id: open.frame.id, key: open.key, postedAt: open.postedAt, closedAt: now, reason: 'expired unaccepted' }
        ].slice(-50);
        this.state.offer = null;
        this.save();
        return { action: 'offer_expired', id: open.frame.id };
      }
      return { action: 'waiting_for_accept', id: open.frame.id };
    }

    this.state.deal = {
      status: 'accepted',
      offer: open.frame,
      key: open.key,
      payee: accept.from,
      statement: accept.statement,
      contract: accept.contract,
      room: dealRoom(accept.contract),
      acceptedAt: now,
      lockedBytes: null
    };
    this.state.offer = null;
    this.save();
    return { action: 'offer_accepted_by', contract: accept.contract, payee: accept.from, room: this.state.deal.room };
  }

  /* -------------------------------------------------------- advancing --- */

  async advanceDeal() {
    const deal = this.state.deal;
    const now = this.now();
    if (deal.status === 'accepted') return this.#lock(deal, now);
    return this.#awaitReveal(deal, now);
  }

  /**
   * Escrow on the paper rail, then say so — in that order, and never the
   * reverse.
   *
   * The lock frame is a claim about the rail, and the payee is told by the spec
   * to check the rail rather than believe the frame. Posting the frame first
   * would make our own message the thing that was true earliest, which is
   * exactly the confusion the spec is warning about.
   *
   * `ifAbsent` is the rail's one-lock-per-contract rule. Losing that race means
   * something already wrote this contract's note, and the safe reading is that
   * this deal is not ours to fund.
   */
  async #lock(deal, now) {
    const record = encodePaperRecord({
      status: 'locked',
      lock: 'hash',
      statement: deal.statement,
      refundAfterMs: deal.offer.refundAfterMs
    });
    const { ns, key } = paperNote(deal.contract);
    try {
      await this.client.setKv(ns, key, record, { ifAbsent: true });
    } catch (err) {
      // A 409 means somebody else's bytes are already there; anything else is
      // the server having a bad minute, and both are "try again next cycle".
      return { action: 'lock_write_failed', contract: deal.contract, error: err.message };
    }

    // Read back what the rail now holds rather than trusting our own write:
    // the note is world-writable, and the bytes a refund must name are the
    // bytes that are actually there.
    const raw = await this.client.readNote(ns, key);
    const value = typeof raw === 'string' ? raw : (raw?.value ?? null);
    const back = decodePaperRecord(value);
    if (!back || back.status !== 'locked' || back.statement !== deal.statement) {
      return { action: 'lock_not_on_rail', contract: deal.contract, railRecord: back ? back.status : 'absent' };
    }

    const posted = await this.#post(deal.room, {
      type: 'lock', from: this.identity.did, contract: deal.contract,
      rail: 'paper', ref: `${ns}/${key}`
    });
    if (!posted) return { action: 'lock_announce_failed', contract: deal.contract };

    deal.status = 'locked';
    deal.lockedBytes = String(value).trim();
    deal.lockedAt = now;
    this.save();

    try {
      const pointer = statePointer(deal.contract);
      await this.client.setKv(pointer.ns, pointer.key, stateNoteValue('locked', `${ns}/${key}`));
    } catch { /* the pointer is a courtesy; the rail and the frames are the record */ }

    return { action: 'locked', contract: deal.contract, room: deal.room, payee: deal.payee };
  }

  /**
   * Wait for the reveal, or refund once the window opens.
   *
   * A reveal is only a reveal if the secret opens the statement we locked
   * against — the frame is otherwise just a string somebody posted into a room
   * anyone can write to. Where it does open, the deal is done from our side:
   * the claim on the rail is the payee's move, not ours.
   */
  async #awaitReveal(deal, now) {
    let messages;
    try {
      ({ messages } = await this.client.readRoom(deal.room, { limit: READ_LIMIT, format: 'json' }));
    } catch (err) {
      return { action: 'read_failed', error: err.message };
    }

    const reveal = this.#framesIn(messages)
      .map(({ frame }) => frame)
      .find((f) => f.type === 'reveal'
        && f.contract === deal.contract
        && f.from === deal.payee
        && opensStatement(f.secret, deal.statement));

    if (reveal) {
      /**
       * A receipt in words, not a frame.
       *
       * This is the one thing the payer side can add that neither the rail nor
       * the protocol records: the secret is a payment condition and says
       * nothing about whether the work arrived or was any good. The spec's
       * `receipt` type has no field for that judgement, and inventing keys on a
       * known frame type is exactly what the frame rules tell readers to
       * reject — so this goes on the tape as an ordinary line, which is
       * unambiguous and cannot be mistaken for a protocol commitment.
       */
      const delivered = this.#deliveryFor(messages, deal);
      await this.#post(deal.room, null,
        `tclk payer receipt | contract ${deal.contract.slice(0, 18)}… | secret opened the statement we locked | `
        + `work line from the payee on this tape: ${delivered ? 'yes' : 'none seen'} | `
        + 'settled on the paper rail, which holds no value');
      this.#close(deal, 'completed', delivered ? 'revealed with work on the tape' : 'revealed, no work line seen');
      return { action: 'deal_claimed_by_payee', contract: deal.contract, payee: deal.payee, delivered };
    }

    if (now < deal.offer.refundAfterMs) {
      return { action: 'waiting_for_reveal', contract: deal.contract, refundAfterMs: deal.offer.refundAfterMs };
    }

    // The refund branch. CAS against the exact bytes we locked, so a rail note
    // somebody else has since overwritten is left alone rather than stamped
    // over — winning a CAS does not move a coin, and losing one is information.
    const { ns, key } = paperNote(deal.contract);
    const refunded = encodePaperRecord({
      status: 'refunded', lock: 'hash', statement: deal.statement, refundAfterMs: deal.offer.refundAfterMs
    });
    try {
      await this.client.setKv(ns, key, refunded, { ifValue: deal.lockedBytes });
    } catch (err) {
      return { action: 'refund_refused', contract: deal.contract, error: err.message };
    }
    await this.#post(deal.room, {
      type: 'refund', from: this.identity.did, contract: deal.contract, rail: 'paper', ref: `${ns}/${key}`
    });
    this.#close(deal, 'abandoned', 'payee never revealed before refundAfterMs');
    return { action: 'refunded', contract: deal.contract, payee: deal.payee };
  }

  /** Did the payee write anything into the deal room that is not a tclk frame? */
  #deliveryFor(messages, deal) {
    return (messages || []).some((m) => m.from === deal.payee && !decodeFrame(m.text ?? m.content ?? ''));
  }

  #close(deal, bucket, reason) {
    this.state[bucket] = [...(this.state[bucket] || []), {
      contract: deal.contract, room: deal.room, payee: deal.payee, key: deal.key,
      acceptedAt: deal.acceptedAt, closedAt: this.now(), reason
    }].slice(-50);
    this.state.deal = null;
    this.save();
  }
}

/**
 * The task text, longest first, so a question is shortened only as far as the
 * frame budget actually requires.
 */
function contextCandidates(title, body) {
  const full = `${title} ${body}`.trim();
  const firstTwo = body.split(/(?<=\.)\s+/).slice(0, 2).join(' ').trim();
  return [full, `${title} ${firstTwo}`.trim(), title].filter(Boolean);
}

/** A stable, readable reference for the question behind an offer. */
function jobRefFor(key) {
  return `q-${String(key).replace(/[^a-z0-9-]/gi, '').slice(0, 28)}`;
}

/** Exposed for the status screen. The payer holds no secret, so this hides nothing. */
export function publicPayerView(state) {
  if (!state) return null;
  if (state.deal) {
    const { status, contract, room, payee, acceptedAt, offer } = state.deal;
    return { kind: 'deal', status, contract, room, payee, acceptedAt, refundAfterMs: offer?.refundAfterMs };
  }
  if (state.offer) {
    return { kind: 'offer', id: state.offer.frame.id, key: state.offer.key, expiresMs: state.offer.frame.expiresMs };
  }
  return { kind: 'idle', completed: (state.completed || []).length, abandoned: (state.abandoned || []).length };
}
