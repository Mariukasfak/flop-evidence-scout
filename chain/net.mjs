/**
 * Which FLOP network the chain scripts talk to, and the agent key that signs.
 *
 * One place decides the network so launch day is one file edit: `network.json`
 * next to the scripts (or FLOP_NETWORK_FILE) may set { faucet, rpc, indexer,
 * gateway }; env FLOP_FAUCET / FLOP_RPC / FLOP_INDEXER_URL / FLOP_GATEWAY win over
 * it; devnet is the fallback. The faucet's /chain names the RPC and genesis, and
 * connect() refuses an RPC whose genesis differs from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVNET = {
  faucet: 'https://faucet.flop.network',
  rpc: 'wss://rpc.devnet.flop.network',
  indexer: 'https://explorer.devnet.flop.network',
  gateway: 'https://api.flop.network'
};

export const DATA = process.env.FLOP_DATA_DIR || 'C:/TriAgent';

function fileConfig() {
  const file = process.env.FLOP_NETWORK_FILE || path.join(HERE, 'network.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Origins with env > network.json > devnet. `rpc` stays null when only the faucet should name it. */
export function networkConfig() {
  const f = fileConfig();
  const faucet = process.env.FLOP_FAUCET || f.faucet || DEVNET.faucet;
  const onDevnet = faucet === DEVNET.faucet;
  return {
    faucet,
    rpc: process.env.FLOP_RPC || f.rpc || (onDevnet ? DEVNET.rpc : null),
    indexer: process.env.FLOP_INDEXER_URL || f.indexer || (onDevnet ? DEVNET.indexer : null),
    gateway: process.env.FLOP_GATEWAY || f.gateway || DEVNET.gateway
  };
}

export async function getJson(url, ms = 30_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

/** The faucet's view of its chain; throws when it does not answer with a genesis. */
export async function chainInfo(cfg = networkConfig()) {
  const { status, body } = await getJson(`${cfg.faucet}/chain`);
  if (status !== 200 || !body?.genesisHash) throw new Error(`faucet ${cfg.faucet}/chain answered ${status}`);
  return body;
}

/** Connect to the network's RPC and refuse a genesis that differs from the faucet's. */
export async function connect(cfg = networkConfig()) {
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const info = await chainInfo(cfg);
  const rpc = cfg.rpc || info.rpc;
  if (!rpc) throw new Error('no RPC: set rpc in network.json or FLOP_RPC');
  const api = await ApiPromise.create({ provider: new WsProvider(rpc), noInitWarn: true, throwOnConnect: true });
  if (api.genesisHash.toHex() !== info.genesisHash) {
    const got = api.genesisHash.toHex();
    await api.disconnect();
    throw new Error(`genesis mismatch: rpc ${got} faucet ${info.genesisHash}`);
  }
  return { api, info, rpc, cfg };
}

/** The agent's SS58 address (no key material leaves this function). */
export function agentIdentity(agent = 'scout') {
  return JSON.parse(fs.readFileSync(path.join(DATA, '.secrets', `${agent}-identity.json`), 'utf8'));
}

/** Ed25519 signer from the agent's did:key identity. Never print what this returns. */
export async function agentSigner(agent = 'scout', ss58Format = 42) {
  const { Keyring } = await import('@polkadot/keyring');
  const { cryptoWaitReady } = await import('@polkadot/util-crypto');
  const id = agentIdentity(agent);
  const seed = Buffer.from(crypto.createPrivateKey(id.privateKeyPem).export({ format: 'jwk' }).d, 'base64url');
  await cryptoWaitReady();
  return new Keyring({ type: 'ed25519', ss58Format }).addFromSeed(seed);
}

/** Append one JSON line under DATA/data/local. */
export function logLine(file, entry) {
  const p = path.join(DATA, 'data/local', file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export const flop = (planck) => (planck === null || planck === undefined ? '-' : (Number(BigInt(planck) / 10n ** 12n) / 1e6).toFixed(6));

export const opt = (args, name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
