#!/usr/bin/env node
/**
 * close-1: find a stranger's open offer, check it, countersign it, and see it settle.
 *
 * Flop Labs' launch note (2026-09-25) says what close-1 is for: "whether
 * autonomous software can find a counterparty and settle a deal on its own".
 * That is this tool's whole ambition — a few small trades with keys that are
 * not ours, never a farm and never our own two keys on both sides. The score is
 * beside the point: the clawback removes every price edge, so a trade here is
 * worth its evidence, not its PnL.
 *
 * Signing. We never sign bytes a stranger wrote. An offer's terms are parsed,
 * every field is checked against the rules' shapes, and the string we sign is
 * rebuilt from those checked fields (sorted keys, no spaces, as the rules
 * specify); the maker's signature must verify over that same rebuilt string, so
 * a maker who signed anything else is refused. What we sign always starts
 * `close-1|accept|{`, which cannot be read as a technocore post (`room|nonce|`
 * needs a numeric nonce). See never-sign-text-we-did-not-choose.
 *
 *   node tools/close1-take.mjs            dry run: show the offer it would take
 *   node tools/close1-take.mjs --go       take one, if no earlier trade is unresolved
 *   node tools/close1-take.mjs --check    report every trade we posted and its outcome
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TechnocoreClient } from '../src/technocore-client.mjs';
import { signMessageBase64Url, verifyMessage } from '../src/identity.mjs';

export const SEASON = 'close-1';
export const REFEREE = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
const BASE = 'https://technocore.chat';
const ROOM = 'close1';
const STATE = path.resolve('data/local/close1-trades.json');
const IDENTITY = path.resolve('.secrets/scout-identity.json');
const SIBLING = path.resolve('.secrets/scribe-identity.json');

/** Never more than this many trades over the season, and each one small. */
export const MAX_TRADES = 3;
export const MAX_QTY = 10;
/** Only a price this close to the referee's reference: the clawback makes a far one pointless anyway. */
export const MAX_DRIFT = 0.005;

const TWO_PLACES = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
const TRADE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/** The terms as the rules define them, or null. Only these seven keys, only these shapes. */
export function checkedTerms(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const keys = Object.keys(t).sort().join(',');
  if (keys !== 'id,maker,px,qty,side,taker,until') return null;
  if (typeof t.id !== 'string' || !TRADE_ID.test(t.id)) return null;
  if (typeof t.maker !== 'string' || !DID.test(t.maker)) return null;
  if (typeof t.px !== 'string' || !TWO_PLACES.test(t.px) || !(Number(t.px) > 0)) return null;
  if (typeof t.qty !== 'string' || !TWO_PLACES.test(t.qty) || !(Number(t.qty) >= 0.1)) return null;
  if (t.side !== 'buy' && t.side !== 'sell') return null;
  if (t.taker !== 'any' && !(typeof t.taker === 'string' && DID.test(t.taker))) return null;
  if (!Number.isInteger(t.until)) return null;
  return { id: t.id, maker: t.maker, px: t.px, qty: t.qty, side: t.side, taker: t.taker, until: t.until };
}

/** Sorted keys, no spaces: checkedTerms already returns them in sorted order. */
export const termsText = (terms) => JSON.stringify(terms);
export const makerPayload = (terms) => `${SEASON}|terms|${termsText(terms)}`;
export const takerPayload = (terms, did) => `${SEASON}|accept|${termsText(terms)}|${did}`;

/** An open offer we may take, or the reason we may not. */
export function judgeOffer(msg, { ours, ref, nextSweep }) {
  let o;
  try { o = JSON.parse(msg.text); } catch { return { ok: false, why: 'not json' }; }
  if (o?.t !== 'offer' || o.season !== SEASON) return { ok: false, why: 'not an offer' };
  const terms = checkedTerms(o.terms);
  if (!terms) return { ok: false, why: 'shape' };
  if (msg.from !== terms.maker) return { ok: false, why: 'posted by someone other than the maker' };
  if (ours.has(terms.maker)) return { ok: false, why: 'ours' };
  if (terms.taker !== 'any') return { ok: false, why: 'named taker' };
  if (terms.until < nextSweep) return { ok: false, why: 'expires before the next sweep' };
  if (Number(terms.qty) > MAX_QTY) return { ok: false, why: 'too large' };
  if (Math.abs(Number(terms.px) / ref - 1) > MAX_DRIFT) return { ok: false, why: 'too far from the reference' };
  if (typeof o.maker_sig !== 'string') return { ok: false, why: 'unsigned' };
  let good = false;
  try { good = verifyMessage(makerPayload(terms), o.maker_sig, terms.maker); } catch { good = false; }
  if (!good) return { ok: false, why: 'maker signature does not verify over the terms' };
  return { ok: true, terms, makerSig: o.maker_sig, seq: msg.seq };
}

export function tradeText(terms, makerSig, did, takerSig) {
  return JSON.stringify({ t: 'trade', season: SEASON, terms, taker: did, maker_sig: makerSig, taker_sig: takerSig });
}

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function refereeLatest(room, limit = 3) {
  const j = await json(`${BASE}/r/${room}?limit=${limit}&format=json`);
  return (j.messages || []).filter((m) => m.from === REFEREE).map((m) => JSON.parse(m.text));
}

