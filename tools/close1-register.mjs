#!/usr/bin/env node
/**
 * Register the Scout key as a close-1 owner, once, and say whether it took.
 *
 * close-1 (flop-labs/technocore-close-call-challenge, opened 2026-09-25 12:00Z)
 * registers an owner with one signed line in `close1`:
 *   {"t":"owner","season":"close-1","key":"<did:key>"}
 * and mints it 10,000 POLF at the next five-minute sweep. The text is ours and
 * fixed by the rules, so this signs nothing a stranger chose.
 *
 * One key only, the one that already carries our public record — the rules
 * allow many, and our own standing upstream is the case against ballot blocs.
 *
 * The room runs ~3,600 registrations a minute, so the newest 200 records are
 * about three seconds of it: the post's own answer and the evidence archive are
 * the proof it landed, not a later read of the room. The referee's flow post
 * lists a few mints per sweep and counts the rest as omitted, so a missing name
 * there is not a refusal.
 *
 *   node tools/close1-register.mjs            register if not yet, then check
 *   node tools/close1-register.mjs --check    only report
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const ROOM = 'close1';
const REFEREE = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
const STATE = path.resolve('data/local/close1-registration.json');
const IDENTITY = path.resolve('.secrets/scout-identity.json');

export function ownerText(did) {
  return JSON.stringify({ t: 'owner', season: 'close-1', key: did });
}

async function referee(room, limit = 12) {
  const r = await fetch(`https://technocore.chat/r/${room}?limit=${limit}&format=json`);
  const j = await r.json();
  return (j.messages || []).filter((m) => m.from === REFEREE).map((m) => ({ seq: m.seq, ts: m.ts, body: JSON.parse(m.text) }));
}

async function main() {
  if (!fs.existsSync(IDENTITY)) throw new Error(`no identity at ${IDENTITY}; refusing to make one`);
  const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;

  if (!state && !process.argv.includes('--check')) {
    const client = new TechnocoreClient({ evidenceDir: path.resolve('data/local/evidence') });
    const text = ownerText(identity.did);
    const res = await client.postSignedMessage(ROOM, text, identity);
    const mine = String(res.raw).split('\n').find((l) => l.includes(identity.did.slice(-4)) && l.includes('"owner"'));
    const seq = mine?.match(/^\[(\d+)\]/)?.[1] ?? null;
    fs.writeFileSync(STATE, JSON.stringify({ did: identity.did, room: ROOM, text, postedAt: new Date().toISOString(), seq: seq ? Number(seq) : null }, null, 2));
    console.log(`posted owner registration for …${identity.did.slice(-8)} in /r/${ROOM}${seq ? ` at seq ${seq}` : ''}`);
  } else if (state) {
    console.log(`already registered ${state.postedAt} (seq ${state.seq ?? '?'}); not posting again`);
  }

  const [flow] = (await referee('d-close1-flow', 3)).slice(-1);
  const [price] = (await referee('d-close1-price', 3)).slice(-1);
  const [pnl] = (await referee('d-close1-pnl', 3)).slice(-1);
  const [st] = (await referee('d-close1-state', 3)).slice(-1);
  if (price) console.log(`sweep ${price.body.n}: NVDA ref ${price.body.ref?.px}, limits ${price.body.limits?.join('–')}`);
  if (st) console.log(`owners ${st.body.owners}, rooms ${st.body.rooms}`);
  if (flow) {
    const listed = (flow.body.mints || []).includes(identity.did);
    console.log(`last flow: ${flow.body.mints?.length ?? 0} mints listed, ${flow.body.omitted?.mints ?? 0} omitted${listed ? ' — OURS IS LISTED' : ''}`);
  }
  const ours = (pnl?.body.top || []).find(([did]) => did === identity.did);
  if (ours) console.log(`on the live board: ${ours[1]}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
