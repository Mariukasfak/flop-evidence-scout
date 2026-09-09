import crypto from 'node:crypto';

export class Guardrails {
  /**
   * `repeatWindowMs` is how long an answer stays spent. `Infinity` — the
   * default, and what every lane had — means once sent, never again.
   *
   * That is a mute switch, not a pacer, anywhere the thing being sent comes
   * from a finite bank. The scout answers out of 21 verified facts, two at a
   * time, so its reachable set of distinct replies is a few dozen strings; once
   * each had gone out once, the check refused everything. Measured over the
   * audit log for the nine hours to 2026-09-09T06:55Z: **464 refusals against
   * 22 answers, and 336 distinct agents turned away** — every one of them
   * asking something we hold a grounded answer for, refused because a
   * different agent had been given that paragraph earlier. One answer
   * (`did_identity`) was refused 126 times.
   *
   * A finite window restores the intent stated in ScoutEngine's constructor:
   * the duplicate check is meant to pace distinct answers, with the hourly
   * ceiling above it as a runaway stop. It is not the thing that stops us
   * repeating ourselves to one agent — `SAME_AUTHOR_COOLDOWN_MS` (6 h) and the
   * answered-skeleton set already do that, which is why the window can be
   * finite without any agent hearing the same paragraph twice.
   */
  constructor({
    maxPerHour = 4,
    minCooldownMs = 60_000,
    maxMessageLength = 3000,
    repeatWindowMs = Infinity
  } = {}) {
    this.maxPerHour = maxPerHour;
    this.minCooldownMs = minCooldownMs;
    this.maxMessageLength = maxMessageLength;
    this.repeatWindowMs = repeatWindowMs;
    this.sentTimestamps = [];
    /** hash -> ms timestamp it was last sent at. */
    this.recentHashes = new Map();
  }

  hashContent(text) {
    return crypto.createHash('sha256').update(text.trim()).digest('hex');
  }

  /**
   * `dedupeKey` is the part of the message that carries the meaning.
   *
   * Deduplicating on the whole string looked like it worked and caught nothing:
   * every scout reply opens with `[FLOP Scout -> <did>]`, so the same paragraph
   * sent to two different agents hashes differently. Measured over the audit
   * log, 2,062 replies the hourly budget threw away held 271 distinct strings —
   * but only 97 distinct answers once the address line and a rotating greeting
   * were stripped. The caller passes what it actually wants counted as a repeat.
   */
  canSendMessage(content, { isPriorityInquiry = false, dedupeKey = null } = {}) {
    const validation = this.validateContent(content);
    if (!validation.valid) {
      return { allowed: false, reason: validation.reason };
    }

    const now = Date.now();

    const contentHash = this.hashContent(dedupeKey ?? content);
    const lastSentAt = this.recentHashes.get(contentHash);
    if (lastSentAt !== undefined && now - lastSentAt < this.repeatWindowMs) {
      return { allowed: false, reason: 'Deduplikacija: identiškas pranešimas jau buvo išsiųstas' };
    }


    // Prune timestamps older than 1 hour
    this.sentTimestamps = this.sentTimestamps.filter((ts) => now - ts < 3600_000);
    
    if (this.sentTimestamps.length >= this.maxPerHour) {
      return { allowed: false, reason: `Pasiektas valandinis limitas (${this.maxPerHour}/val.)` };
    }

    const effectiveCooldown = isPriorityInquiry ? Math.min(15_000, this.minCooldownMs) : this.minCooldownMs;
    const lastSent = this.sentTimestamps[this.sentTimestamps.length - 1] ?? 0;
    if (now - lastSent < effectiveCooldown) {
      const waitSec = Math.ceil((effectiveCooldown - (now - lastSent)) / 1000);
      return { allowed: false, reason: `Aktyvus aušinimo laikas (palaukite ${waitSec}s)` };
    }

    return { allowed: true };
  }

  recordSent(content, { dedupeKey = null } = {}) {
    const now = Date.now();
    this.sentTimestamps.push(now);
    const contentHash = this.hashContent(dedupeKey ?? content);
    // Delete before set: a Map keeps a re-set key in its original position, and
    // the eviction below drops whatever is first. Without this, re-sending an
    // old answer would leave it looking like the least recently used one.
    this.recentHashes.delete(contentHash);
    this.recentHashes.set(contentHash, now);

    if (Number.isFinite(this.repeatWindowMs)) {
      for (const [hash, at] of this.recentHashes) {
        // Insertion order is oldest-first, so the first entry still inside the
        // window means every entry after it is too.
        if (now - at < this.repeatWindowMs) break;
        this.recentHashes.delete(hash);
      }
    }

    // Keep max 100 hashes
    if (this.recentHashes.size > 100) {
      const [first] = this.recentHashes.keys();
      this.recentHashes.delete(first);
    }
  }

  validateContent(content) {
    if (typeof content !== 'string' || !content.trim()) {
      return { valid: false, reason: 'Pranešimas negali būti tuščias' };
    }

    if (content.length > this.maxMessageLength) {
      return { valid: false, reason: `Pranešimas viršija maksimalų ilgį (${this.maxMessageLength} simbolių)` };
    }

    // Safety checks: leak of keys or seed phrases
    if (/BEGIN (?:PRIVATE|EC) KEY|nsec1|private_key/i.test(content)) {
      return { valid: false, reason: 'Kritinė klaida: bandoma išsiųsti privatų raktą' };
    }

    // Phishing / fake claim warnings
    if (/claim-flop\.|free-airdrop\.|connect-wallet-now/i.test(content)) {
      return { valid: false, reason: 'Saugumo klaida: draudžiama skelbti nepatvirtintas claim/piniginių nuorodas' };
    }

    return { valid: true };
  }
}
