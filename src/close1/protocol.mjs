/**
 * close-1 wire protocol: the shapes the frozen rules define, and nothing else.
 *
 * These are PROTOCOL facts from close-call-game.md at package bae09812…:
 * terms carry exactly seven keys, amounts are decimal strings with at most two
 * decimals, a trade is at least 0.1 contracts, a price settles only within 5 %
 * of the previous sweep's reference. There is no protocol maximum quantity —
 * any cap on size is OUR policy and lives in risk-gate.mjs, not here.
 *
 * Every text we sign or post is built here from checked fields, never copied
 * from bytes a stranger wrote (see never-sign-text-we-did-not-choose).
 */
import { verifyMessage } from '../identity.mjs';

export const SEASON = 'close-1';
export const MIN_QTY = 0.1;
export const LIMIT_WINDOW = 0.05;
export const FEE_RATE = 0.01;
export const MINT = 10_000;

export const TWO_PLACES = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
export const TRADE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The fold's own pattern: z6Mk plus exactly 44 base58 characters. */
export const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
/** Ed25519 signature, base64url without padding: always 86 characters. */
export const SIG = /^[A-Za-z0-9_-]{86}$/;

/** The terms as the rules define them, or null. Only these seven keys, only these shapes. */
export function checkedTerms(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const keys = Object.keys(t).sort().join(',');
  if (keys !== 'id,maker,px,qty,side,taker,until') return null;
  if (typeof t.id !== 'string' || !TRADE_ID.test(t.id)) return null;
  if (typeof t.maker !== 'string' || !DID.test(t.maker)) return null;
  if (typeof t.px !== 'string' || !TWO_PLACES.test(t.px) || !(Number(t.px) > 0)) return null;
  if (typeof t.qty !== 'string' || !TWO_PLACES.test(t.qty) || !(Number(t.qty) >= MIN_QTY)) return null;
  if (t.side !== 'buy' && t.side !== 'sell') return null;
  if (t.taker !== 'any' && !(typeof t.taker === 'string' && DID.test(t.taker))) return null;
  if (!Number.isInteger(t.until)) return null;
  return { id: t.id, maker: t.maker, px: t.px, qty: t.qty, side: t.side, taker: t.taker, until: t.until };
}

/** Sorted keys, no spaces: checkedTerms already returns them in sorted order. */
export const termsText = (terms) => JSON.stringify(terms);
export const makerPayload = (terms) => `${SEASON}|terms|${termsText(terms)}`;
export const takerPayload = (terms, did) => `${SEASON}|accept|${termsText(terms)}|${did}`;
/** What technocore.chat's did:key lane signs for a post: `<room>|<nonce>|<text>`. */
export const envelopePayload = (room, nonce, text) => `${room}|${nonce}|${text}`;

export function safeVerify(payload, sig, did) {
  if (typeof sig !== 'string' || !SIG.test(sig) || typeof did !== 'string' || !DID.test(did)) return false;
  try { return verifyMessage(payload, sig, did); } catch { return false; }
}

export const ownerText = (did) => JSON.stringify({ t: 'owner', season: SEASON, key: did });
export const offerText = (terms, makerSig) => JSON.stringify({ t: 'offer', season: SEASON, terms, maker_sig: makerSig });
export function tradeText(terms, makerSig, did, takerSig) {
  return JSON.stringify({ t: 'trade', season: SEASON, terms, taker: did, maker_sig: makerSig, taker_sig: takerSig });
}

/**
 * A trade message reduced to checked fields, with both signatures verified the
 * rules' way, or the reason it is not one. The result is enough to rebuild the
 * text ourselves with tradeText — the bytes we post are never the sender's.
 */
export function checkedTrade(obj) {
  if (!obj || obj.t !== 'trade' || obj.season !== SEASON) return { ok: false, why: 'not a trade' };
  const terms = checkedTerms(obj.terms);
  if (!terms) return { ok: false, why: 'shape' };
  if (typeof obj.taker !== 'string' || !DID.test(obj.taker)) return { ok: false, why: 'taker shape' };
  if (terms.taker !== 'any' && terms.taker !== obj.taker) return { ok: false, why: 'named taker mismatch' };
  if (!safeVerify(makerPayload(terms), obj.maker_sig, terms.maker)) return { ok: false, why: 'maker signature invalid' };
  if (!safeVerify(takerPayload(terms, obj.taker), obj.taker_sig, obj.taker)) return { ok: false, why: 'taker signature invalid' };
  return { ok: true, terms, taker: obj.taker, makerSig: obj.maker_sig, takerSig: obj.taker_sig };
}

/** Sweep n closes at 2026-09-25 12:05Z + (n−1)·5 min (contest.json first_sweep, sweep_seconds). */
export const SWEEP0_MS = Date.UTC(2026, 8, 25, 12, 5);
export const SWEEP_MS = 300_000;
export const sweepTime = (n, cfg = null) => (cfg?.firstSweepMs ?? SWEEP0_MS) + (n - 1) * (cfg?.sweepMs ?? SWEEP_MS);
/**
 * The sweep that applies a message stamped at `ms`: the first sweep whose
 * close is at or after the stamp. The referee posts a few seconds after the
 * clock, so a stamp in those seconds may belong to the next one; callers that
 * need certainty accept either.
 */
export function sweepFor(ms, cfg = null) {
  const first = cfg?.firstSweepMs ?? SWEEP0_MS;
  const step = cfg?.sweepMs ?? SWEEP_MS;
  return Math.max(1, Math.ceil((ms - first) / step) + 1);
}
