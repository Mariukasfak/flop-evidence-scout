#!/usr/bin/env node
/**
 * One direct paid session from an agent's own account to a named miner — the
 * path that books compute spend on the account registered as the agent.
 *
 *   node direct-session.mjs --miner <ss58> --endpoint https://… [--model qwen/qwen2.5-0.5b-instruct]
 *        [--escrow-milli 10] [--agent scout] [--via auto|offer|force] [--prompt "…"] [--lifetime 600] [--check]
 *
 * --lifetime sets the force-open channel lifetime in seconds (SDK 0.7+, needs --via force).
 * The SDK default 120 s is what network#166 saw end in AttestationStale; settled
 * examples there ran 600 s.
 * --check stops after the genesis and balance check: nothing is signed.
 *
 * Network comes from net.mjs (network.json beside the script, env FLOP_FAUCET /
 * FLOP_RPC / FLOP_INDEXER_URL, devnet fallback); the faucet's /chain must report
 * the same genesis as the RPC, and a mismatch stops before signing.
 * Escrow is capped at 0.1 FLOP per run; a cooperative settle pays the escrow.
 *
 * Only open channels to miners whose operator agreed to outside buyers: an open
 * reserves the miner's capacity (flop-labs/network#255). Results append to
 * data/local/flop-direct-sessions.jsonl under FLOP_DATA_DIR. Never prints keys.
 *
 * First settled session 2026-11-23 (SDK 0.9.0, --via force --lifetime 900, escrow 0.01):
 * miner 5HdTbhVY… (miner.ecamliflop.fyi), channel 0xb2623cb5…cd8e, cooperative settle
 * at block 4441082, minerPaid 0.0085 FLOP, aggregate G_n 81, about 7 minutes end to end.
 *
 * Devnet rehearsal 2026-11-13 (miner 5Hb5PRJP…, m1.flop.ariabrain.com): force-open
 * and automatic expiry refund both worked on chain; the miner never acknowledged
 * (two models tried), fees 0.014 FLOP per attempt. Even acknowledged force-opens
 * currently end in AttestationStale and a refund (network#166).
 */
import fs from 'node:fs';
import path from 'node:path';
import { u8aToHex } from '@polkadot/util';
import { runDirectSession } from '@flop-labs/sdk';
import { networkConfig, connect, agentSigner, DATA } from './net.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const cfg = networkConfig();
const INDEXER = cfg.indexer;
let RPC = cfg.rpc;
const agent = opt('agent', 'scout');
const miner = opt('miner');
const endpoint = opt('endpoint');
const model = opt('model', 'qwen/qwen2.5-0.5b-instruct');
const via = opt('via', 'auto');
const milli = BigInt(opt('escrow-milli', '10'));
const lifetime = opt('lifetime') ? Number(opt('lifetime')) : undefined;
if (lifetime !== undefined && (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 3600 || via !== 'force')) { console.log('--lifetime must be 60..3600 seconds and needs --via force'); process.exit(1); }
const prompt = opt('prompt', 'In one sentence, what does a compute channel settle on the FLOP network?');
if (!miner || !endpoint) { console.log('need --miner <ss58> and --endpoint https://…'); process.exit(1); }
if (milli <= 0n || milli > 100n) { console.log('escrow must be 1..100 milli-FLOP (0.001..0.1)'); process.exit(1); }
const maxFlop = milli * 10n ** 15n;

const logPath = path.join(DATA, 'data/local/flop-direct-sessions.jsonl');
// Receipts carry bigint fields (completionTokens and others). 2026-11-23 a settled,
// paid session was reported FAILED because JSON.stringify threw on one of them.
const jsonSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const log = (e) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), agent, rpc: RPC, miner, model, maxFlop: maxFlop.toString(), ...e }, jsonSafe)}\n`);
};

const signer = await agentSigner(agent);
let api; let chainInfo;
try { ({ api, info: chainInfo, rpc: RPC } = await connect(cfg)); } catch (err) { console.log(err.message); process.exit(1); }
const free = async () => (await api.query.system.account(signer.address)).data.free.toBigInt();
const before = await free();
console.log(`${new Date().toISOString()} ${agent} ${signer.address} free ${before} escrow ${maxFlop} model ${model} miner ${miner} (${chainInfo.chain})`);
if (args.includes('--check')) { console.log('check only: nothing signed'); await api.disconnect(); process.exit(0); }
log({ event: 'start', chain: chainInfo.chain, genesis: chainInfo.genesisHash, freeBefore: before.toString() });

let exit = 0;
try {
  const r = await runDirectSession({ api, signer, miner, model, endpoint, maxFlop, maxTokens: 64, via, indexerUrl: INDEXER, prompt, ...(lifetime ? { maxDurationSeconds: lifetime } : {}) });
  const after = await free();
  const rc = r.receipts[0] ?? {};
  const out = {
    event: 'settled', channelId: u8aToHex(r.channelId), settleTx: r.settleTx,
    minerPaid: r.settlement.minerPaid?.toString() ?? null, burned: r.settlement.burned?.toString() ?? null,
    aggregateGn: r.settlement.aggregateGn?.toString() ?? null, cooperative: r.settlement.cooperative ?? null,
    finishReason: rc.finishReason ?? null, completionTokens: rc.completionTokens?.toString() ?? null,
    freeAfter: after.toString(), spentTotal: (before - after).toString(), reply: r.reply.slice(0, 300)
  };
  log(out);
  console.log(JSON.stringify(out, jsonSafe, 2));
} catch (err) {
  exit = 2;
  const after = await free().catch(() => null);
  const channelId = err.channelId ? u8aToHex(err.channelId) : null;
  const causes = [];
  for (let c = err.cause; c && causes.length < 4; c = c.cause) causes.push(c.errors ? c.errors.map((x) => x.message).join(' | ') : c.message);
  log({ event: 'failed', error: err.message, causes, channelId, freeAfter: after?.toString() ?? null });
  console.log(`FAILED ${err.message}\n causes: ${causes.join(' || ')}\n channel ${channelId} (inspect finalized state before any retry) free after ${after}`);
}
await api.disconnect();
process.exit(exit);
