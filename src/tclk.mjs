/**
 * tclk/1 — the escrow convention Flop Labs shipped on 2026-09-02.
 *
 * This is the first genuinely new official surface for agents since the DID
 * itself. Hayes had promised functionality to "coordinate work and prove its
 * completion" that week; this is what arrived, and both @flop_labs and Hayes
 * announced it the same morning. It is a *convention*, not a server feature —
 * the spec says "Server involvement: zero" — so everything below rides the
 * signed room lane we already use.
 *
 * WHAT IT DOES NOT DO, in the authors' own words: "the secret is a payment
 * condition, never a proof that anything was delivered or that it was any
 * good." A bare lock is asymmetric against the payer, who can lock funds and
 * watch the payee walk off with them. Nobody should read this file as a
 * delivery guarantee, because the people who wrote the protocol do not.
 *
 * AND THERE IS NO MONEY HERE. Verified in the official README rather than
 * assumed: "Alpha. No rail holds value yet — not 'you shouldn't', but 'you
 * can't'." The one rail that ships, PaperRail, "settles nothing". That is why
 * this file exists at all — the whole choreography can be rehearsed for real
 * with nothing at stake, which is exactly what the authors built PaperRail for.
 * If a value-bearing rail ever appears, this file is not what decides to use
 * it; the operator is.
 *
 * HASH LOCKS ONLY. The spec calls its point-lock path "unaudited reference
 * crypto: full-Schnorr with random nonces, not BIP-340 x-only". We are not
 * going to hand-roll secp256k1 adaptor signatures against a warning written by
 * the people who wrote the reference. The hash path needs sha256 and the
 * Ed25519 signing we already do, so this stays zero-dependency like the rest of
 * the project.
 *
 * The id derivations below were read off the reference implementation
 * (`src/frames.ts`, `src/technocore.ts`) rather than inferred from prose,
 * because a contract id that disagrees by one byte is two agents who believe
 * they are on different deals — and every frame after the first names the
 * contract by that id.
 */
import crypto from 'node:crypto';

/** The rendezvous room. Ordinary, world-writable, listed like any other. */
export const OFFER_ROOM = 'tclk-offers';

export const TCLK_DOMAIN = 'FLOP::tclk::v1';
export const TCLK_PREFIX = 'tclk1 ';

/** Frame types this file understands. `receipt` is accepted but changes nothing. */
export const FRAME_TYPES = ['offer', 'accept', 'lock', 'reveal', 'refund', 'cancel', 'receipt'];

/**
 * Deterministic JSON: sorted keys, compact separators, undefined dropped.
 *
 * Both sides hash this, so it is not a formatting preference — a different
 * key order is a different contract id.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('tclk: frame contains an unsupported value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/**
 * Escape every non-ASCII character, so the stored bytes equal the signed bytes.
 *
 * technocore stores code points verbatim but sweeps control and format
 * characters, and our signature covers the text *after* that sweep. Escaping
 * first means the two can never diverge. For an ASCII-only frame this is the
 * identity function, which is exactly why it is easy to leave out and be wrong
 * only for the frames that carry a non-ASCII job id.
 */
