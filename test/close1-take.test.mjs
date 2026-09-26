import test from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity, signMessageBase64Url, verifyMessage } from '../src/identity.mjs';
import { checkedTerms, judgeOffer, makerPayload, takerPayload, tradeText, MAX_QTY } from '../tools/close1-take.mjs';

const maker = generateIdentity();
const me = generateIdentity();
const ctx = { ours: new Set([me.did]), ref: 225, nextSweep: 250 };

function offer(over = {}, { signer = maker, from = maker.did, sig = null } = {}) {
  const terms = { id: 'abc123', maker: maker.did, px: '225.10', qty: '0.5', side: 'sell', taker: 'any', until: 260, ...over };
  const maker_sig = sig ?? signMessageBase64Url(makerPayload(checkedTerms(terms) ?? terms), signer.privateKeyPem);
  return { seq: 1, from, text: JSON.stringify({ t: 'offer', season: 'close-1', terms, maker_sig }) };
}

test('a well-formed, signed, nearby open offer from a stranger is takeable', () => {
  const j = judgeOffer(offer(), ctx);
  assert.equal(j.ok, true, j.why);
  assert.equal(j.terms.id, 'abc123');
});

test('the signed string is rebuilt with sorted keys whatever order the maker sent', () => {
  const t = checkedTerms({ until: 260, taker: 'any', side: 'sell', qty: '0.5', px: '225.10', maker: maker.did, id: 'x' });
  assert.equal(makerPayload(t).startsWith('close-1|terms|{"id":"x","maker":'), true);
});

test('refused: our own key, a named taker, an extra field, a far price, too large, stale, a bad signature', () => {
  const mine = generateIdentity();
  const own = offer({ maker: mine.did }, { signer: mine, from: mine.did });
  assert.equal(judgeOffer(own, { ...ctx, ours: new Set([mine.did]) }).why, 'ours');
  assert.equal(judgeOffer(offer({ taker: me.did }), ctx).why, 'named taker');
  assert.equal(judgeOffer(offer({ note: 'hi' }), ctx).why, 'shape');
  assert.equal(judgeOffer(offer({ px: '240.00' }), ctx).why, 'too far from the reference');
  assert.equal(judgeOffer(offer({ qty: String(MAX_QTY + 1) }), ctx).why, 'too large');
  assert.equal(judgeOffer(offer({ until: 249 }), ctx).why, 'expires before the next sweep');
  const other = generateIdentity();
  assert.match(judgeOffer(offer({}, { signer: other }), ctx).why, /signature/);
  assert.match(judgeOffer(offer({}, { from: other.did }), ctx).why, /someone other/);
});

test('our countersignature verifies over exactly the string the rules name, and the trade carries both', () => {
  const j = judgeOffer(offer(), ctx);
  const sig = signMessageBase64Url(takerPayload(j.terms, me.did), me.privateKeyPem);
  assert.equal(verifyMessage(`close-1|accept|${JSON.stringify(j.terms)}|${me.did}`, sig, me.did), true);
  const trade = JSON.parse(tradeText(j.terms, j.makerSig, me.did, sig));
  assert.deepEqual(Object.keys(trade), ['t', 'season', 'terms', 'taker', 'maker_sig', 'taker_sig']);
  assert.equal(trade.taker, me.did);
});
