import fs from 'node:fs';
import path from 'node:path';

import { TechnocoreClient } from './technocore-client.mjs';
import { loadOrCreateIdentity } from './identity.mjs';

const identity = loadOrCreateIdentity('.secrets/scout-identity.json');
const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });

console.clear();
console.log('='.repeat(70));
console.log('  FLOP / TECHNOCORE LIVE NETWORK MONITOR & SCOUT DASHBOARD');
console.log('='.repeat(70));
console.log(`  Agent DID:   ${identity.did}`);
console.log(`  Target Node: https://technocore.chat (Room: lobby)`);
console.log(`  Audit Log:   data/scout-audit.jsonl`);
console.log('='.repeat(70));
console.log('  Listening to live messages from Technocore network...\n');

let lastSeq = null;

async function poll() {
  try {
    const res = await client.readRoom('lobby', lastSeq);
    const messages = res.messages || [];

    for (const msg of messages) {
      if (lastSeq !== null && msg.seq <= lastSeq) continue;
      lastSeq = Math.max(lastSeq ?? 0, msg.seq);

      const isMe = msg.from.includes(identity.did.slice(-4)) || msg.from === identity.did;
      const tag = isMe ? '\x1b[32m[MY SCOUT AGENT]\x1b[0m' : '\x1b[36m[AGENT]\x1b[0m';
      const sender = isMe ? `\x1b[32m<${msg.from}>\x1b[0m` : `<${msg.from}>`;
      const time = new Date(msg.timestamp).toLocaleTimeString('lt-LT');

      console.log(`[#${msg.seq}] ${time} ${tag} ${sender}`);
      console.log(`     ${msg.content}\n`);
    }

    // Read heartbeat if available
    const heartbeatPath = path.resolve('data/scout-heartbeat.json');
    if (fs.existsSync(heartbeatPath)) {
      const hb = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
      process.stdout.write(`\r\x1b[90m[Status: ${hb.status} | Turns: ${hb.turns} | Handled: ${hb.handledCount} | Last: ${hb.lastAction} | ${new Date().toLocaleTimeString('lt-LT')}]\x1b[0m `);
    }
  } catch (err) {
    process.stdout.write(`\r\x1b[31m[Network error: ${err.message}]\x1b[0m `);
  }
}

// Poll every 3 seconds
poll();
setInterval(poll, 3000);
