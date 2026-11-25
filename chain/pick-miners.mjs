#!/usr/bin/env node
/**
 * Which miners the spend lane should buy from, read-only.
 *
 *   node pick-miners.mjs [--window 3600] [--top 5] [--json]
 *
 * Consent: only miners that publish a signed session offer (they sell to outside
 * buyers) are candidates. Their offer also carries the enclave key a bare open has to
 * pin, which the SDK checks again against the enclave-signed info proof before funding.
 *
 * For each candidate: registry model of its offers, calibration and availability from
 * the indexer, settlement record (settled vs timed out, ghost probes), and from
 * finalized chain state the capacity reservation rate, so the bare-open escrow for the
 * window (rate x window blocks x unconsentedReservationTariff) is what one channel
 * spends. Ranked by reliability first, then by spend per hour. Buys nothing.
 */
import { computeChannel } from '@flop-labs/sdk';
import { networkConfig, connect, getJson, flop, opt } from './net.mjs';

const args = process.argv.slice(2);
const windowSeconds = Number(opt(args, 'window', 3600));
const top = Number(opt(args, 'top', 5));
const asJson = args.includes('--json');
const cfg = networkConfig();
if (!cfg.indexer) { console.log('no indexer configured (network.json "indexer"); nothing to rank'); process.exit(2); }

async function indexer(path) {
  // The explorer answers {"error":"Writer unavailable"} now and then; a few tries.
  for (let i = 0; i < 6; i++) {
    const r = await getJson(`${cfg.indexer}${path}`).catch(() => null);
    if (r?.body?.data) return r.body.data;
    // An explorer without this route (testnet flopscan has no /api/session-offers) means none.
    if (r?.status === 404) return [];
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`${cfg.indexer}${path} gave no data`);
}

const { api, info } = await connect(cfg);
const head = await api.rpc.chain.getFinalizedHead();
const at = await api.at(head);
const cc = at.consts.computeChannel;
const blockMs = Number(api.consts.babe?.expectedBlockTime?.toString() ?? 6000);
const tariff = BigInt(cc.unconsentedReservationTariff?.toString() ?? '0');
const maxBlocks = BigInt(cc.maxUnconsentedSessionBlocks?.toString() ?? '0');
let windowBlocks = BigInt(Math.ceil(windowSeconds * 1000 / blockMs));
if (maxBlocks > 0n && windowBlocks > maxBlocks) windowBlocks = maxBlocks;
const hourBlocks = BigInt(Math.ceil(3600_000 / blockMs));

// Registry: model hash -> name, status.
const models = new Map();
for (const [key, raw] of await at.query.modelRegistry.models.entries()) {
  if (!raw.isSome) continue;
  const e = raw.unwrap();
  models.set(key.args[0].toHex(), { name: e.modelName.toHuman(), status: e.status.toString(), version: e.version.toHuman() });
}

const offers = await indexer('/api/session-offers');
const minersList = await indexer('/api/miners');
const minerInfo = new Map(minersList.map((m) => [m.address, m]));

const byMiner = new Map();
for (const { offer, onChainFacts, venue, venueVerified } of offers) {
  const m = byMiner.get(offer.miner) ?? { miner: offer.miner, enclaveKeys: new Set(), models: new Set(), venues: new Set(), maxDuration: 0, maxTurns: 0, facts: onChainFacts };
  // The offer's venue is where the miner says its session server answers (the operator's opt-in).
  if (venue && venueVerified) m.venues.add(String(venue));
  m.enclaveKeys.add(offer.enclaveKey);
  m.models.add(offer.modelHash);
  m.maxDuration = Math.max(m.maxDuration, Number(offer.maxDuration));
  m.maxTurns = Math.max(m.maxTurns, Number(offer.maxTurns));
  byMiner.set(offer.miner, m);
}

