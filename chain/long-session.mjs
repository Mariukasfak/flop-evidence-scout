#!/usr/bin/env node
/**
 * Many paid turns on one named miner through SDK LongSession (0.8+): the lane that can
 * carry the daemon's real volume, where runDirectSession buys one channel per answer.
 *
 *   node long-session.mjs --miner <ss58> --endpoint https://… --tasks tasks.jsonl
 *        [--model qwen/qwen2.5-0.5b-instruct] [--backend-model Qwen/Qwen2.5-0.5B-Instruct]
 *        [--agent scout] [--budget 0.05] [--channel 0.02] [--topup 0.01] [--turn-gn 1000000]
 *        [--window 900] [--max-turns 64] [--max-tokens 256] [--turn-timeout 60]
 *        [--enclave-key 0x…] [--check]
 *
 * Amounts are in FLOP (turn-gn in G_n, the largest one turn can meter). tasks.jsonl holds one real task per line:
 * {"id":"…","prompt":"…"} or {"id":"…","messages":[…],"max_tokens":256}. Answers append to
 * data/local/flop-long-answers.jsonl, spends to the SDK's owner-only journal under
 * data/local/flop-journal/<agent>. Ids are idempotent: an answered id replays, never buys again.
 *
 * Money rules come from the SDK and fail closed: nothing is bought until a task needs it,
 * never force_open (a miner-signed offer, else a bare open at the chain's unconsented
 * tariff), the miner's signed info proof and finalized registration, calibration and
 * model identity are checked before any purchase, every spend is journaled before
 * broadcast and debited from --budget (lifetime, across restarts), and an unknown
 * outcome freezes purchases. --check verifies miner and model, prints the bare-open
 * escrow floor, buys nothing.
 *
 * A bare open (no miner-signed offer) needs the miner's enclave key pinned with
 * --enclave-key: take it from the miner's own forceAck / channel record on chain, never
 * from a third party. The SDK still checks it against the enclave-signed info proof
 * before buying. The bare-open escrow is capacity rate x window blocks x the chain's
 * unconsented tariff (devnet 2026-11-23: about 0.00099 FLOP per block on miner 5HdTbhVY…,
 * devnet blocks are 1 s, so 0.89 FLOP for a 900 s window), and a cooperative close pays the miner that escrow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeChannel } from '@flop-labs/sdk';
import { networkConfig, connect, agentSigner, logLine, DATA, flop, opt } from './net.mjs';
import { resolveModelIdentity } from './model-identity.mjs';

const args = process.argv.slice(2);
const need = (name) => { const v = opt(args, name); if (!v) { console.log(`need --${name}`); process.exit(1); } return v; };
const planck = (name, dflt) => BigInt(Math.round(Number(opt(args, name, dflt)) * 1e6)) * 10n ** 12n;
const agent = opt(args, 'agent', 'scout');
const miner = need('miner');
const endpoint = need('endpoint');
const model = opt(args, 'model', 'qwen/qwen2.5-0.5b-instruct');
const backendModel = opt(args, 'backend-model', 'Qwen/Qwen2.5-0.5B-Instruct');
const budget = planck('budget', '0.05');

const channelCap = planck('channel', '0.02');
const topUp = planck('topup', '0.01');
// Largest G_n one turn can meter (SDK 0.10: worstCaseTurnGn). The SDK prices it as
// BasePerTurn + price x G_n at the model price, then the channel's pinned price. The money is
// mostly the reservation escrow; the turn's worst case must still fit one channel's ceiling.
const turnWorstGn = BigInt(opt(args, 'turn-gn', opt(args, 'turn-atoms', '1000000')));
const windowSeconds = Number(opt(args, 'window', '900'));
const maxTurns = Number(opt(args, 'max-turns', '64'));
const maxTokens = Number(opt(args, 'max-tokens', '256'));
const turnTimeout = Number(opt(args, 'turn-timeout', '60'));
const check = args.includes('--check');
const enclaveKeyHex = opt(args, 'enclave-key');
if (enclaveKeyHex && !/^0x[0-9a-fA-F]{64}$/.test(enclaveKeyHex)) { console.log('--enclave-key must be 0x + 64 hex'); process.exit(1); }
if (budget > 10n * 10n ** 18n) { console.log('--budget above 10 FLOP needs a code change on purpose'); process.exit(1); }

const tasks = check ? [] : fs.readFileSync(need('tasks'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const cfg = networkConfig();
const { api, info } = await connect(cfg);
const signer = await agentSigner(agent);
const free = async () => (await api.query.system.account(signer.address)).data.free.toBigInt();
const before = await free();

// Registry identity (model-identity.mjs): one Verified entry, one decode policy, a measured root.
const modelIdentity = await resolveModelIdentity(api, model, backendModel);
const id = modelIdentity;
// What one bare open will lock (and, closed cooperatively, pay): capacity rate x window x tariff.
{
  const head = await api.rpc.chain.getFinalizedHead();
  const cc = (await api.at(head)).consts.computeChannel;
  const cap = await computeChannel.readMinerCapacity(api, miner, head);
  const blockMs = Number(api.consts.babe?.expectedBlockTime?.toString() ?? 6000);
  const maxBlocks = BigInt(cc.maxUnconsentedSessionBlocks?.toString() ?? '0');
  let wb = BigInt(Math.floor(windowSeconds * 1000 / blockMs));
  if (maxBlocks > 0n && wb > maxBlocks) wb = maxBlocks;
  const tariff = BigInt(cc.unconsentedReservationTariff?.toString() ?? '0');
  const floor = cap ? cap.rate * wb * tariff : null;
  console.log(`bare open: miner capacity rate ${cap?.rate ?? '?'} free ${cap?.free ?? '?'} | window ${wb} blocks | escrow floor ${floor === null ? '?' : flop(floor)} FLOP | channel cap ${flop(channelCap)} budget ${flop(budget)}`);
  if (floor !== null && floor > channelCap) console.log('WARNING: --channel is below the bare-open floor; a bare open will be refused');
}
console.log(`${info.chain} ${agent} ${signer.address} free ${flop(before)} | ${model} -> ${id.registryModel} v${id.registryVersion} backend ${backendModel} | miner ${miner}`);

const journal = new computeChannel.FileSpendJournal(path.join(DATA, 'data/local/flop-journal', agent), info.genesisHash, signer.address);
const submitter = new computeChannel.FlopChainSubmitter(api, signer, true);
let session;
try {
  session = await computeChannel.LongSession.open({
    api, submitter, journal, miner, endpoint, modelIdentity,
    windowSeconds, maxLockSeconds: Math.max(windowSeconds, 3600),
    maxChannelPlanck: channelCap, topUpPlanck: topUp, budgetPlanck: budget,
    maxTurns, worstCaseTurnGn: () => turnWorstGn, turnTimeoutSeconds: turnTimeout,
    indexerUrl: cfg.indexer ?? undefined,
    ...(enclaveKeyHex ? { enclaveKey: Uint8Array.from(Buffer.from(enclaveKeyHex.slice(2), 'hex')) } : {})
  });
} catch (err) {
  console.log(`OPEN REFUSED ${err.message}`);
  await api.disconnect(); process.exit(2);
}
console.log(`miner and model verified; journal lifetime debit ${flop(BigInt(journal.state().debited ?? '0'))}`);
if (check) { await session.close(); await api.disconnect(); process.exit(0); }

let served = 0; let failed = 0;
for (const t of tasks) {
  const messages = t.messages ?? [{ role: 'user', content: String(t.prompt ?? '') }];
  const envelope = { version: 'flop.chat-turn.v1', model, messages, max_tokens: Math.min(Number(t.max_tokens) || maxTokens, 4096) };
  try {
    const r = await session.turn(envelope, { requestId: String(t.id) });
    const text = computeChannel.renderDirectChat(r.receipt, envelope).content;
    served += 1;
    logLine('flop-long-answers.jsonl', { agent, id: t.id, channelId: r.channelId, replayed: r.replayed, completionTokens: r.receipt.completionTokens?.toString() ?? null, text: text.slice(0, 2000) });
    console.log(`ok ${t.id} channel ${r.channelId.slice(0, 12)}… ${r.replayed ? '(replayed)' : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`turn ${t.id} FAILED ${err.code ?? ''} ${err.message}`);
    if (/Frozen|Budget|Allowance|closed/i.test(err.constructor?.name + err.message) || failed >= 3) break;
  }
}
const report = await session.close();
const after = await free();
const summary = { agent, miner, model, served, failed, debited: report.debited?.toString(), unresolved: report.unresolved, channels: report.channels?.map((c) => ({ channel: c.channel, state: c.state, turns: c.turns, escrow: c.escrow })), spentTotal: (before - after).toString() };
logLine('flop-long-sessions.jsonl', summary);
console.log(JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
await api.disconnect();
process.exit(failed && !served ? 2 : 0);
