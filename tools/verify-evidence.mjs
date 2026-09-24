#!/usr/bin/env node
/**
 * Re-verify every signed write in data/local/evidence against its own DID.
 *
 * Nothing here asks the venue: the signature covers `room|nonce|text`, so a
 * kept line either verifies from the file alone or it is not evidence.
 *
 *   node tools/verify-evidence.mjs [dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifyMessage } from '../src/identity.mjs';

export function verifyEvidenceLine(entry) {
  try {
    return verifyMessage(`${entry.room}|${entry.nonce}|${entry.text}`, entry.sig, entry.did);
  } catch {
    return false;
  }
}

export function summarize(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^signed-posts-.*\.jsonl$/.test(f)).sort() : [];
  const out = { files: files.length, lines: 0, verified: 0, failed: 0, byDid: {}, byRoom: {}, first: null, last: null };
  for (const f of files) {
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      out.lines++;
      let e; try { e = JSON.parse(raw); } catch { out.failed++; continue; }
      if (!verifyEvidenceLine(e)) { out.failed++; continue; }
      out.verified++;
      out.byDid[e.did] = (out.byDid[e.did] || 0) + 1;
      out.byRoom[e.room] = (out.byRoom[e.room] || 0) + 1;
      out.first ??= e.at;
      out.last = e.at;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-evidence.mjs')) {
  const dir = process.argv[2] || path.resolve('data/local/evidence');
  const s = summarize(dir);
  console.log(`${dir}: ${s.files} file(s), ${s.lines} line(s), ${s.verified} verified, ${s.failed} failed`);
  if (s.first) console.log(`from ${s.first} to ${s.last}`);
  for (const [did, n] of Object.entries(s.byDid)) console.log(`  ${did.slice(-8)}  ${n}`);
  const rooms = Object.entries(s.byRoom).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [room, n] of rooms) console.log(`  /r/${room}  ${n}`);
  process.exitCode = s.failed ? 1 : 0;
}
