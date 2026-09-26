/**
 * The only close-1 code that touches the signing key.
 *
 * It signs canonical bytes it builds itself from checked fields — terms,
 * accepts, and the three message shapes the rules define — and posts only
 * with an approval from the risk gate for exactly that text. It never signs
 * or posts a string a peer wrote: a stored trade is re-parsed, re-checked and
 * re-serialised with tradeText before it is re-posted.
 *
 * For each post it returns the exact bytes signed, so the trade record keeps
 * them next to the technocore envelope the evidence archive already keeps.
 */
import fs from 'node:fs';
import { signMessageBase64Url } from '../identity.mjs';
import {
  checkedTerms, checkedTrade, makerPayload, takerPayload, offerText, tradeText, safeVerify
} from './protocol.mjs';

export class Executor {
  constructor({ identityPath, client, room = 'close1', loadIdentity = null }) {
    this.identityPath = identityPath;
    this.client = client;
    this.room = room;
    this.loadIdentity = loadIdentity;
    this.identity = null;
  }

  #key() {
    if (!this.identity) {
      this.identity = this.loadIdentity ? this.loadIdentity() : JSON.parse(fs.readFileSync(this.identityPath, 'utf8'));
    }
    return this.identity;
  }

  get did() { return this.#key().did; }

  /** Sign our own offer's terms. The terms must already be canonical and name us as maker. */
  signOffer(terms) {
    const t = checkedTerms(terms);
    if (!t || JSON.stringify(t) !== JSON.stringify(terms) || t.maker !== this.did) throw new Error('refusing to sign: terms not canonical or not ours');
    const payload = makerPayload(t);
    const makerSig = signMessageBase64Url(payload, this.#key().privateKeyPem);
    if (!safeVerify(payload, makerSig, this.did)) throw new Error('our own maker signature does not verify');
    return { text: offerText(t, makerSig), makerSig, signed: payload };
  }

  /** Countersign a stranger's offer whose maker signature verifies over the rebuilt terms. */
  signAccept(terms, makerSig) {
    const t = checkedTerms(terms);
    if (!t || !safeVerify(makerPayload(t), makerSig, t.maker)) throw new Error('refusing to countersign: maker signature does not verify over the rebuilt terms');
    const payload = takerPayload(t, this.did);
    const takerSig = signMessageBase64Url(payload, this.#key().privateKeyPem);
    return { text: tradeText(t, makerSig, this.did, takerSig), takerSig, signed: payload };
  }

  /**
   * A probe copy of a trade: rebuilt from checked fields. With no taker text
   * (our offer, nobody valid took it) we countersign our own terms — after
   * `until` it can only void, and "a trade with the same key on both sides
   * changes no position" even if it could not.
   */
  probeText(record) {
    if (record.tradeObj) {
      const c = checkedTrade(record.tradeObj);
      if (!c.ok) throw new Error(`refusing to re-post: ${c.why}`);
      return { text: tradeText(c.terms, c.makerSig, c.taker, c.takerSig), terms: c.terms, makerSig: c.makerSig, taker: c.taker, takerSig: c.takerSig };
    }
    const terms = checkedTerms(record.terms);
    if (!terms || terms.maker !== this.did) throw new Error('refusing to self-probe terms that are not ours');
    const { makerSig } = this.signOffer(terms);
    const takerSig = signMessageBase64Url(takerPayload(terms, this.did), this.#key().privateKeyPem);
    return { text: tradeText(terms, makerSig, this.did, takerSig), terms, makerSig, taker: this.did, takerSig };
  }

  /** Post a text the gate approved. `approval.text` must be byte-identical. */
  async post(text, approval) {
    if (!approval?.ok || approval.text !== text) throw new Error('refusing to post: no matching risk-gate approval');
    const res = await this.client.postSignedMessage(this.room, text, this.#key());
    const line = String(res.raw ?? '').split('\n').find((l) => l.includes(JSON.parse(text).terms?.id ?? '\u0000'));
    return { seq: Number(line?.match(/^\[(\d+)\]/)?.[1]) || null, raw: res.raw };
  }
}