/** Follow `close1` for a while; its newest 200 records are only a few seconds of it. */
async function follow(ms) {
  const seen = new Map();
  let last = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const q = last === null ? '?limit=200&format=json' : `?since=${last}&limit=200&format=json`;
      const j = await json(`${BASE}/r/${ROOM}${q}`);
      for (const m of j.messages || []) seen.set(m.seq, m);
      if (j.messages?.length) last = j.messages.at(-1).seq;
    } catch { /* one missed read is a few seconds of offers, not a failure */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [...seen.values()].sort((a, b) => b.seq - a.seq);   // newest first
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { trades: [] }; }
}

/** Walk the referee's recent flow posts for each trade we posted. */
async function resolve(state) {
  const flows = (await json(`${BASE}/r/d-close1-flow?limit=200&format=json`)).messages
    .filter((m) => m.from === REFEREE).map((m) => JSON.parse(m.text));
  for (const t of state.trades) {
    if (t.outcome) continue;
    for (const f of flows) {
      if ((f.settled || []).includes(t.id)) { t.outcome = 'settled'; t.sweep = f.n; break; }
      const v = (f.void || []).find(([id]) => id === t.id);
      if (v) { t.outcome = `void: ${v[1]}`; t.sweep = f.n; break; }
    }
  }
  return state;
}

async function main() {
  const go = process.argv.includes('--go');
  const checkOnly = process.argv.includes('--check');
  const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
  const ours = new Set([identity.did]);
  try { ours.add(JSON.parse(fs.readFileSync(SIBLING, 'utf8')).did); } catch { /* no sibling key here */ }

  const state = await resolve(loadState());
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  for (const t of state.trades) {
    console.log(`${t.postedAt}  ${t.id}  ${t.ourSide} ${t.qty} @ ${t.px} with …${t.maker.slice(-8)}  -> ${t.outcome ?? 'not in the referee flow yet'}${t.sweep ? ` (sweep ${t.sweep})` : ''}`);
  }
  if (checkOnly) return;

  const settled = state.trades.filter((t) => t.outcome === 'settled').length;
  if (settled >= MAX_TRADES) { console.log(`${settled} trades settled; that is enough.`); return; }
  const pending = state.trades.find((t) => !t.outcome);
  if (pending && go) { console.log(`waiting on ${pending.id} before taking another`); return; }

  const [price] = (await refereeLatest('d-close1-price')).slice(-1);
  if (!price?.ref?.px) throw new Error('no reference price from the referee');
  const ref = Number(price.ref.px);
  const nextSweep = price.for ?? price.n + 1;
  console.log(`reference ${price.ref.px} for sweep ${nextSweep}`);

  const msgs = await follow(20_000);
  /**
   * A maker whose trade with us voided on `funds` has spent its account, and
   * says nothing about us: the fold checks `not_owner` first, so reaching
   * `funds` proves both keys are minted owners. Our first take (2026-09-26,
   * 0.10 contract, ~22 POLF against our 10,000) voided exactly that way.
   */
  const broke = new Set(state.trades.filter((t) => t.outcome === 'void: funds').map((t) => t.maker));
  const judged = msgs.map((m) => {
    const j = judgeOffer(m, { ours, ref, nextSweep });
    return j.ok && broke.has(j.terms.maker) ? { ok: false, why: 'maker ran out of funds before' } : j;
  });
  const offers = judged.filter((j) => j.ok);
  const reasons = {};
  for (const j of judged) if (!j.ok && j.why !== 'not an offer' && j.why !== 'not json') reasons[j.why] = (reasons[j.why] || 0) + 1;
  console.log(`${msgs.length} records, ${offers.length} takeable offers; refused: ${JSON.stringify(reasons)}`);
  if (!offers.length) return;

  // Smallest first, then the newest: least at stake, and least likely already taken.
  offers.sort((a, b) => Number(a.terms.qty) - Number(b.terms.qty) || b.seq - a.seq);
  const pick = offers[0];
  const ourSide = pick.terms.side === 'buy' ? 'sell' : 'buy';
  console.log(`would take ${pick.terms.id}: we ${ourSide} ${pick.terms.qty} @ ${pick.terms.px} from …${pick.terms.maker.slice(-8)}`);
  if (!go) { console.log('dry run; nothing signed or posted'); return; }

  const takerSig = signMessageBase64Url(takerPayload(pick.terms, identity.did), identity.privateKeyPem);
  const text = tradeText(pick.terms, pick.makerSig, identity.did, takerSig);
  const client = new TechnocoreClient({ evidenceDir: path.resolve('data/local/evidence') });
  const res = await client.postSignedMessage(ROOM, text, identity);
  const line = String(res.raw).split('\n').find((l) => l.includes(pick.terms.id));
  state.trades.push({
    id: pick.terms.id, maker: pick.terms.maker, ourSide, qty: pick.terms.qty, px: pick.terms.px,
    until: pick.terms.until, postedAt: new Date().toISOString(),
    seq: Number(line?.match(/^\[(\d+)\]/)?.[1]) || null
  });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`posted; the referee settles it at sweep ${nextSweep} or voids it with a reason`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
