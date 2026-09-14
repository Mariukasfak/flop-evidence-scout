/**
 * Keep up with a fast room by reading it often enough that the ring never gets
 * ahead of us.
 *
 * Measured 2026-09-14 over 1,353 consecutive cycles: on `/r/lobby` **every**
 * read had a gap, median 1,354 records, and 1,484,982 of 1,755,382 records --
 * 86.6% -- fell between our cursor and the first record of the response. The
 * daemon reads each room once per ~64 s cycle at `limit=200`, and lobby writes
 * ~1,064-1,529 a minute, so 200 records is 8-11 seconds of traffic against a
 * 64-second cadence. The arithmetic was never going to work.
 *
 * **There is no catch-up read.** The obvious fix -- loop with `since=cursor`
 * until the response is short -- cannot work, and that is the whole of upstream
 * issue #481: `read_messages` returns the *newest* `limit` records with
 * `seq > since` (`store.py:880`), not the oldest, so asking again with the same
 * cursor returns the same window. Nothing walks forward. `/export` does return
 * the whole ring, but at 5-10 MiB a call it is 7-14 GB/day at this cadence.
 *
 * So the only lever is frequency, and this module is that lever: poll each
 * followed room on its own schedule, sized from its own measured rate, and hand
 * the daemon whatever arrived since it last drained. The daemon's cycle, its
 * ordering and its inference budget are untouched -- this only changes how the
 * messages it already consumes get collected.
 */

/** Read at the rate that keeps expected arrivals to this share of the window. */
const TARGET_FILL = 0.6;

/** Never poll a room faster than this, whatever the measured rate says. */
const MIN_INTERVAL_MS = 3_000;

/** Never poll slower than this: a quiet room still needs a cursor that moves. */
const MAX_INTERVAL_MS = 45_000;

/**
 * A ceiling on our own footprint, in reads per minute across every followed room.
 *
 * The venue publishes 600 reads/min per IP (`/config`). The daemon's own cycle
 * spends about 8 of those. 90 leaves the budget almost untouched while still
 * affording 3 s on the hottest room we have, and it means a rate measurement
 * that goes wrong cannot turn into a request flood.
 */
const MAX_READS_PER_MINUTE = 90;

/**
 * How many drained messages to hold per room.
 *
 * Sized for a burst: lobby's worst observed minute is ~2,900/min, and the daemon
 * drains once a cycle, so this holds about a minute of the worst case. Past it
 * the oldest go, which is the same loss the ring imposes -- but counted here
 * rather than silent, because a buffer that overflows quietly is the failure
 * this whole module exists to stop being invisible.
 */
const MAX_BUFFER = 3_000;

export class RoomFollower {
  constructor({ client, rooms = [], readWindow = 200, selfDid = null, now = () => Date.now() }) {
    this.client = client;
    this.readWindow = readWindow;
    this.selfDid = selfDid;
    this.now = now;
    this.rooms = new Map();
    this.timers = new Map();
    this.running = false;
    for (const room of rooms) this.rooms.set(room, this.blankState());
  }

  blankState() {
    return {
      cursor: 0,
      buffer: [],
      dropped: 0,
      gaps: 0,
      gapRecords: 0,
      reads: 0,
      errors: 0,
      saturated: false,
      lastSeq: 0,
      lastSeenAt: 0,
      ratePerMin: null,
      peakPerMin: null,
      intervalMs: MIN_INTERVAL_MS * 2,
      generation: null
    };
  }

  /**
   * Seed from the cursor the daemon already has, so following starts where the
   * scout left off instead of re-reading a window it has already decided on.
   */
  seed(room, cursor) {
    if (!this.rooms.has(room)) this.rooms.set(room, this.blankState());
    const state = this.rooms.get(room);
    if (Number.isFinite(cursor) && cursor > state.cursor) state.cursor = cursor;
  }

