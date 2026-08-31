/**
 * One writer at a time, across machines that cannot see each other.
 *
 * Running the agent on a home PC *and* in GitHub Actions is strictly better than
 * either alone — they fail for unrelated reasons, so the union of their uptime
 * beats both. But it breaks the one assumption every guardrail here rests on:
 * that a single process decides when this identity speaks.
 *
 * The workflow already has a `concurrency` group, and it is useless for this. It
 * serialises GitHub runs against each other and cannot see a process on someone's
 * desk. Two writers sharing one did:key would read the same publication history,
 * both conclude the gap had elapsed, and both post — turning the project whose
 * entire argument is "we are not the agents spamming the lobby" into two of them.
 *
 * Technocore gives us exactly the primitive needed. Note writes accept
 * `if_absent=1` and `if=<value>`, both evaluated server-side, so a lease is a
 * compare-and-set on a note:
 *
 *   acquire   set(mine, if_absent)          nobody holds it
 *   take over set(mine, if=<expired value>) the holder is gone
 *   renew     set(mine, if=<my value>)      still mine, push the expiry out
 *   release   set(expired, if=<my value>)   hand it back immediately
 *
 * The value is a plain `holder|expiryMs` token rather than JSON, deliberately.
 * getKv() JSON-parses anything that parses, and setKv() runs a single-line sweep
 * on the way in — so a JSON lease would be re-serialised on read and the exact
 * string needed for `if=` would no longer be recoverable. A token with no spaces
 * and no quotes survives both untouched.
 */

const HOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * Was that write refused, or did it never arrive?
 *
 * A conditional write losing to a competitor comes back 4xx — the precondition
 * genuinely failed. A 5xx or a network error means the attempt never got a
 * verdict, and calling that a lost race is the same conflation that made a
 * transient outage read as contention.
 */
function isTransientWriteFailure(err) {
  const status = Number(String(err?.message ?? '').match(/HTTP (\d{3})/)?.[1]);
  if (!Number.isFinite(status)) return true;      // timeouts, DNS, aborts
  return status >= 500;
}

export const DEFAULT_LEASE_NS = 'lease';
export const DEFAULT_TTL_MS = 10 * 60 * 1000;      // survives a missed renewal
export const DEFAULT_RENEW_MS = 2 * 60 * 1000;     // five renewals per lease

/** `holder|expiryMs` — no spaces, no quotes, no JSON. */
export function encodeLease(holder, expiresAt) {
  if (!HOLDER_PATTERN.test(holder)) {
    throw new Error(`lease holder must match ${HOLDER_PATTERN}: ${holder}`);
  }
  return `${holder}|${Math.floor(expiresAt)}`;
}

export function decodeLease(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^([a-z0-9][a-z0-9-]{0,38})\|(\d+)$/);
  if (!match) return null;
  return { holder: match[1], expiresAt: Number(match[2]) };
}

/**
 * A stable-ish id for this process.
 *
 * Includes a random suffix on purpose: two runs on the same machine are two
 * writers, and a holder id that collided between them would let a stale process
 * renew a lease it had already lost.
 */
