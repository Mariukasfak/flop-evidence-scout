import crypto from 'node:crypto';

/**
 * The pacing rules for testnet operations, decided before there is anything to
 * do and any temptation to do more of it.
 *
 * Hayes said on 2026-08-25 that allocation will depend on testnet activity. That
 * is exactly the sentence that turns a careful operator into a farm, so the
 * numbers are fixed here, in code, with the reasoning attached — rather than in
 * a document that gets quietly ignored at 3am when the faucet opens.
 *
 * What the limits are for:
 *
 *   Volume is not the risk. 24 operations a day is nothing against a server that
 *   permits 300 writes a minute. The risk is *shape*: every airdrop that has
 *   actually settled — LayerZero, Arbitrum, Hop — filtered on behaviour that
 *   looked machine-generated, and the cheapest tell is perfect regularity. An
 *   agent acting exactly on the hour, forever, is trivially clustered with every
 *   other agent doing the same.
 *
 *   So: a modest daily cap, no bursts, and a deliberately irregular gap. The
 *   jitter is not politeness. It is the point.
 */

export const TESTNET_POLICY = Object.freeze({
  maxPerDay: 24,
  maxPerHour: 4,
  minGapMs: 4 * 60 * 1000,        // never closer than 4 minutes
  jitterMs: 6 * 60 * 1000,        // plus 0-6 random minutes, so no fixed cadence
  requireHumanForValue: true      // anything moving value is never autonomous
});

/** Uniform jitter from a CSPRNG — a predictable gap is not a jittered one. */
function jitter(maxMs) {
  if (maxMs <= 0) return 0;
  return Math.floor((crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000) * maxMs);
}

export class TestnetPolicy {
  constructor({ policy = TESTNET_POLICY, state = null, now = () => Date.now() } = {}) {
    this.policy = { ...TESTNET_POLICY, ...policy };
    this.now = now;
    this.state = {
      operations: [],      // timestamps, ms
      nextAllowedAt: 0,
      totalEver: 0,
      ...(state || {})
    };
  }

  /** Drop anything older than a day; the caps are rolling windows, not calendar ones. */
  prune() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    this.state.operations = this.state.operations.filter((ts) => ts > cutoff);
    return this.state.operations;
  }

  countWithin(ms) {
    const cutoff = this.now() - ms;
    return this.state.operations.filter((ts) => ts > cutoff).length;
  }

  /**
   * @param {object} options
   * @param {boolean} options.movesValue  true for anything that spends, transfers
   *   or signs for value. Always refused without an explicit human approval.
   * @param {boolean} options.humanApproved  set only by a human-driven code path.
   */
  canOperate({ movesValue = false, humanApproved = false } = {}) {
    this.prune();
    const now = this.now();

    if (movesValue && this.policy.requireHumanForValue && !humanApproved) {
      return {
        allowed: false,
        reason: 'moves value and has no human approval — the agent never signs for value on its own',
        waitMs: null,
        terminal: true
      };
    }

    const perDay = this.state.operations.length;
    if (perDay >= this.policy.maxPerDay) {
      const oldest = this.state.operations[0];
      return {
        allowed: false,
        reason: `daily cap reached (${perDay}/${this.policy.maxPerDay})`,
        waitMs: Math.max(0, oldest + 24 * 60 * 60 * 1000 - now)
      };
    }

    const perHour = this.countWithin(60 * 60 * 1000);
    if (perHour >= this.policy.maxPerHour) {
      return {
        allowed: false,
        reason: `hourly cap reached (${perHour}/${this.policy.maxPerHour}) — no bursts`,
        waitMs: 60 * 60 * 1000 / this.policy.maxPerHour
      };
    }

    if (now < this.state.nextAllowedAt) {
      return {
        allowed: false,
        reason: 'inside the jittered gap since the last operation',
        waitMs: this.state.nextAllowedAt - now
      };
    }

    return { allowed: true, reason: 'within policy', waitMs: 0 };
  }

  /** Record an operation and set an irregular earliest-next time. */
  recordOperation(kind = 'testnet_op') {
    const now = this.now();
    this.state.operations.push(now);
    this.state.totalEver += 1;
    this.state.lastKind = kind;
    this.state.lastAt = new Date(now).toISOString();
    this.state.nextAllowedAt = now + this.policy.minGapMs + jitter(this.policy.jitterMs);
    return this.state;
  }

  /** Serialisable form for the same /kv/ persistence the engines use. */
  toState() {
    this.prune();
    return { ...this.state };
  }

  summary() {
    this.prune();
    return {
      last24h: this.state.operations.length,
      lastHour: this.countWithin(60 * 60 * 1000),
      totalEver: this.state.totalEver,
      caps: { perDay: this.policy.maxPerDay, perHour: this.policy.maxPerHour },
      nextAllowedAt: this.state.nextAllowedAt ? new Date(this.state.nextAllowedAt).toISOString() : null
    };
  }
}
