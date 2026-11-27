/**
 * The daemon's side of the local FLOP rail service (C:\FlopChain\flop-rail.mjs).
 *
 * The daemon stays free of Polkadot dependencies; this client only speaks JSON to
 * 127.0.0.1:8791, where the service pins FLOP Testnet, applies rail-policy.mjs and
 * holds the keys. Every method throws on a refusal or a lost answer, with
 * `err.status` and, for a lock whose outcome is unknown, `err.uncertain`.
 */
export class FlopRailClient {
  constructor({ url = 'http://127.0.0.1:8791', timeoutMs = 240_000, fetchImpl = globalThis.fetch } = {}) {
    this.url = url.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #post(path, body) {
    let res;
    try {
      res = await this.fetch(`${this.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      const e = new Error(`flop rail ${path}: ${err.message}`);
      e.uncertain = path === '/rail/lock'; // the service may have submitted before the answer was lost
      throw e;
    }
    let out = {};
    try { out = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = new Error(`flop rail ${path}: ${out.error || `HTTP ${res.status}`}`);
      e.status = res.status; e.uncertain = Boolean(out.uncertain); e.waiting = Boolean(out.waiting);
      throw e;
    }
    return out;
  }

  /** Escrow `terms` with the payer key; resolves to the flop1. reference. */
  async lock(terms) { return (await this.#post('/rail/lock', { terms })).ref; }
  /** True only for an open escrow matching `terms` exactly, as the payee would check. */
  async verifyLock(terms, ref) { return (await this.#post('/rail/verify', { terms, ref })).ok === true; }
  /** Refund once both the wall clock and the chain allow it; err.waiting while not yet. */
  async refund(ref) { await this.#post('/rail/refund', { ref }); }
}