export function makeHolderId(label = 'local') {
  const clean = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'x';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${clean}-${suffix}`;
}

/**
 * A lease over one named responsibility.
 *
 * Every method reports what actually happened rather than throwing on the normal
 * case — losing a race is the expected outcome for whichever process is second,
 * not an error.
 */
export class Lease {
  constructor({ client, name, holder, ttlMs = DEFAULT_TTL_MS, ns = DEFAULT_LEASE_NS, now = () => Date.now(), readAttempts = 3 }) {
    if (!client) throw new Error('a lease needs a Technocore client');
    if (!name) throw new Error('a lease needs a name');
    this.client = client;
    this.name = name;
    this.ns = ns;
    this.holder = holder || makeHolderId();
    this.ttlMs = ttlMs;
    this.now = now;
    /** How many times a read may be retried before an outage is believed. */
    this.readAttempts = Math.max(1, readAttempts);
    /** The exact string we last wrote, which is what `if=` must be given. */
    this.currentValue = null;
    this.heldUntil = 0;
  }

  /**
   * Raw current value, as stored — not parsed, because `if=` needs it verbatim.
   *
   * Returns `reachable: false` rather than pretending the note is absent when
   * the server cannot be reached. The first version of this used getKv(), which
   * returns null for "no note" and null for "HTTP 503" alike; a transient outage
   * was therefore read as "the lease is free", the claim failed on the same
   * outage, and the daemon announced "lost the race to claim it". Nobody was
   * racing. Describing an outage as contention sends the reader to the wrong
   * place entirely.
   */
  async read(attempts = this.readAttempts) {
    if (typeof this.client.readNote === 'function') {
      /**
       * Retried, because one attempt is not a measurement.
       *
       * The lease gates the entire cycle, so a single 503 on this one read
       * stood the agent down for fifteen seconds — and Technocore returns 503s
       * in bursts. Over one measured run that was 141 cycles out of 570: a
       * quarter of the agent's working time spent waiting on a server that
       * answered fine on the next request.
       *
       * Distinguishing an outage from an absent note was the earlier fix here,
       * and it was correct. It was not enough on its own.
       */
      let note = await this.client.readNote(this.ns, this.name);
      for (let attempt = 1; attempt < attempts && !note.reachable; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
        note = await this.client.readNote(this.ns, this.name);
      }
      if (!note.reachable) return { reachable: false, value: null, error: note.error };
      // A lease token never parses as JSON, so anything else here is somebody
      // else's data and is handled by the caller, not overwritten.
      return { reachable: true, value: note.found ? String(note.value ?? '').trim() : null };
    }

    // Fallback for a client without readNote. Cannot tell absence from failure,
    // and says so rather than guessing.
    const value = await this.client.getKv(this.ns, this.name);
    return { reachable: true, value: typeof value === 'string' ? value.trim() : null };
  }

  /**
   * Try to become the single writer.
   *
   * Three ways in: nobody holds it, the holder's lease expired, or we already
   * hold it. Every one of them is a server-side conditional write, so two
   * processes racing cannot both succeed.
   */
  async acquire() {
    const now = this.now();
    const mine = encodeLease(this.holder, now + this.ttlMs);
    const state = await this.read();

    /**
     * A lease we already hold does not stop being ours when the server blinks.
     *
     * Measured 2026-08-31 over 69 probes two seconds apart: 43 × 503, 5 timeouts,
     * 21 × 200 — a 30% success rate, with failures arriving in runs of up to 23
     * in a row, about 45 seconds. Against that, retrying for two seconds is not
     * a retry. Overnight it cost 224 of 579 cycles: the agent stood down for
     * 39% of its working time while nothing was wrong with it.
     *
     * But an unreadable note is not evidence that our lease ended. We wrote it
     * ourselves, we know when it expires, and no other process may take it
     * before then — that is the whole guarantee the TTL provides. So while the
     * clock says it is still ours, we keep working and try to renew next cycle.
     *
     * The margin matters: this only holds while a comfortable slice of the TTL
     * remains. Near expiry the honest answer is that we no longer know, and the
     * safe move is to stand down rather than risk two writers.
     */
    if (!state.reachable) {
      const remainingMs = this.heldUntil - now;
      if (this.currentValue && remainingMs > this.ttlMs / 3) {
        return {
          acquired: true,
          degraded: true,
          reason: `server unreachable (${state.error || 'unknown'}), but our lease runs for another ${Math.ceil(remainingMs / 1000)}s`
        };
      }
      return { acquired: false, transient: true, reason: `server unreachable (${state.error || 'unknown'})` };
    }

    const existing = state.value;

    if (existing === null) {
      try {
        await this.client.setKv(this.ns, this.name, mine, { ifAbsent: true });
        this.currentValue = mine;
        this.heldUntil = now + this.ttlMs;
        return { acquired: true, reason: 'was unheld' };
      } catch (err) {
        if (isTransientWriteFailure(err)) {
          return { acquired: false, transient: true, reason: `claim did not reach the server (${err.message})` };
        }
        // A 4xx means the precondition genuinely failed: someone claimed it
        // between our read and our write. That is the only real race.
        return { acquired: false, reason: 'lost the race to claim it' };
      }
    }

    const current = decodeLease(existing);
    if (!current) {
      return { acquired: false, reason: 'the lease note holds something that is not a lease' };
    }

    const isMine = current.holder === this.holder;
    const isExpired = current.expiresAt <= now;

    if (!isMine && !isExpired) {
      return {
        acquired: false,
        reason: `held by ${current.holder} for another ${Math.ceil((current.expiresAt - now) / 1000)}s`,
        heldBy: current.holder,
        expiresAt: current.expiresAt
      };
    }

    try {
      await this.client.setKv(this.ns, this.name, mine, { ifValue: existing });
      this.currentValue = mine;
      this.heldUntil = now + this.ttlMs;
      return { acquired: true, reason: isMine ? 'renewed our own' : `took over from ${current.holder}, expired` };
    } catch (err) {
      if (isTransientWriteFailure(err)) {
        /**
         * The other half of the same argument.
         *
         * A read that fails no longer stands us down when the lease is already
         * ours. A failed RENEWAL was still doing exactly that — and it is the
         * more common case, because the renewal happens every cycle while the
         * lease only needs claiming once. In the four cycles after that fix
         * shipped, five standdowns came from the read path and four from this
         * one.
         *
         * The reasoning does not change with the verb. We wrote the note, the
         * server told us when it expires, and nobody may take it before then.
         * A renewal that did not arrive means we failed to EXTEND the lease, not
         * that we lost it — so we keep the cycle and try again next time, while
         * the clock still says it is ours.
         */
        const remainingMs = current.expiresAt - now;
        if (isMine && remainingMs > this.ttlMs / 3) {
          return {
            acquired: true,
            degraded: true,
            reason: `renewal did not reach the server (${err.message}), but ours runs for another ${Math.ceil(remainingMs / 1000)}s`
          };
        }
        return { acquired: false, transient: true, reason: `takeover did not reach the server (${err.message})` };
      }
      return { acquired: false, reason: 'lost the race; the value changed under us' };
    }
  }

  /**
   * Push the expiry out.
   *
   * Fails rather than re-acquiring if the value moved: a lease we lost and then
   * silently took back is the bug this class exists to prevent.
   */
  async renew() {
    if (!this.currentValue) return { renewed: false, reason: 'we do not hold it' };

    const now = this.now();
    const next = encodeLease(this.holder, now + this.ttlMs);
    try {
      await this.client.setKv(this.ns, this.name, next, { ifValue: this.currentValue });
      this.currentValue = next;
      this.heldUntil = now + this.ttlMs;
      return { renewed: true };
    } catch {
      this.currentValue = null;
      this.heldUntil = 0;
      return { renewed: false, reason: 'the lease was taken while we held it' };
    }
  }

  /**
   * Hand it back at once instead of making the next process wait out the TTL.
   *
   * Best-effort by design: a process being killed cannot release anything, which
   * is exactly why the expiry exists as the real mechanism.
   */
  async release() {
    if (!this.currentValue) return { released: false, reason: 'we do not hold it' };
    const expired = encodeLease(this.holder, this.now() - 1);
    try {
      await this.client.setKv(this.ns, this.name, expired, { ifValue: this.currentValue });
      this.currentValue = null;
      this.heldUntil = 0;
      return { released: true };
    } catch {
      this.currentValue = null;
      this.heldUntil = 0;
      return { released: false, reason: 'it was already taken' };
    }
  }

  /**
   * Do we still hold it *right now*?
   *
   * Local check against the expiry we wrote. It answers "is it safe to act",
   * and the honest answer near the boundary is no — hence the safety margin,
   * which stops a long operation starting a second before the lease lapses.
   */
  isHeld(marginMs = 30_000) {
    return this.currentValue !== null && this.now() + marginMs < this.heldUntil;
  }
}

/**
 * Run something only if we can hold the lease for it.
 *
 * The shape a scheduled run wants: try, do the work if we won, and always hand
 * the lease back so the other machine is not locked out for a full TTL.
 */
export async function withLease({ client, name, holder, ttlMs = DEFAULT_TTL_MS, ns = DEFAULT_LEASE_NS, now }, work) {
  const lease = new Lease({ client, name, holder, ttlMs, ns, now });
  const attempt = await lease.acquire();
  if (!attempt.acquired) {
    return { ran: false, reason: attempt.reason, heldBy: attempt.heldBy ?? null };
  }

  try {
    const result = await work(lease);
    return { ran: true, result };
  } finally {
    await lease.release();
  }
}
