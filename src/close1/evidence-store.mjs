/**
 * Append-only raw evidence for close-1: what a room said, exactly as it said it.
 *
 * One JSON line per record, one file per UTC day, never rewritten. A record
 * keeps the room, seq, generation, the server's stamp, our receive time, the
 * author DID, the raw text, nonce and signature, whether the signature
 * verified, a SHA-256 of the text and how much we trust the source.
 *
 * Not every message of `close1` is kept: it runs ~3,600 records a minute
 * (2026-09-25), ~2.5 GB a day. The stream keeps every referee post and the
 * close1 records that concern us (our ids, our key, an offer we act on).
 *
 * Duplicates are harmless: readers de-duplicate on (room, generation, seq), so
 * a crash between append and cursor save costs a repeated line, never a lost one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How far a record may be trusted, in the contest-source trust order. */
export const SOURCE = Object.freeze({
  REFEREE_SIGNED: 'REFEREE_SIGNED',   // author is the pinned referee and the signature verifies
  PEER_SIGNED: 'PEER_SIGNED',         // a peer's signature verifies
  OWN: 'OWN',                         // posted by us
  UNVERIFIED: 'UNVERIFIED'            // signature missing or not checked
});

export const SIG_STATUS = Object.freeze({ VERIFIED: 'VERIFIED', INVALID: 'INVALID', UNSIGNED: 'UNSIGNED', NOT_CHECKED: 'NOT_CHECKED' });

export const contentHash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
export const recordKey = (r) => `${r.room}:${r.generation ?? 0}:${r.seq}`;

export class EvidenceStore {
  constructor({ dir, now = () => Date.now() }) {
    this.dir = dir;
    this.now = now;
  }

  fileFor(ms) {
    return path.join(this.dir, `close1-raw-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
  }

  /** Build the record for one room message. */
  record(room, msg, { generation = null, sigStatus = SIG_STATUS.NOT_CHECKED, source = SOURCE.UNVERIFIED } = {}) {
    return {
      room,
      seq: msg.seq,
      generation,
      ts: msg.ts ?? msg.timestamp ?? null,
      received_at: new Date(this.now()).toISOString(),
      from: msg.from ?? null,
      text: msg.text,
      nonce: msg.nonce ?? null,
      sig: msg.sig ?? null,
      sig_status: sigStatus,
      sha256: contentHash(msg.text),
      source
    };
  }

  /** Append records; only ever appends. */
  append(records) {
    if (!records.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const byFile = new Map();
    for (const r of records) {
      const f = this.fileFor(this.now());
      byFile.set(f, (byFile.get(f) || '') + JSON.stringify(r) + '\n');
    }
    for (const [f, body] of byFile) fs.appendFileSync(f, body);
  }

  /** Every record for `room`, de-duplicated on (room, generation, seq), in seq order. */
  read(room) {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^close1-raw-.*\.jsonl$/.test(f)).sort(); } catch { return []; }
    const seen = new Map();
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.room !== room) continue;
        const k = recordKey(r);
        if (!seen.has(k)) seen.set(k, r);
      }
    }
    return [...seen.values()].sort((a, b) => (a.generation ?? 0) - (b.generation ?? 0) || a.seq - b.seq);
  }
}
