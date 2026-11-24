#!/usr/bin/env node
/**
 * Launch-day picture of a FLOP network for our agents, in one read-only run.
 *
 *   node testnet-ready.mjs [--agents scout,scribe] [--json]
 *
 * Reads the faucet (/chain, /health, /limits), the RPC (genesis, runtime, our
 * balances and agent registration), the gateway (/health, /v1/models, the
 * enrollment offer) and the indexer (health, session offers), and checks the
 * installed SDK admits the live runtime. Signs nothing, funds nothing, enrolls
 * nothing. Network comes from net.mjs (network.json / env / devnet).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkConfig, getJson, connect, agentSigner, DATA, flop, opt } from './net.mjs';

const args = process.argv.slice(2);
const agents = opt(args, 'agents', 'scout,scribe').split(',').filter(Boolean);
const cfg = networkConfig();
const out = { at: new Date().toISOString(), cfg, todo: [] };
const todo = (s) => out.todo.push(s);
const safe = async (fn) => { try { return await fn(); } catch (err) { return { error: err?.message || String(err) || 'unknown error' }; } };

// Faucet
out.faucet = {
  chain: (await safe(() => getJson(`${cfg.faucet}/chain`))).body ?? null,
  health: (await safe(() => getJson(`${cfg.faucet}/health`))).body ?? null,
  limits: (await safe(() => getJson(`${cfg.faucet}/limits`))).body ?? null
};
const lim = out.faucet.limits?.faucet ?? {};
out.faucet.summary = {
  network: out.faucet.chain?.network ?? null,
  status: lim.status ?? out.faucet.health?.status ?? null,
  anonymous: lim.anonymous?.grantFlop ?? null,
  linkedBase: lim.linked?.baseFlop ?? null,
  linkedPerGrantCap: lim.linked?.perGrantCapFlop ?? null,
  linked7d: lim.linked?.rolling7DayCapFlop ?? null,
  agentLane: lim.agent?.grantFlop ?? null,
  technocoreRoom: out.faucet.chain?.technocoreBot?.room ?? null
};
if (!out.faucet.chain?.genesisHash) todo(`faucet ${cfg.faucet}/chain has no genesis: wrong faucet origin or not live yet`);

// Chain
let api = null;
const c = await safe(async () => connect(cfg));
if (c.error) { out.chain = { error: c.error }; todo(`RPC: ${c.error}`); }
else {
  api = c.api;
  const fin = await api.rpc.chain.getFinalizedHead();
  const at = await api.at(fin);
  const spec = api.runtimeVersion.specVersion.toNumber();
  let sdk = { installed: null, admits: null };
  try {
    const sdkPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/@flop-labs/sdk/package.json'), 'utf8'));
    const { SUPPORTED_SPEC_VERSIONS } = await import('@flop-labs/sdk');
    sdk = { installed: sdkPkg.version, admits: [...SUPPORTED_SPEC_VERSIONS].includes(spec) };
  } catch (err) { sdk.error = err.message; }
  if (sdk.admits === false) todo(`SDK ${sdk.installed} does not admit runtime ${spec}: npm install @flop-labs/sdk@latest and recheck its CHANGELOG`);
  const cc = at.consts.computeChannel ?? {};
  const ai = at.consts.agentIdentity ?? {};
  out.chain = {
    rpc: c.rpc, genesis: c.info.genesisHash, chain: c.info.chain, spec,
    finalized: (await api.rpc.chain.getHeader(fin)).number.toNumber(), sdk,
    basePerTurn: cc.basePerTurn?.toString() ?? null,
    agentIdentityConsts: Object.fromEntries(Object.keys(ai).map((k) => [k, ai[k].toString().slice(0, 60)])),
    agentCount: at.query.agentIdentity?.agentCount ? (await at.query.agentIdentity.agentCount()).toString() : null
  };
  out.agents = {};
  for (const name of agents) {
    const r = await safe(async () => {
      const pair = await agentSigner(name);
      const acc = await at.query.system.account(pair.address);
      const owned = at.query.agentIdentity?.agentsByOwner ? (await at.query.agentIdentity.agentsByOwner(pair.address)).toJSON() : null;
      return { address: pair.address, free: flop(acc.data.free.toBigInt()), reserved: flop(acc.data.reserved.toBigInt()), nonce: acc.nonce.toNumber(), registeredAgents: owned };
    });
    out.agents[name] = r;
    if (r.error) todo(`${name}: ${r.error}`);
    else {
      if (Number(r.free) < 1) todo(`${name}: free ${r.free} FLOP, claim the faucet for ${r.address}`);
      if (name === 'scout' && Array.isArray(r.registeredAgents) && r.registeredAgents.length === 0) todo('scout: not registered as an agent on this chain (register-agent.mjs)');
    }
  }
}

// Gateway
out.gateway = {
  health: (await safe(() => getJson(`${cfg.gateway}/health`))).body ?? null,
  models: (await safe(async () => ((await getJson(`${cfg.gateway}/v1/models`)).body?.data ?? []).map((m) => m.id)))
};
const scoutAddr = out.agents?.scout?.address;
if (scoutAddr) out.gateway.offer = (await safe(() => getJson(`${cfg.gateway}/v1/enroll/wallet/offer?address=${scoutAddr}&purpose=hermes-tools-v1`))).body ?? null;
const keyFile = path.join(DATA, '.secrets', 'flop-gateway.json');
try {
  const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  out.gateway.localKey = { address: k.address ?? null, model: k.model ?? null, expiresAt: k.expires_at ? new Date(Number(k.expires_at)).toISOString() : null };
} catch { out.gateway.localKey = null; }

// Indexer
if (cfg.indexer) {
  out.indexer = { health: (await safe(() => getJson(`${cfg.indexer}/api/health`))).body ?? null };
  const offers = await safe(async () => (await getJson(`${cfg.indexer}/api/session-offers`)).body);
  const list = Array.isArray(offers) ? offers : (offers?.offers ?? offers?.data ?? []);
  out.indexer.offers = Array.isArray(list) ? list.length : offers;
  out.indexer.withVenue = Array.isArray(list) ? list.filter((o) => o.venue).map((o) => ({ miner: o.miner, venue: o.venue, model: o.modelName ?? o.model ?? null })) : [];
} else todo('no indexer origin: set indexer in network.json (session offers)');

if (api) await api.disconnect();

if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  const f = out.faucet.summary;
  console.log(`network  ${f.network ?? '?'} faucet ${cfg.faucet} status ${f.status ?? '?'}`);
  console.log(`faucet   anon ${f.anonymous} | linked ${f.linkedBase}..${f.linkedPerGrantCap} (7d ${f.linked7d}) | agent lane ${f.agentLane} | room ${f.technocoreRoom}`);
  if (out.chain?.error) console.log(`chain    ERROR ${out.chain.error}`);
  else console.log(`chain    ${out.chain.chain} ${out.chain.genesis.slice(0, 18)} spec ${out.chain.spec} block ${out.chain.finalized} sdk ${out.chain.sdk.installed} admits=${out.chain.sdk.admits} agents ${out.chain.agentCount}`);
  for (const [n, a] of Object.entries(out.agents ?? {})) console.log(`agent    ${n.padEnd(6)} ${a.error ?? `${a.address} free ${a.free} reserved ${a.reserved} nonce ${a.nonce} registered ${JSON.stringify(a.registeredAgents)}`}`);
  console.log(`gateway  ${out.gateway.health?.status ?? JSON.stringify(out.gateway.health)?.slice(0, 80)} models ${JSON.stringify(out.gateway.models)} offer ${JSON.stringify(out.gateway.offer)?.slice(0, 160)}`);
  if (out.indexer) console.log(`indexer  offers ${JSON.stringify(out.indexer.offers)} with venue ${out.indexer.withVenue.length} ${JSON.stringify(out.indexer.withVenue.slice(0, 5))}`);
  console.log(out.todo.length ? `TODO\n - ${out.todo.join('\n - ')}` : 'TODO     none');
}
