/**
 * The one reader of close-1's rooms: a durable cursor per room, gap detection,
 * and raw evidence written before anything downstream sees a message.
 *
 * technocore.chat's read returns the NEWEST `limit` records after `since`
 * (upstream #481), so a reader cannot page forward: if more than `limit`
 * records arrived since our cursor, the oldest are gone from our view. The
 * response's `first_seq` says so — a first record past cursor+1 is a gap, and
 * this module records it instead of carrying on as if nothing happened. A
 * changed `generation` means the room was recreated and our cursor refers to a
 * different conversation; that is recorded as a gap too.
 *
 * Read failures are returned, counted and time-stamped; the risk gate reads
 * `lastOkAt` and `errors5m`, so a dead read cannot pass for a quiet room.
 *
 * Quiet rooms (the referee's, one post per sweep) are long-polled with `wait`;
 * busy `close1` is read without waiting, often enough to keep up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SIG_STATUS, SOURCE } from './evidence-store.mjs';

const FIVE_MIN = 300_000;

export class RoomStream {
  /**
   * @param rooms  { [room]: { wait?: seconds, keep?: (msg) => boolean, verify?: (msg) => {sigStatus, source} } }
   */
  constructor({ client, evidence, cursorFile, rooms, now = () => Date.now(), limit = 200 }) {
    this.client = client;
    this.evidence = evidence;
    this.cursorFile = cursorFile;
    this.rooms = rooms;
    this.now = now;
    this.limit = limit;
    this.state = {};
    this.load();
  }

  blank() {
    return { cursor: 0, generation: null, gaps: [], errors: [], lastOkAt: null, lastError: null, reads: 0, kept: 0 };
  }

  load() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')); } catch { /* first run */ }
    for (const room of Object.keys(this.rooms)) this.state[room] = { ...this.blank(), ...(saved[room] || {}) };
  }

  /** Write the cursors atomically: a torn file would restart every room from zero. */
  save() {
    fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
    const tmp = `${this.cursorFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.cursorFile);
  }

  /**
   * Start a room at its head on purpose, e.g. before watching close1 for takers
   * of an offer we are about to post. Recorded as a deliberate skip, not a gap.
   */
  async seekHead(room) {
    const r = await this.client.readRoom(room, { limit: 1, format: 'json' });
    const s = this.state[room];
    s.cursor = r.lastSeq ?? r.messages.at(-1)?.seq ?? s.cursor;
    s.generation = r.generation ?? s.generation;
    s.skippedAt = new Date(this.now()).toISOString();
    s.lastOkAt = this.now();
    this.save();
  }

  /**
   * One read of one room. Returns { ok, messages, gap } — messages carry
   * `sigStatus` and `source` from the room's verifier. On failure returns
   * { ok: false, error } and leaves the cursor where it was.
   */
  async poll(room, { wait } = {}) {
    const cfg = this.rooms[room];
    const s = this.state[room];
    let r;
    try {
      r = await this.client.readRoom(room, {
        since: s.cursor > 0 ? s.cursor : null,
        wait: wait ?? cfg.wait ?? 0,
        limit: this.limit,
        format: 'json'
      });
    } catch (err) {
      s.errors.push(this.now());
      s.lastError = String(err.message || err).slice(0, 200);
      this.trim(s);
      this.save();
      return { ok: false, error: s.lastError };
    }
    s.reads += 1;
    let gap = null;
    const generation = r.generation ?? null;
    if (s.generation !== null && generation !== null && generation !== s.generation) {
      gap = { kind: 'generation', from: s.generation, to: generation, at: new Date(this.now()).toISOString() };
      s.cursor = 0;
    }
    s.generation = generation ?? s.generation;
    const fresh = (r.messages || []).filter((m) => Number.isInteger(m.seq) && m.seq > s.cursor);
    const firstSeq = r.firstSeq ?? fresh[0]?.seq ?? null;
    if (!gap && s.cursor > 0 && firstSeq !== null && firstSeq > s.cursor + 1 && fresh.length) {
      gap = { kind: 'ring', from: s.cursor + 1, to: fresh[0].seq - 1, records: fresh[0].seq - 1 - s.cursor, at: new Date(this.now()).toISOString() };
    }
    if (gap) s.gaps.push(gap);

    const out = fresh.map((m) => {
      const v = cfg.verify ? cfg.verify(m) : { sigStatus: SIG_STATUS.NOT_CHECKED, source: SOURCE.UNVERIFIED };
      return { ...m, room, generation, sigStatus: v.sigStatus, source: v.source, body: v.body };
    });
    const keep = out.filter((m) => (cfg.keep ? cfg.keep(m) : true));
    this.evidence.append(keep.map((m) => this.evidence.record(room, m, { generation, sigStatus: m.sigStatus, source: m.source })));
    s.kept += keep.length;
    if (fresh.length) s.cursor = fresh.at(-1).seq;
    s.lastOkAt = this.now();
    this.trim(s);
    this.save();
    return { ok: true, messages: out, gap };
  }

  trim(s) {
    const cutoff = this.now() - FIVE_MIN;
    s.errors = s.errors.filter((t) => t >= cutoff);
    if (s.gaps.length > 50) s.gaps = s.gaps.slice(-50);
  }

  /** Per-room summary for the runtime snapshot. */
  stats() {
    const out = {};
    const cutoff = this.now() - FIVE_MIN;
    for (const [room, s] of Object.entries(this.state)) {
      out[room] = {
        cursor: s.cursor,
        generation: s.generation,
        gaps: s.gaps.length,
        lastGap: s.gaps.at(-1) ?? null,
        errors5m: s.errors.filter((t) => t >= cutoff).length,
        lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
        lastError: s.lastError
      };
    }
    return out;
  }
}
