import crypto from 'node:crypto';

export class Guardrails {
  constructor({
    maxPerHour = 4,
    minCooldownMs = 60_000,
    maxMessageLength = 3000
  } = {}) {
    this.maxPerHour = maxPerHour;
    this.minCooldownMs = minCooldownMs;
    this.maxMessageLength = maxMessageLength;
    this.sentTimestamps = [];
    this.recentHashes = new Set();
  }

  hashContent(text) {
    return crypto.createHash('sha256').update(text.trim()).digest('hex');
  }

  canSendMessage(content) {
    const validation = this.validateContent(content);
    if (!validation.valid) {
      return { allowed: false, reason: validation.reason };
    }

    const contentHash = this.hashContent(content);
    if (this.recentHashes.has(contentHash)) {
      return { allowed: false, reason: 'Deduplikacija: identiškas pranešimas jau buvo išsiųstas' };
    }

    const now = Date.now();
    
    // Prune timestamps older than 1 hour
    this.sentTimestamps = this.sentTimestamps.filter((ts) => now - ts < 3600_000);
    
    if (this.sentTimestamps.length >= this.maxPerHour) {
      return { allowed: false, reason: `Pasiektas valandinis limitas (${this.maxPerHour}/val.)` };
    }

    const lastSent = this.sentTimestamps[this.sentTimestamps.length - 1] ?? 0;
    if (now - lastSent < this.minCooldownMs) {
      const waitSec = Math.ceil((this.minCooldownMs - (now - lastSent)) / 1000);
      return { allowed: false, reason: `Aktyvus aušinimo laikas (palaukite ${waitSec}s)` };
    }

    return { allowed: true };
  }

  recordSent(content) {
    const now = Date.now();
    this.sentTimestamps.push(now);
    const contentHash = this.hashContent(content);
    this.recentHashes.add(contentHash);
    
    // Keep max 100 hashes
    if (this.recentHashes.size > 100) {
      const [first] = this.recentHashes;
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