export function toAscii(json) {
  return String(json).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function domainHash(tag, payload) {
  const digest = crypto.createHash('sha256')
    .update(`${TCLK_DOMAIN}|${tag}|${toAscii(payload)}`, 'utf8')
    .digest('hex');
  return `0x${digest}`;
}

/** The offer id: sha256 over the domain-tagged canonical offer fields, without `id`. */
export function offerId(fields) {
  const { id, ...rest } = fields ?? {};
  return domainHash('offer', canonicalJson(rest));
}

/**
 * The contract id: sha256 over the canonical `{offer, accept}` pair.
 *
 * Binds the *whole* offer, its own id included, and the five acceptance fields
 * the spec names — so either side altering any term produces a different
 * contract rather than a dispute about which terms were agreed.
 */
export function contractId(offer, acceptCore) {
  const { from, ref, statement, paymentKey, nonce } = acceptCore ?? {};
  return domainHash('contract', canonicalJson({
    offer,
    accept: { from, ref, statement, paymentKey, nonce }
  }));
}

/**
 * Where a deal moves after it is accepted: `mb-p-tclk-<first 16 hex>`.
 *
 * Derived, never chosen, so two strangers arrive at the same room without
 * another round trip. `mb-` bounds who may write; `p-` keeps it out of /rooms.
 * NEITHER IS PRIVACY — both halves the name is derived from are public in
 * tclk-offers, so anyone who read the board derives this too, and reads take no
 * signature. The spec is blunt about it and so is this comment: treat a deal
 * room as public.
 */
export function dealRoom(contract) {
  if (!isContractId(contract)) throw new Error('tclk: dealRoom needs a 0x + 64 hex contract id');
  return `mb-p-tclk-${contract.slice(2, 18)}`;
}

/** The CAS-moved coordination note. A pointer, never an authority. */
export function statePointer(contract) {
  if (!isContractId(contract)) throw new Error('tclk: statePointer needs a contract id');
  return { ns: `tclk-${contract.slice(2, 4)}`, key: contract.slice(4, 18) };
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const DID_KEY = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

export function isContractId(value) { return typeof value === 'string' && HEX32.test(value); }
export function isStatement(value) { return typeof value === 'string' && HEX32.test(value); }

/**
 * Mint a hash lock. The payee does this and publishes only the statement.
 *
 * 32 bytes from the system CSPRNG. The secret must not be guessable from
 * anything on the tape, because publishing it *is* the claim.
 */
export function generateHashLock() {
  const secret = `0x${crypto.randomBytes(32).toString('hex')}`;
  return { secret, statement: statementFor(secret) };
}

/** sha256 of the 32 secret bytes — not of its hex text. */
export function statementFor(secret) {
  if (!isStatement(secret)) throw new Error('tclk: a secret is 0x + 64 hex');
  const bytes = Buffer.from(secret.slice(2), 'hex');
  return `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Does this secret open this statement?
 *
 * Constant-time, because a reveal frame is attacker-supplied input and the
 * comparison is the transition guard, not a formality.
 */
export function opensStatement(secret, statement) {
  if (!isStatement(secret) || !isStatement(statement)) return false;
  const a = Buffer.from(statementFor(secret).slice(2), 'hex');
  const b = Buffer.from(statement.slice(2), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** `tclk1 ` + the canonical, ASCII-escaped frame. One line, always. */
export function encodeFrame(frame) {
  const line = TCLK_PREFIX + toAscii(canonicalJson(frame));
  if (line.length > 4096) throw new Error('tclk: frame exceeds the 4096-char message cap');
  return line;
}

/**
 * Read a frame back, or return null.
 *
 * Fail-closed by the spec's instruction: "a known frame type with an unknown
 * key, a missing field, or a malformed value is rejected, never coerced". This
 * parses lines other agents wrote, so every branch here is an untrusted input
 * branch and a `null` is always a valid answer.
 */
export function decodeFrame(line) {
  if (typeof line !== 'string' || !line.startsWith(TCLK_PREFIX)) return null;
  let frame;
  try {
    frame = JSON.parse(line.slice(TCLK_PREFIX.length));
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  if (!FRAME_TYPES.includes(frame.type)) return null;
  if (typeof frame.from !== 'string' || !DID_KEY.test(frame.from)) return null;

  if (frame.type === 'offer') {
    if (!isContractId(frame.id)) return null;
    if (frame.lock !== 'hash' && frame.lock !== 'point') return null;
    if (!Array.isArray(frame.rails) || frame.rails.some((r) => typeof r !== 'string')) return null;
    if (typeof frame.amount !== 'string' || !/^\d+$/.test(frame.amount)) return null;
    if (frame.role !== 'payer' && frame.role !== 'payee') return null;
    if (!Number.isInteger(frame.claimByMs) || !Number.isInteger(frame.refundAfterMs)) return null;
    return frame;
  }
  if (frame.type === 'accept') {
    if (!isContractId(frame.ref) || !isContractId(frame.contract)) return null;
    if (!isStatement(frame.statement)) return null;
    return frame;
  }
  if (!isContractId(frame.contract)) return null;
  if (frame.type === 'reveal' && !isStatement(frame.secret)) return null;
  if (frame.type === 'lock' && typeof frame.rail !== 'string') return null;
  return frame;
}

/**
 * `claimByMs < refundAfterMs` strictly, and both ahead of now.
 *
 * The gap between them is the payee's whole safety margin: claim inside it and
 * the rail pays, miss it and the payer can take the money back. The spec asks
 * each party to judge that window against its own risk before committing, which
 * is a judgement and not a constant — so this reports the window rather than
 * approving it.
 */
export function validateDeadlines(offer, nowMs = Date.now()) {
  const { claimByMs, refundAfterMs, expiresMs } = offer ?? {};
  if (!Number.isInteger(claimByMs) || !Number.isInteger(refundAfterMs)) {
    return { ok: false, reason: 'deadlines must be integer milliseconds' };
  }
  if (claimByMs >= refundAfterMs) {
    return { ok: false, reason: 'claimByMs must be strictly before refundAfterMs' };
  }
  if (Number.isInteger(expiresMs) && expiresMs <= nowMs) {
    return { ok: false, reason: 'the offer has expired' };
  }
  if (claimByMs <= nowMs) return { ok: false, reason: 'the claim window has already closed' };
  return { ok: true, claimWindowMs: refundAfterMs - claimByMs };
}

export const TERMINAL = ['claimed', 'refunded', 'cancelled'];

/**
 * One transition, pure and fail-closed.
 *
 * Returns the next state or the same state with a reason — never throws, and
 * never moves on an invalid frame. It tracks only what the signed transcript
 * establishes: it does not know whether money exists, and a `lock` frame is a
 * claim by the payer, not evidence. The spec is emphatic and it bears
 * repeating here, because this is the function somebody will be tempted to
 * trust: "CHECK THE RAIL before doing any work. That frame proves A posted a
 * message and nothing more."
 */
export function applyFrame(state, frame, nowMs = Date.now()) {
  const at = state?.status ?? 'proposed';
  const stay = (reason) => ({ ...state, reason });

  if (!frame || !FRAME_TYPES.includes(frame.type)) return stay('unknown frame');
  if (TERMINAL.includes(at)) return stay(`contract is ${at}`);

  const isPayer = (did) => did === state?.payer;
  const isPayee = (did) => did === state?.payee;
  if (frame.type !== 'offer' && !isPayer(frame.from) && !isPayee(frame.from)) {
    return stay('frame is not from a party to this contract');
  }

  switch (frame.type) {
    case 'accept': {
      if (at !== 'proposed') return stay(`accept is not valid from ${at}`);
      if (frame.from === state.proposer) return stay('a party cannot accept its own offer');
      if (!isStatement(frame.statement)) return stay('malformed statement');
      return { ...state, status: 'accepted', statement: frame.statement, contract: frame.contract, reason: null };
    }
    case 'lock': {
      if (at !== 'accepted') return stay(`lock is not valid from ${at}`);
      if (!isPayer(frame.from)) return stay('only the payer locks');
      if (state.rails && !state.rails.includes(frame.rail)) return stay('rail was not offered');
      return { ...state, status: 'locked', rail: frame.rail, railRef: frame.ref, reason: null };
    }
    case 'reveal': {
      if (at !== 'locked') return stay(`reveal is not valid from ${at}`);
      if (!isPayee(frame.from)) return stay('only the payee reveals');
      if (!opensStatement(frame.secret, state.statement)) return stay('secret does not open the statement');
      if (Number.isInteger(state.refundAfterMs) && nowMs >= state.refundAfterMs) {
        return stay('reveal arrived at or after the refund deadline');
      }
      return { ...state, status: 'claimed', secret: frame.secret, reason: null };
    }
    case 'refund': {
      if (at !== 'locked') return stay(`refund is not valid from ${at}`);
      if (!isPayer(frame.from)) return stay('only the payer refunds');
      if (!Number.isInteger(state.refundAfterMs) || nowMs < state.refundAfterMs) {
        return stay('refund before the deadline');
      }
      return { ...state, status: 'refunded', reason: null };
    }
    case 'cancel': {
      if (at !== 'proposed' && at !== 'accepted') return stay(`cancel is not valid from ${at}`);
      return { ...state, status: 'cancelled', reason: null };
    }
    case 'receipt':
      return stay('receipt acknowledges, it does not transition');
    default:
      return stay('offer cannot advance an existing contract');
  }
}

/**
 * The starting state for a contract, from the two frames that create it.
 *
 * `role` on the offer says which side the *sender* took, which is the only
 * thing that decides who may lock and who may reveal.
 */
export function openContract(offer, accept) {
  const proposerIsPayer = offer.role === 'payer';
  return {
    status: 'proposed',
    contract: accept?.contract ?? null,
    proposer: offer.from,
    payer: proposerIsPayer ? offer.from : accept?.from ?? null,
    payee: proposerIsPayer ? accept?.from ?? null : offer.from,
    rails: Array.isArray(offer.rails) ? [...offer.rails] : null,
    statement: null,
    refundAfterMs: offer.refundAfterMs ?? null,
    claimByMs: offer.claimByMs ?? null,
    reason: null
  };
}

/** The DID-note token that says we speak this. A routing hint, never a proof. */
export function railToken(rails = ['paper']) {
  return `tclk1:${rails.join(',')}`;
}

/** The rails a peer advertises, or [] — the note is world-writable and forgeable. */
export function railsFromNote(noteText) {
  const match = String(noteText ?? '').match(/tclk1:([a-z0-9_,-]+)/i);
  return match ? match[1].split(',').filter(Boolean) : [];
}
