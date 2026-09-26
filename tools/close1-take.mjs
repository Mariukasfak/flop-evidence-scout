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
 *   node tools/close1-take.mjs --make     dry run of posting our own open offer (--make --go posts it)
 */
import crypto from 'node:crypto';
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

/**
 * The first takeable offer seen while it is still fresh, and not yet taken.
 *
 * Our first race (2026-09-26) picked from a 20-second window and voided as
 * `settled`: someone countersigned first. An open offer here is taken within
 * seconds, so this follows the room and acts on an offer at most FRESH_MS older
 * than the newest record of the same read, skipping any id already seen in a
 * trade.
 */
const FRESH_MS = 3_000;
/**
 * A maker who has offered more than an account holds cannot fill them all.
 * Measured 2026-09-26 over 90 s of close1: seven makers posted open offers, one
 * of them 28,064 POLF across nine against a 10,000 mint; our takes from two
 * others both voided on `funds`. So the room is watched before anything is
 * taken, and a maker whose offers seen so far exceed this is passed over.
 */
const WARM_MS = 45_000;
const MAX_MAKER_OFFERED = 9_000;
async function firstFreshOffer(judge, ms) {
  let last = null;
  const taken = new Set();
  const offered = new Map();
  const refused = {};
  const warmUntil = Date.now() + WARM_MS;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let batch = [];
    try {
      const q = last === null ? '?limit=200&format=json' : `?since=${last}&limit=200&format=json`;
      batch = (await json(`${BASE}/r/${ROOM}${q}`)).messages || [];
      if (batch.length) last = batch.at(-1).seq;
    } catch { /* a missed read is a second of offers */ }
    for (const m of batch) {
      try {
        const o = JSON.parse(m.text);
        if (o?.t === 'trade' && o.terms?.id) taken.add(o.terms.id);
        if (o?.t === 'offer' && typeof o.terms?.maker === 'string') {
          offered.set(o.terms.maker, (offered.get(o.terms.maker) || 0) + Number(o.terms.qty) * Number(o.terms.px) || 0);
        }
      } catch { /* chatter */ }
    }
    if (Date.now() < warmUntil) { await new Promise((r) => setTimeout(r, 700)); continue; }
    const newest = Math.max(...batch.map((m) => Date.parse(m.ts)).filter(Number.isFinite), 0);
    for (const m of [...batch].reverse()) {
      if (newest - Date.parse(m.ts) > FRESH_MS) break;
      const j = judge(m);
      if (!j.ok) { if (j.why !== 'not an offer' && j.why !== 'not json') refused[j.why] = (refused[j.why] || 0) + 1; continue; }
      if (taken.has(j.terms.id)) continue;
      if ((offered.get(j.terms.maker) || 0) > MAX_MAKER_OFFERED) { refused['maker over-offered'] = (refused['maker over-offered'] || 0) + 1; continue; }
      return j;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(`refused: ${JSON.stringify(refused)}`);
  return null;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { trades: [] }; }
}

/** Walk the referee's recent flow posts for each trade we posted. */
async function resolve(state, currentSweep = null) {
  const flows = (await json(`${BASE}/r/d-close1-flow?limit=200&format=json`)).messages
    .filter((m) => m.from === REFEREE).map((m) => JSON.parse(m.text));
  for (const t of state.trades) {
    if (t.outcome) continue;
    for (const f of flows) {
      if ((f.settled || []).includes(t.id)) { t.outcome = 'settled'; t.sweep = f.n; break; }
      const v = (f.void || []).find(([id]) => id === t.id);
      if (v) { t.outcome = `void: ${v[1]}`; t.sweep = f.n; break; }
    }
    // An offer of ours nobody took never reaches the flow at all.
    if (!t.outcome && t.role === 'maker' && currentSweep !== null && currentSweep > t.until + 1) {
      const good = (t.takers || []).filter((k) => k.valid);
      t.outcome = good.length ? 'unlisted'
        : (t.takers || []).length ? 'taken only with a bad signature' : 'untaken';
    }
    /**
     * A take that is in neither list once its window is over. The flow post
     * names only some settlements — measured 2026-09-26 it omitted 711-896 of
     * them a sweep while voids were nearly all listed — so this is most likely
     * settled, but it is not proof, and is not counted as one.
     */
    if (!t.outcome && t.role !== 'maker' && currentSweep !== null && currentSweep > t.until + 1) t.outcome = 'unlisted';
  }
  return state;
}

