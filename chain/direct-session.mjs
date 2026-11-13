#!/usr/bin/env node
/**
 * One direct paid session from an agent's own account to a named miner — the
 * path that books compute spend on the account registered as the agent.
 *
 *   node direct-session.mjs --miner <ss58> --endpoint https://… [--model qwen/qwen2.5-0.5b-instruct]
 *        [--escrow-milli 10] [--agent scout] [--via auto|offer|force] [--prompt "…"] [--check]
 *
 * --check stops after the genesis and balance check: nothing is signed.
 *
 * Network comes from env: FLOP_RPC (default devnet) and FLOP_FAUCET, whose /chain
 * must report the same genesis as the RPC — a mismatch stops before signing.
 * Escrow is capped at 0.1 FLOP per run; a cooperative settle pays the escrow.
 *
 * Only open channels to miners whose operator agreed to outside buyers: an open
 * reserves the miner's capacity (flop-labs/network#255). Results append to
 * data/local/flop-direct-sessions.jsonl under FLOP_DATA_DIR. Never prints keys.
 *
 * Devnet rehearsal 2026-11-13 (miner 5Hb5PRJP…, m1.flop.ariabrain.com): force-open
 * and automatic expiry refund both worked on chain; the miner never acknowledged
 * (two models tried), fees 0.014 FLOP per attempt. Even acknowledged force-opens
 * currently end in AttestationStale and a refund (network#166).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { runDirectSession } from '@flop-labs/sdk';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const RPC = process.env.FLOP_RPC || 'wss://rpc.devnet.flop.network';
const FAUCET = process.env.FLOP_FAUCET || 'https://faucet.flop.network';
const INDEXER = process.env.FLOP_INDEXER_URL || 'https://explorer.devnet.flop.network';
const DATA = process.env.FLOP_DATA_DIR || 'C:/TriAgent';
const agent = opt('agent', 'scout');
const miner = opt('miner');
const endpoint = opt('endpoint');
const model = opt('model', 'qwen/qwen2.5-0.5b-instruct');
const via = opt('via', 'auto');
const milli = BigInt(opt('escrow-milli', '10'));
const prompt = opt('prompt', 'In one sentence, what does a compute channel settle on the FLOP network?');
if (!miner || !endpoint) { console.log('need --miner <ss58> and --endpoint https://…'); process.exit(1); }
if (milli <= 0n || milli > 100n) { console.log('escrow must be 1..100 milli-FLOP (0.001..0.1)'); process.exit(1); }
const maxFlop = milli * 10n ** 15n;

const logPath = path.join(DATA, 'data/local/flop-direct-sessions.jsonl');
const log = (e) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), agent, rpc: RPC, miner, model, maxFlop: maxFlop.toString(), ...e })}\n`);
};

const id = JSON.parse(fs.readFileSync(path.join(DATA, '.secrets', `${agent}-identity.json`), 'utf8'));
const seed = Buffer.from(crypto.createPrivateKey(id.privateKeyPem).export({ format: 'jwk' }).d, 'base64url');
await cryptoWaitReady();
const signer = new Keyring({ type: 'ed25519', ss58Format: 42 }).addFromSeed(seed);

const chainInfo = await (await fetch(`${FAUCET}/chain`, { signal: AbortSignal.timeout(30_000) })).json();
const api = await ApiPromise.create({ provider: new WsProvider(RPC), noInitWarn: true });
if (api.genesisHash.toHex() !== chainInfo.genesisHash) {
  console.log(`genesis mismatch: rpc ${api.genesisHash.toHex()} faucet ${chainInfo.genesisHash}`);
  await api.disconnect();
  process.exit(1);
}
const free = async () => (await api.query.system.account(signer.address)).data.free.toBigInt();
const before = await free();
console.log(`${new Date().toISOString()} ${agent} ${signer.address} free ${before} escrow ${maxFlop} model ${model} miner ${miner} (${chainInfo.chain})`);
if (args.includes('--check')) { console.log('check only: nothing signed'); await api.disconnect(); process.exit(0); }
log({ event: 'start', chain: chainInfo.chain, genesis: chainInfo.genesisHash, freeBefore: before.toString() });

let exit = 0;
try {
  const r = await runDirectSession({ api, signer, miner, model, endpoint, maxFlop, maxTokens: 64, via, indexerUrl: INDEXER, prompt });
  const after = await free();
  const rc = r.receipts[0] ?? {};
  const out = {
    event: 'settled', channelId: u8aToHex(r.channelId), settleTx: r.settleTx,
    minerPaid: r.settlement.minerPaid?.toString() ?? null, burned: r.settlement.burned?.toString() ?? null,
    aggregateGn: r.settlement.aggregateGn?.toString() ?? null, cooperative: r.settlement.cooperative ?? null,
    finishReason: rc.finishReason ?? null, completionTokens: rc.completionTokens ?? null,
    freeAfter: after.toString(), spentTotal: (before - after).toString(), reply: r.reply.slice(0, 300)
  };
  log(out);
  console.log(JSON.stringify(out, null, 2));
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
