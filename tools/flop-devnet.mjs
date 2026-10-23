#!/usr/bin/env node
/**
 * Our agents' FLOP accounts on devnet, and the faucet's view of the chain.
 *
 *   node tools/flop-devnet.mjs           addresses + faucet /chain and /health
 *   node tools/flop-devnet.mjs --fund    also ask the faucet for the daily anonymous grant
 *
 * Devnet FLOP is test money with no value. --fund is manual on purpose: these
 * accounts need enough for fees and small test escrows, not a daily drip.
 */
import { flopAddressOfDid } from '../src/flop-address.mjs';

const FAUCET = 'https://faucet.flop.network';
const AGENTS = [
  ['scout', 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn'],
  ['scribe', 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW']
];

const getJson = async (path) => (await fetch(`${FAUCET}${path}`, { signal: AbortSignal.timeout(30_000) })).json();

const chain = await getJson('/chain').catch((err) => ({ error: err.message }));
const health = await getJson('/health').catch((err) => ({ error: err.message }));
console.log(`chain   ${chain.chain ?? chain.error} genesis ${chain.genesisHash ?? '-'} rpc ${chain.rpc ?? '-'}`);
console.log(`faucet  ${health.status ?? health.error}, daily cap ${health.limits?.dailyCapFlop ?? '-'} FLOP`);

for (const [name, did] of AGENTS) {
  const address = flopAddressOfDid(did);
  let line = `${name.padEnd(7)} ${address}`;
  if (process.argv.includes('--fund')) {
    try {
      const res = await fetch(`${FAUCET}/fund`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }), signal: AbortSignal.timeout(120_000)
      });
      const j = await res.json();
      line += j.success ? `  funded ${j.amount} FLOP (${j.tier}) tx ${j.txHash}` : `  not funded: ${j.error}`;
    } catch (err) {
      line += `  fund request failed: ${err.message}`;
    }
  }
  console.log(line);
}