  /**
   * The interval that keeps expected arrivals at TARGET_FILL of the window.
   *
   * Clamped at both ends, and then again by the global read budget, so the
   * hottest room cannot starve the others or the daemon.
   */
  intervalFor(state) {
    /**
     * Size off the room's recent *peak*, not its average.
     *
     * The second probe measured why the average is the wrong statistic:
     * `/r/technocore` sat at 230/min, which buys a 31 s interval, and then took
     * a burst that put 436 records past the cursor inside one of those
     * intervals. Saturation shortening only reacts after the gap it was meant to
     * prevent, and no smoothing predicts a burst -- but a room that burst to
     * 1,196/min ten minutes ago is a room that can do it again, so the interval
     * that survives it is the one sized for that number even while it is quiet.
     *
     * The peak decays 2% per observation, so a room that has genuinely calmed
     * relaxes over a few minutes instead of holding the fast cadence forever.
     */
    const basis = Math.max(state.ratePerMin || 0, state.peakPerMin || 0);
    if (basis <= 0) return MAX_INTERVAL_MS / 2;
    const seconds = (this.readWindow * TARGET_FILL) / (basis / 60);
    const budgetFloorMs = (this.rooms.size * 60_000) / MAX_READS_PER_MINUTE;
    let ms = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, budgetFloorMs, seconds * 1000));

    /**
     * A full response is direct evidence the interval is too long, and it
     * outranks the smoothed rate.
     *
     * The 6-minute probe on 2026-09-14 measured this: on the steady rooms the
     * rate estimate was enough -- lobby delivered 93.3% and tclk-offers 100% --
     * but `/r/technocore` swung between 371 and 1,196 a minute and delivered
     * only 56.5%, because an EMA that is slow enough not to chase noise is by
     * construction too slow to catch a burst. When `limit` records come back we
     * do not know how many did not, so the honest reading of a full window is
     * "possibly behind" rather than "exactly 200 arrived".
     */
    if (state.saturated) ms = Math.max(MIN_INTERVAL_MS, budgetFloorMs, ms / 3);
    return ms;
  }

  /**
   * Rate from the distance the head moved, not from how many records we kept.
   *
   * `last_seq` advances by everything written, including our own posts and
   * anything the response did not carry, so it measures the room. Counting
   * returned messages would measure the `limit` and quietly cap the estimate at
   * exactly the value that makes the interval look adequate.
   */
  observeRate(state, lastSeq, at) {
    if (state.lastSeq > 0 && lastSeq >= state.lastSeq && at > state.lastSeenAt) {
      const minutes = (at - state.lastSeenAt) / 60_000;
      if (minutes > 0) {
        const sample = (lastSeq - state.lastSeq) / minutes;
        // Slow to rise and slow to fall: one idle gap should not halve the cadence.
        state.ratePerMin = state.ratePerMin === null
          ? sample
          : state.ratePerMin * 0.7 + sample * 0.3;
        state.peakPerMin = state.peakPerMin === null
          ? sample
          : Math.max(sample, state.peakPerMin * 0.98);
      }
    }
    state.lastSeq = lastSeq;
    state.lastSeenAt = at;
  }

  async pollOnce(room) {
    const state = this.rooms.get(room);
    if (!state) return;
    let data = null;
    try {
      data = await this.client.readRoom(room, {
        since: state.cursor > 0 ? state.cursor : null,
        limit: this.readWindow,
        format: 'json'
      });
      state.reads += 1;
    } catch {
      state.errors += 1;
      return;
    }

    const at = this.now();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const lastSeq = Number(data?.last_seq || data?.lastSeq || 0);
    if (lastSeq > 0) this.observeRate(state, lastSeq, at);

    const generation = data?.generation ?? null;
    if (generation !== null && state.generation !== null && generation !== state.generation) {
      // A different conversation, not lost messages. Reset rather than count a gap.
      state.cursor = 0;
      state.lastSeq = 0;
      state.ratePerMin = null;
    }
    if (generation !== null) state.generation = generation;

    const firstSeq = Number(data?.first_seq ?? data?.firstSeq ?? 0);
    if (state.cursor > 0 && firstSeq > state.cursor + 1) {
      state.gaps += 1;
      state.gapRecords += firstSeq - state.cursor - 1;
    }

    for (const message of messages) {
      const seq = Number(message.seq || message.id || 0);
      if (seq <= state.cursor) continue;
      if (this.selfDid && message.from === this.selfDid) continue;
      state.buffer.push(message);
    }
    if (state.buffer.length > MAX_BUFFER) {
      state.dropped += state.buffer.length - MAX_BUFFER;
      state.buffer = state.buffer.slice(-MAX_BUFFER);
    }

    state.saturated = messages.length >= this.readWindow;

    const maxSeq = messages.reduce((acc, m) => Math.max(acc, Number(m.seq || m.id || 0)), state.cursor);
    if (maxSeq > state.cursor) state.cursor = maxSeq;
    state.intervalMs = this.intervalFor(state);
  }

  /** Reschedule after each poll rather than on a fixed timer: the interval moves. */
  schedule(room) {
    if (!this.running) return;
    const state = this.rooms.get(room);
    const delay = state?.intervalMs ?? MIN_INTERVAL_MS * 2;
    const timer = setTimeout(async () => {
      await this.pollOnce(room).catch(() => {});
      this.schedule(room);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(room, timer);
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const room of this.rooms.keys()) {
      // Stagger the first poll so every room does not hit the venue together.
      const spread = Math.floor(Math.random() * MIN_INTERVAL_MS);
      const timer = setTimeout(async () => {
        await this.pollOnce(room).catch(() => {});
        this.schedule(room);
      }, spread);
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.set(room, timer);
    }
  }

  stop() {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  has(room) {
    return this.rooms.has(room);
  }

  /** Everything collected since the last drain, oldest first, and the cursor it reached. */
  drain(room) {
    const state = this.rooms.get(room);
    if (!state) return null;
    const messages = state.buffer;
    state.buffer = [];
    messages.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    return {
      messages,
      cursor: state.cursor,
      gaps: state.gaps,
      gapRecords: state.gapRecords,
      dropped: state.dropped
    };
  }

  stats() {
    const out = {};
    for (const [room, state] of this.rooms) {
      out[room] = {
        ratePerMin: state.ratePerMin === null ? null : Math.round(state.ratePerMin),
        intervalMs: Math.round(state.intervalMs),
        reads: state.reads,
        errors: state.errors,
        gaps: state.gaps,
        gapRecords: state.gapRecords,
        dropped: state.dropped,
        buffered: state.buffer.length
      };
    }
    return out;
  }
}
