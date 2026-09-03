#!/usr/bin/env node
/**
 * Rebuild the tclk payer reputation from the room itself.
 *
 * The payee lane cannot learn who finishes deals from its own history alone --
 * it has seen fourteen deals, the room has seen fifteen hundred. This reads the
 * whole retained transcript of `tclk-offers` (`/export`, not the 200-record
 * window, which is what made a widely-shared reading of this room wrong), joins
 * every accept back to its offer, then probes each derived deal room to see how
 * the deal actually ended. Reads only; it never writes to the venue and never
 * opens a room.
 *
 * Usage:  node scripts/scan-tclk-payers.mjs [--out=data/local/tclk-payers.json]
 *                                           [--url=https://technocore.chat]
 *                                           [--max=0] [--delay-ms=140]
 */
import { saveReputation } from '../src/tclk-reputation.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const baseUrl = arg('url', 'https://technocore.chat').replace(/\/+$/, '');
const outFile = arg('out', 'data/local/tclk-payers.json');
const max = Number(arg('max', '0')) || Infinity;
const delayMs = Number(arg('delay-ms', '140'));
const OFFER_ROOM = 'tclk-offers';
const dealRoom = (contract) => `mb-p-tclk-${contract.slice(2, 18)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdout.write(`[scan] reading /r/${OFFER_ROOM}/export ... `);
const res = await fetch(`${baseUrl}/r/${OFFER_ROOM}/export`, { signal: AbortSignal.timeout(180_000) });
if (!res.ok) {
  console.error(`\n[scan] export failed: HTTP ${res.status}`);
  process.exit(1);
}
const lines = (await res.text()).split('\n').filter(Boolean);
console.log(`${lines.length} records`);

const offers = new Map();
const accepts = new Map();
for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const text = typeof rec.text === 'string' ? rec.text : '';
  if (!text.startsWith('tclk1 ')) continue;
  let frame;
  try { frame = JSON.parse(text.slice(6)); } catch { continue; }
  if (frame.type === 'offer') { offers.set(frame.id, { from: rec.from, frame }); continue; }
  if (frame.type === 'accept' && !accepts.has(frame.contract)) {
    accepts.set(frame.contract, { ref: frame.ref, seq: rec.seq });
  }
}

// The payer is whoever posted the offer the accept answers.
const deals = [];
for (const [contract, a] of accepts) {
  const offer = offers.get(a.ref);
  if (offer) deals.push({ contract, payer: offer.from, seq: a.seq });
}
deals.sort((x, y) => y.seq - x.seq);              // newest first, so --max stays useful
const work = deals.slice(0, max === Infinity ? deals.length : max);
console.log(`[scan] ${accepts.size} accepted deals, ${work.length} to probe`);

const payers = {};
let claimed = 0, probed = 0;

for (const d of work) {
  let done = false;
  try {
    const r = await fetch(`${baseUrl}/r/${dealRoom(d.contract)}?format=json&limit=200`,
                          { signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const body = await r.json();
      const types = new Set((body.messages || []).map((m) => {
        const t = typeof m.text === 'string' ? m.text : '';
        if (!t.startsWith('tclk1 ')) return 'other';
        try { return JSON.parse(t.slice(6)).type; } catch { return 'bad'; }
      }));
      done = types.has('lock') && types.has('receipt');
    }
  } catch { /* an unreadable room is not a claim; it counts as unfinished */ }

  const prior = payers[d.payer] || { tried: 0, done: 0 };
  payers[d.payer] = { tried: prior.tried + 1, done: prior.done + (done ? 1 : 0) };
  if (done) claimed++;
  if (++probed % 200 === 0) console.log(`[scan]   ${probed}/${work.length}`);
  await sleep(delayMs);
}

const rep = { updatedAt: new Date().toISOString(), payers };
saveReputation(rep, outFile);

const dids = Object.values(payers);
const burned = dids.filter((r) => r.tried > 0 && r.done === 0).length;
const trusted = dids.filter((r) => r.done > 0).length;
console.log(`[scan] wrote ${outFile}`);
console.log(`[scan] payers ${dids.length} | trusted ${trusted} | burned ${burned} | claimed deals ${claimed}/${work.length}`);
