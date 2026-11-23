#!/usr/bin/env node
/**
 * Register an agent on the current network with agentIdentity.registerAgent.
 *
 *   node register-agent.mjs [--agent scout] [--stake <FLOP>] [--yes]
 *
 * Without --yes it only reports what it would do and the fee. The stake defaults
 * to the chain's minimum when the runtime exposes one, else 10 FLOP (devnet's).
 * The record goes to data/local/flop-agent-<network>-<genesis8>.json, one per
 * chain, so the devnet record never blocks a testnet registration.
 *
 * Registration is a one-time identity step. Never call reportTaskCompletion or
 * flip pause/resume: self-reported activity is not settled spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { networkConfig, connect, agentSigner, agentIdentity, DATA, flop, opt } from './net.mjs';

const args = process.argv.slice(2);
const agent = opt(args, 'agent', 'scout');
const PROFILES = {
  scout: { name: 'flop-evidence-scout', caps: ['Summarization', 'QuestionAnswering', 'TextGeneration'] },
  scribe: { name: 'flop-evidence-scribe', caps: ['Summarization', 'TextGeneration'] }
};
const profile = PROFILES[agent];
if (!profile) { console.log(`unknown agent ${agent}`); process.exit(1); }

const cfg = networkConfig();
const { api, info } = await connect(cfg);
const pair = await agentSigner(agent);
const out = path.join(DATA, 'data/local', `flop-agent-${info.network ?? 'net'}-${info.genesisHash.slice(2, 10)}.json`);
const owned = (await api.query.agentIdentity.agentsByOwner(pair.address)).toJSON();
if (owned.length) {
  console.log(`${agent} ${pair.address} already owns agents on ${info.chain}: ${JSON.stringify(owned)}`);
  if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify({ agentId: owned[0], owner: pair.address, network: info.network, genesis: info.genesisHash, seenAt: new Date().toISOString() }, null, 2));
  await api.disconnect(); process.exit(0);
}

const consts = api.consts.agentIdentity ?? {};
const minKey = Object.keys(consts).find((k) => /min.*stake|stake.*min/i.test(k));
const minStake = minKey ? BigInt(consts[minKey].toString()) : null;
const stake = opt(args, 'stake') ? BigInt(Math.round(Number(opt(args, 'stake')) * 1e6)) * 10n ** 12n : (minStake ?? 10n * 10n ** 18n);
const free = (await api.query.system.account(pair.address)).data.free.toBigInt();
const did = agentIdentity(agent).did ?? null;
const tx = api.tx.agentIdentity.registerAgent(profile.name, 'Autonomous', profile.caps, [], 'https://github.com/Mariukasfak/flop-evidence-scout', stake);
const fee = (await tx.paymentInfo(pair)).partialFee.toBigInt();
console.log(`${info.chain} ${agent} ${pair.address} free ${flop(free)} stake ${flop(stake)} (chain min ${minKey ? `${minKey}=${flop(minStake)}` : 'not exposed'}) fee ~${flop(fee)}`);
if (free < stake + fee * 2n) { console.log('not enough free balance yet: claim the faucet first'); await api.disconnect(); process.exit(2); }
if (!args.includes('--yes')) { console.log('dry run: add --yes to sign'); await api.disconnect(); process.exit(0); }

try {
  const block = await new Promise((resolve, reject) => {
    tx.signAndSend(pair, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        reject(new Error(m ? `${m.section}.${m.name}` : dispatchError.toString())); return;
      }
      if (status.isFinalized) {
        for (const { event } of events) if (event.section === 'agentIdentity') console.log('event', event.method, JSON.stringify(event.data.toHuman()));
        resolve(status.asFinalized.toHex());
      }
    }).catch(reject);
  });
  const ids = (await api.query.agentIdentity.agentsByOwner(pair.address)).toJSON();
  const rec = { agentId: ids[0], owner: pair.address, did, name: profile.name, network: info.network, genesis: info.genesisHash, finalizedBlock: block, stake: stake.toString(), registeredAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rec, null, 2));
  console.log('registered', JSON.stringify(rec));
} catch (err) {
  console.log('FAILED', err.message);
  await api.disconnect(); process.exit(2);
}
await api.disconnect();