async function main() {
  const go = process.argv.includes('--go');
  const checkOnly = process.argv.includes('--check');
  const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
  const ours = new Set([identity.did]);
  try { ours.add(JSON.parse(fs.readFileSync(SIBLING, 'utf8')).did); } catch { /* no sibling key here */ }

  const make = process.argv.includes('--make');
  const [price] = (await refereeLatest('d-close1-price')).slice(-1);
  if (!price?.ref?.px) throw new Error('no reference price from the referee');
  const ref = Number(price.ref.px);
  const nextSweep = price.for ?? price.n + 1;

  const state = await resolve(loadState(), price.n);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  for (const t of state.trades) {
    console.log(`${t.postedAt}  ${t.role === 'maker' ? 'offer ' : ''}${t.id}  ${t.ourSide} ${t.qty} @ ${t.px} with …${t.maker.slice(-8)}  -> ${t.outcome ?? 'not in the referee flow yet'}${t.sweep ? ` (sweep ${t.sweep})` : ''}`);
  }
  if (checkOnly) return;

  const settled = state.trades.filter((t) => t.outcome === 'settled').length;
  if (settled >= MAX_TRADES) { console.log(`${settled} trades settled; that is enough.`); return; }
  const pending = state.trades.find((t) => !t.outcome);
  if (pending && (go || make)) { console.log(`waiting on ${pending.id} before another`); return; }
  console.log(`reference ${price.ref.px} for sweep ${nextSweep}`);

  if (make) return makeOffer({ identity, state, price, nextSweep });

  /**
   * A maker whose trade with us voided on `funds` has spent its account, and
   * says nothing about us: the fold checks `not_owner` first, so reaching
   * `funds` proves both keys are minted owners. Our first take (2026-09-26,
   * 0.10 contract, ~22 POLF against our 10,000) voided exactly that way.
   */
  const broke = new Set(state.trades.filter((t) => t.outcome === 'void: funds').map((t) => t.maker));
  const judge = (m) => {
    const j = judgeOffer(m, { ours, ref, nextSweep });
    return j.ok && broke.has(j.terms.maker) ? { ok: false, why: 'maker ran out of funds before' } : j;
  };
  const pick = await firstFreshOffer(judge, 120_000);
  if (!pick) { console.log('no fresh takeable offer in two minutes'); return; }
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

/**
 * Be the maker instead: post our own open offer at the reference and let
 * whoever wants it countersign. Taking an open offer is a race — our second
 * try (2026-09-26) voided as `settled`, somebody faster had countersigned — and
 * a maker races nobody. The terms are ours end to end, so is every byte signed.
 */
export function makerTerms({ did, px, side, until, id }) {
  return checkedTerms({ id, maker: did, px: Number(px).toFixed(2), qty: '0.50', side, taker: 'any', until });
}

async function makeOffer({ identity, state, price, nextSweep }) {
  const net = state.trades.filter((t) => t.outcome === 'settled')
    .reduce((n, t) => n + (t.ourSide === 'buy' ? 1 : -1) * Number(t.qty), 0);
  const side = net > 0 ? 'sell' : 'buy';          // lean back toward flat
  const id = `mfk-${crypto.randomBytes(5).toString('hex')}`;
  /**
   * A shade better than the reference for whoever takes it, open for half an
   * hour. At the bare reference for three sweeps (2026-09-26) nobody took it;
   * 0.2 % on half a contract is under half a POLF, and the clawback means a
   * taker who is paid it back at the close gains nothing unfair from it.
   */
  const px = Number(price.ref.px) * (side === 'buy' ? 1.002 : 0.998);
  const terms = makerTerms({ did: identity.did, px, side, until: nextSweep + 6, id });
  if (!terms) throw new Error('our own terms failed the shape check');
  const makerSig = signMessageBase64Url(makerPayload(terms), identity.privateKeyPem);
  const text = JSON.stringify({ t: 'offer', season: SEASON, terms, maker_sig: makerSig });
  if (!process.argv.includes('--go')) { console.log(`would post: ${text}`); console.log('dry run; add --go to post'); return; }
  const client = new TechnocoreClient({ evidenceDir: path.resolve('data/local/evidence') });
  const res = await client.postSignedMessage(ROOM, text, identity);
  const line = String(res.raw).split('\n').find((l) => l.includes(id));
  state.trades.push({
    role: 'maker', id, maker: identity.did, ourSide: side, qty: terms.qty, px: terms.px, until: terms.until,
    postedAt: new Date().toISOString(), seq: Number(line?.match(/^\[(\d+)\]/)?.[1]) || null
  });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`offered: we ${side} ${terms.qty} @ ${terms.px}, open to anyone through sweep ${terms.until}`);

  /**
   * Watch who takes it, and check their countersignature ourselves.
   *
   * Our first taken offer (2026-09-26, mfk-e233c29e72) was countersigned in
   * 1.3 s by a key that signs `close-1|accept|<terms>|<maker_sig>` instead of
   * the rules' `…|<taker did:key>` — 3 of its 3 trades that minute, against
   * 364 of 402 trades that followed the rules. The referee drops what does not
   * verify without listing it, so only our own check can tell the two apart.
   */
  const takers = [];
  let last = res.raw ? Number(line?.match(/^\[(\d+)\]/)?.[1]) || null : null;
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end) {
    try {
      const q = last === null ? '?limit=200&format=json' : `?since=${last}&limit=200&format=json`;
      const batch = (await json(`${BASE}/r/${ROOM}${q}`)).messages || [];
      if (batch.length) last = batch.at(-1).seq;
      for (const m of batch) {
        let o; try { o = JSON.parse(m.text); } catch { continue; }
        if (o?.t !== 'trade' || o.terms?.id !== id || typeof o.taker !== 'string') continue;
        let valid = false;
        try { valid = verifyMessage(takerPayload(terms, o.taker), o.taker_sig, o.taker) && m.from === o.taker; } catch { valid = false; }
        takers.push({ did: o.taker, seq: m.seq, ts: m.ts, valid });
        console.log(`taken by …${o.taker.slice(-8)} at seq ${m.seq}: countersignature ${valid ? 'valid' : 'INVALID'}`);
      }
      if (takers.some((k) => k.valid)) break;
    } catch { /* one missed read */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  state.trades.at(-1).takers = takers;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  if (!takers.length) console.log('nobody took it in ten minutes');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
