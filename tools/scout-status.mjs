/**
 * One-shot health check: asks technocore.chat what it actually knows about our
 * two agents. Everything printed here comes from the live server, not from a
 * local file, so it cannot report success for something that never happened.
 *
 * Run: node tools/scout-status.mjs   (or double-click patikrinti-busena.bat)
 */
import { loadOrCreateIdentity, getDidShardedPath, getStateKey, getShortId } from '../src/identity.mjs';

const BASE = process.env.TECHNOCORE_URL || 'https://technocore.chat';

async function get(pathname) {
  try {
    const res = await fetch(`${BASE}${pathname}`, { headers: { 'user-agent': 'FLOP-Scout-Status/1.0' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.replace(/^!!.*$/m, '').trim() };
  } catch (err) {
    return { ok: false, status: 0, text: err.message };
  }
}

function line(label, ok, detail) {
  console.log(`${ok ? '  OK ' : '  -- '} ${label.padEnd(28)} ${detail}`);
}

const scout = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
const scribe = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');

console.log('\n=== FLOP Evidence Scout — busena pagal gyva technocore.chat ===\n');

for (const [name, identity] of [['Scout', scout], ['Scribe', scribe]]) {
  const { fullPath } = getDidShardedPath(identity.did);
  console.log(`[${name}] ${identity.did}`);

  const profile = await get(fullPath);
  line('DID profilis tinkle', profile.ok && profile.text.includes('did:'), fullPath);

  const ns = name === 'Scout' ? 'scout' : 'scribe';
  const stateKey = getStateKey(identity.did, ns);
  const state = await get(`/kv/${ns}/${stateKey}`);
  let turns = '?';
  try { turns = JSON.parse(state.text).totalTurns; } catch { /* not JSON yet */ }
  line('/kv/ busenos atmintis', state.ok, `/kv/${ns}/${stateKey} (ciklu: ${turns})`);

  const room = name === 'Scout' ? 'technocore' : 'events';
  const hb = await get(`/kv/${room}/hb-${getShortId(identity.did)}`);
  line('presence heartbeat', hb.ok, `/kv/${room}/hb-${getShortId(identity.did)} = ${hb.text || '-'}`);
  console.log('');
}

const limits = await get('/.well-known/agent.json');
try {
  const l = JSON.parse(limits.text).limits;
  console.log(`Serverio ribos: ${l.reads_per_minute_per_ip} skaitymai/min, ${l.writes_per_minute_per_ip} rasymai/min vienam IP\n`);
} catch {
  console.log('Serverio ribu nuskaityti nepavyko\n');
}