const rows = [];
for (const m of byMiner.values()) {
  const mi = minerInfo.get(m.miner) ?? {};
  const rel = m.facts?.reliability ?? {};
  const settled = Number(rel.settledCount ?? 0);
  const timeouts = Number(rel.timeoutCount ?? 0);
  const ghostIssued = Number(rel.ghost?.issued ?? 0);
  const ghostDone = Number(rel.ghost?.completed ?? 0);
  let cap = null;
  try { cap = await computeChannel.readMinerCapacity(api, m.miner, head); } catch { /* no reservation data */ }
  const rate = cap?.rate ?? null;
  rows.push({
    miner: m.miner,
    enclaveKey: m.enclaveKeys.size === 1 ? [...m.enclaveKeys][0] : null,
    enclaveKeys: m.enclaveKeys.size,
    endpoint: m.venues.size === 1 ? [...m.venues][0] : null,
    models: [...m.models].map((h) => models.get(h)?.name ?? h.slice(0, 10)),
    modelStatus: [...m.models].map((h) => models.get(h)?.status ?? '?'),
    calibration: mi.calibration?.phase ?? '?',
    availability: mi.availability ?? '?',
    active: m.facts?.active ?? mi.isActive ?? null,
    blacklisted: m.facts?.blacklisted ?? mi.blacklisted ?? null,
    slashed: m.facts?.totalSlashed ?? mi.totalSlashed ?? null,
    settled, timeouts,
    settleRate: settled + timeouts ? settled / (settled + timeouts) : 0,
    ghost: ghostIssued ? ghostDone / ghostIssued : null,
    rate: rate?.toString() ?? null,
    free: cap?.free?.toString() ?? null,
    windowEscrow: rate !== null && tariff > 0n ? flop(rate * windowBlocks * tariff) : null,
    perHour: rate !== null && tariff > 0n ? flop(rate * hourBlocks * tariff) : null,
    offerMaxDuration: m.maxDuration, offerMaxTurns: m.maxTurns
  });
}

const usable = (r) => r.active !== false && !r.blacklisted && (r.slashed === null || r.slashed === '0') && r.calibration === 'Active'
  && r.availability !== 'unavailable' && r.enclaveKey && r.rate !== null && r.modelStatus.includes('Verified');
const ranked = rows.filter(usable).sort((a, b) => (b.settleRate - a.settleRate) || (Number(b.rate) - Number(a.rate)));

if (asJson) {
  console.log(JSON.stringify({ chain: info.chain, windowSeconds, windowBlocks: windowBlocks.toString(), blockMs, ranked, rejected: rows.filter((r) => !usable(r)) }, null, 2));
} else {
  console.log(`${info.chain}: ${offers.length} offers from ${byMiner.size} miners | block ${blockMs} ms | window ${windowSeconds} s = ${windowBlocks} blocks | tariff ${tariff}`);
  for (const r of ranked) {
    console.log(`${r.miner} settle ${(r.settleRate * 100).toFixed(0)}% (${r.settled}/${r.settled + r.timeouts}) ghost ${r.ghost === null ? '?' : (r.ghost * 100).toFixed(0) + '%'} | rate ${r.rate} free ${r.free} | window escrow ${r.windowEscrow} FLOP, ${r.perHour}/h | ${r.availability} | ${r.models.join(', ')} | endpoint ${r.endpoint ?? 'unknown (ask the operator)'}`);
  }
  const out = rows.filter((r) => !usable(r));
  if (out.length) console.log(`not usable: ${out.map((r) => `${r.miner.slice(0, 8)}(${r.calibration}/${r.availability}${r.enclaveKey ? '' : '/keys:' + r.enclaveKeys}${r.rate === null ? '/no-rate' : ''})`).join(' ')}`);
  console.log('\nlane.json "miners" (top picks; endpoints only as the operator publishes them):');
  console.log(JSON.stringify(ranked.slice(0, top).map((r) => ({ miner: r.miner, endpoint: r.endpoint ?? '<https endpoint from the operator>', enclaveKey: r.enclaveKey, model: r.models[0] })), null, 2));
}
await api.disconnect();
