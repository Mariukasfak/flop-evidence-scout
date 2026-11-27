#!/usr/bin/env node
/**
 * Watch every official signal that opens the agent airdrop path, from the mini PC.
 *
 *   node readiness-watch.mjs [--once]
 *
 * Run by the Task Scheduler every 10 minutes (FLOP-readiness). Each run reads the
 * signals below, compares them with the last run and appends a line to
 * data/local/flop-readiness.jsonl for every signal whose value changed. The full
 * state is in data/local/flop-readiness.json; `unacked` lists changes nobody has
 * acted on yet (the Claude check clears it with --ack after acting).
 *
 * A signal only "changes" on a real answer: a fetch error or an error body keeps the
 * previous value and is counted in `errors`, so a flaky endpoint never raises a
 * false alarm (mistakes log #4). Read-only: it signs nothing and posts nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.FLOP_DATA_DIR || 'C:/TriAgent';
const STATE = path.join(DATA, 'data/local', 'flop-readiness.json');
const LOG = path.join(DATA, 'data/local', 'flop-readiness.jsonl');
const GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const GW = 'https://gateway.testnet.flop.network';

async function text(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'flop-readiness/1', ...(init.headers || {}) } });
  return { status: res.status, body: await res.text() };
}
const json = async (url, init) => { const r = await text(url, init); return { status: r.status, body: JSON.parse(r.body) }; };
const line = (body, re) => (String(body).split('\n').find((l) => re.test(l)) || '').trim().slice(0, 300);

/**
 * Each signal returns a short string, or throws when there is no trustworthy answer.
 * Exported for the tests, which feed canned answers.
 */
export const SIGNALS = {
  // Agent wallet enrollment for gateway keys (devnet-only so far: 404 on testnet).
  gatewayEnroll: async (get = text) => { const r = await get(`${GW}/v1/enroll/wallet/offer`); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return `HTTP ${r.status}`; },
  // What an unpaid inference request is told (x402 "not enabled" today).
  gatewayPay: async (get = text) => {
    const r = await get(`${GW}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"qwen/qwen3-1.7b","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' });
    if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
    let why = ''; try { why = JSON.parse(r.body).instructions ?? JSON.parse(r.body).error ?? ''; } catch { /* not json */ }
    return `HTTP ${r.status} ${String(why).slice(0, 160)}`;
  },
  // The miner fee bug that makes miners pause direct sessions.
  issue163: async (get = text) => { const r = await get('https://api.github.com/repos/flop-labs/network/issues/163'); const d = JSON.parse(r.body); if (!d.state) throw new Error('no state'); return d.state; },
  // The agent guide's "Not open yet" line and its Testnet status line.
  guideNotOpen: async (get = text) => { const r = await get('https://flop.network/llms.txt'); if (r.status !== 200 || r.body.length < 2000) throw new Error(`HTTP ${r.status}`); return line(r.body, /Not open yet|Testnet inference/i) || '(line gone)'; },
  guideStatus: async (get = text) => { const r = await get('https://flop.network/llms.txt'); if (r.status !== 200 || r.body.length < 2000) throw new Error(`HTTP ${r.status}`); return line(r.body, /^- Status:/) || '(line gone)'; },
  // Self / human tier on Testnet.
  guideSelf: async (get = text) => { const r = await get('https://docs.flop.network/llms-full.txt?network=testnet'); if (r.status !== 200 || r.body.length < 2000) throw new Error(`HTTP ${r.status}`); return line(r.body, /Self claims|Self\b.*Testnet/i) || '(line gone)'; },
  // The phase page: unscored opening until the scored phase starts.
  phase: async (get = text) => {
    const r = await get('https://flop.finance/testnet/'); if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const t = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const m = t.match(/Status\s*(Live[^A-Z]{0,40}[a-z ]*opening|Live[^.]{0,60})/); if (!m) throw new Error('no status');
    return m[1].trim().slice(0, 120);
  },
  // Faucet terms (not its open/cap status, which flips daily): network, agent grant, claim path, human tiers.
  faucet: async (get = json) => {
    const r = await get('https://faucet.flop.network/limits'); const f = r.body?.faucet; if (!f?.status) throw new Error('no status');
    const tiers = Object.keys(f).filter((k) => !['status', 'signer', 'funded', 'balanceFlop', 'minBalanceFlop', 'dailyCap', 'pendingGrants', 'perClient'].includes(k)).sort().join(',');
    return `${r.body.network} agent ${f.agent?.grantFlop ?? '?'} ${f.agent?.claimPath ?? '-'} tiers ${tiers}`;
  },
  faucetChain: async (get = json) => { const r = await get('https://faucet.flop.network/chain'); if (!r.body?.genesisHash) throw new Error('no genesis'); return r.body.genesisHash === GENESIS ? 'pinned testnet' : `OTHER ${r.body.genesisHash}`; },
  // Explorer view of the market.
  models: async (get = json) => { const r = await get(`${GW}/v1/models`); const n = r.body?.data?.length; if (typeof n !== 'number') throw new Error('no models'); return `${n} models`; },
  sdk: async (get = json) => { const r = await get('https://registry.npmjs.org/@flop-labs/sdk/latest'); if (!r.body?.version) throw new Error('no version'); return r.body.version; },
  cli: async (get = json) => { const r = await get('https://registry.npmjs.org/@flop-labs/cli/latest'); if (!r.body?.version) throw new Error('no version'); return r.body.version; },
  tclkFlop: async (get = json) => { const r = await get('https://registry.npmjs.org/@flop-labs/tclk-flop'); return r.status === 404 ? 'unpublished' : `published ${r.body?.['dist-tags']?.latest ?? '?'}`; },
  releases: async (get = json) => { const r = await get('https://api.github.com/repos/flop-labs/network/releases?per_page=3'); if (!Array.isArray(r.body)) throw new Error('no list'); return r.body.map((x) => x.tag_name).join(' '); },
};

/** Fold one run's answers into the state; returns the changes. Pure, for the tests. */
export function fold(state, answers, at) {
  const next = { ...state, signals: { ...(state.signals || {}) }, unacked: [...(state.unacked || [])], errors: {} };
  const changes = [];
  for (const [name, a] of Object.entries(answers)) {
    if (a.error) { next.errors[name] = a.error; continue; }
    const prev = next.signals[name]?.value;
    if (prev === undefined) { next.signals[name] = { value: a.value, since: at }; continue; } // first sight is the baseline
    if (prev !== a.value) {
      changes.push({ name, from: prev, to: a.value });
      next.signals[name] = { value: a.value, since: at };
      next.unacked = next.unacked.filter((u) => u.name !== name).concat({ name, from: prev, to: a.value, at });
    }
  }
  next.checkedAt = at;
  return { state: next, changes };
}

async function main() {
  if (process.argv.includes('--ack')) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); s.unacked = []; fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); console.log('acked'); return;
  }
  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* first run */ }
  const answers = {};
  for (const [name, fn] of Object.entries(SIGNALS)) {
    try { answers[name] = { value: await fn() }; } catch (err) { answers[name] = { error: String(err.message).slice(0, 160) }; }
  }
  const at = new Date().toISOString();
  const { state: next, changes } = fold(state, answers, at);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(next, null, 2));
  for (const c of changes) fs.appendFileSync(LOG, `${JSON.stringify({ at, ...c })}\n`);
  console.log(`${at} ${changes.length} changed, ${Object.keys(next.errors).length} errors, ${next.unacked.length} unacked`);
  for (const c of changes) console.log(`CHANGED ${c.name}: ${c.from} -> ${c.to}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
