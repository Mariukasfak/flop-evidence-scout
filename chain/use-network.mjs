#!/usr/bin/env node
/**
 * Switch the chain scripts to another network, only after checking it.
 *
 *   node use-network.mjs testnet|devnet [--dry]
 *
 * Reads network.<name>.json, connects to its RPC and requires the pinned genesis
 * (connect() refuses a faucet or RPC on another chain), reports whether its faucet
 * answers, then copies the file over network.json (the old one kept as
 * network.json.bak). Signs nothing, funds nothing. A running flop-lane keeps its
 * network until it is restarted; its lane.json miners must be miners of that chain
 * (pick-miners.mjs after the switch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
const dry = process.argv.includes('--dry');
if (!/^[a-z0-9-]+$/.test(name ?? '')) { console.log('usage: node use-network.mjs testnet|devnet [--dry]'); process.exit(2); }
const src = path.join(here, `network.${name}.json`);
if (!fs.existsSync(src)) { console.log(`${src} not found`); process.exit(2); }
const want = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!want.genesis || !want.rpc) { console.log(`${src} needs genesis and rpc`); process.exit(2); }

process.env.FLOP_NETWORK_FILE = src;
const { networkConfig, connect } = await import('./net.mjs');
const cfg = networkConfig();
let c;
try { c = await connect(cfg); } catch (err) { console.log(`not switched: ${err.message}`); process.exit(1); }
const spec = c.api.runtimeVersion.specVersion.toNumber();
const head = (await c.api.rpc.chain.getHeader(await c.api.rpc.chain.getFinalizedHead())).number.toNumber();
let admits = null;
try { const { SUPPORTED_SPEC_VERSIONS } = await import('@flop-labs/sdk'); admits = [...SUPPORTED_SPEC_VERSIONS].includes(spec); } catch { /* sdk missing */ }
await c.api.disconnect();

console.log(`${c.info.chain} genesis ${c.info.genesisHash.slice(0, 12)}… ok | runtime ${spec} (SDK ${admits === null ? '?' : admits ? 'admits it' : 'does NOT admit it'}) | finalized #${head}`);
console.log(c.info.faucetLive ? `faucet ${cfg.faucet} serves this chain` : `no faucet yet (${c.info.faucetError})`);
if (admits === false) { console.log('not switched: install an SDK that admits this runtime first'); process.exit(1); }
if (dry) { console.log('dry run: network.json unchanged'); process.exit(0); }

const dst = path.join(here, 'network.json');
if (fs.existsSync(dst)) fs.copyFileSync(dst, `${dst}.bak`);
fs.copyFileSync(src, dst);
console.log(`network.json is now ${name}${fs.existsSync(`${dst}.bak`) ? ' (previous kept as network.json.bak)' : ''}. Restart flop-lane to move it; set lane.json miners from pick-miners.mjs on this chain.`);
