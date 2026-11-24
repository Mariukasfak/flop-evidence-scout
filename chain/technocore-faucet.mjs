#!/usr/bin/env node
/**
 * The agent's daily faucet request in the official Technocore faucet room.
 *
 *   node technocore-faucet.mjs --agent scout [--check]
 *
 * User consent 2026-11-23: ONE official faucet request per agent per UTC day (Scout
 * and Scribe), nothing else posted. This script enforces that: it refuses a second
 * post the same UTC day for the same agent and network, whatever the outcome of the
 * first, and it posts exactly `!faucet request <own ss58> <nonce>`.
 *
 * The room and the bot DID come from the faucet's own /chain (`technocoreBot`), so the
 * script follows the network in net.mjs and never posts into a room a stranger named.
 * The message is signed with the agent's did:key, the same ed25519 key as its FLOP
 * address. After posting it reads the room for the bot's reply to our seq (up to two
 * minutes) and logs it to data/local/flop-technocore-faucet.jsonl.
 *
 * Devnet 2026-11-23: the bot funds 2 FLOP directly and answers
 * "request #<seq>: … Funded 2 devnet FLOP to <ss58>, tx 0x…". A next grant needs a
 * higher nonce (ms timestamp), the anon_agent cooldown and on-chain use of the grant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { networkConfig, getJson, resolveChainInfo, agentIdentity, agentSigner, logLine, DATA, opt } from './net.mjs';

const args = process.argv.slice(2);
const agent = opt(args, 'agent', 'scout');
const check = args.includes('--check');
const cfg = networkConfig();

const chain = (await getJson(`${cfg.faucet}/chain`)).body;
// Only the bot of the pinned chain: a faucet still on another chain names that chain's room.
if (cfg.genesis) {
  try { if (!resolveChainInfo(cfg, { status: 200, body: chain }).faucetLive) throw new Error('faucet gave no genesis'); }
  catch (err) { console.log(`${err.message}; nothing posted`); process.exit(2); }
}
const bot = chain?.technocoreBot;
if (!bot?.room || !bot?.did) { console.log(`faucet ${cfg.faucet}/chain names no technocoreBot room/did; nothing posted`); process.exit(2); }
const network = chain.network ?? 'unknown';
const genesis8 = String(chain.genesisHash ?? '').slice(2, 10);
const signer = await agentSigner(agent, chain.ss58Format ?? 42);
const identity = agentIdentity(agent);

const day = new Date().toISOString().slice(0, 10);
const stateFile = path.join(DATA, 'data/local', 'flop-technocore-faucet-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
const key = `${network}-${genesis8}-${agent}`;
console.log(`${network} room ${bot.room} bot ${bot.did.slice(0, 16)}… | ${agent} ${signer.address} | last post ${state[key]?.day ?? 'never'}`);
if (state[key]?.day === day) { console.log(`already posted today (${day}) for ${agent}; one per day, nothing posted`); process.exit(0); }
if (check) { console.log('check only: nothing posted'); process.exit(0); }

const { TechnocoreClient } = await import(pathToFileURL(path.join(DATA, 'src', 'technocore-client.mjs')).href);
const client = new TechnocoreClient({ evidenceDir: path.join(DATA, 'data/local/evidence') });
const nonce = Date.now();
const text = `!faucet request ${signer.address} ${nonce}`;

// Record the day BEFORE posting: an ambiguous network failure must not lead to a second post.
state[key] = { day, at: new Date().toISOString(), nonce };
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

let seq = null;
try {
  const r = await client.postMessage(bot.room, text, identity);
  for (const l of String(r.raw ?? '').split('\n')) {
    const m = l.match(/^\[(\d+)\] \S+ <([^>]+)> (.*)$/);
    if (m && m[3] === text) seq = Number(m[1]);
  }
} catch (err) {
  logLine('flop-technocore-faucet.jsonl', { agent, network, room: bot.room, address: signer.address, nonce, outcome: 'post-failed', error: err.message });
  console.log(`post failed: ${err.message} (not retried today)`);
  process.exit(2);
}
console.log(`posted seq ${seq ?? '?'}: ${text}`);

// The bot answers "request #<seq>: …". Its DID shows shortened as <z6Mk…last4>.
const botTail = bot.did.slice(-4);
let reply = null;
for (let i = 0; i < 24 && !reply; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const room = await client.readRoom(bot.room, { limit: 60 }).catch(() => null);
  const raw = typeof room === 'string' ? room : (room?.raw ?? room?.text ?? JSON.stringify(room ?? ''));
  for (const l of String(raw).split('\n')) {
    const m = l.match(/^\[(\d+)\] \S+ <([^>]+)> (.*)$/);
    if (m && m[2].endsWith(botTail) && (seq ? m[3].includes(`#${seq}`) : m[3].includes(signer.address))) reply = m[3];
  }
}
const funded = reply && /Funded\s+[\d.]+/i.test(reply) && reply.includes(signer.address);
const tx = reply?.match(/tx (0x[0-9a-fA-F]{64})/)?.[1] ?? null;
logLine('flop-technocore-faucet.jsonl', { agent, network, room: bot.room, address: signer.address, nonce, seq, outcome: funded ? 'funded' : reply ? 'refused' : 'no-reply', tx, reply: reply?.slice(0, 400) ?? null });
console.log(funded ? `funded, tx ${tx}` : reply ? `bot answered without funding: ${reply.slice(0, 300)}` : 'no bot reply within two minutes (not retried today)');
