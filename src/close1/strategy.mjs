/**
 * close-1 strategy: a pure decision over a validated snapshot. No network, no
 * keys, no clock. Returns NO_ACTION with a reason, or one proposal with its
 * rationale; the risk gate decides whether it may be written.
 *
 * The aim is evidence, not PnL: the clawback removes every price edge, so a
 * trade is worth its proof that software found a counterparty and settled.
 * Our own offer is the default — a maker races nobody and its id is ours, so
 * its outcome is attributable (see ledger.mjs). Taking a stranger's open offer
 * is a sub-second race whose settlement can never be attributed to our copy,
 * so it is off unless the policy turns it on.
 */
import { checkedTerms } from './protocol.mjs';

export const ACTION = Object.freeze({ NO_ACTION: 'NO_ACTION', MAKE_OFFER: 'MAKE_OFFER', TAKE_OFFER: 'TAKE_OFFER' });

const none = (why) => ({ action: ACTION.NO_ACTION, why });

/**
 * @param s  { ourDid, ref, nextSweep, netPosition, candidate? (a judged offer), idHint }
 * @param policy  from risk-gate DEFAULT_POLICY
 */
export function decide(s, policy) {
  if (!(s.ref > 0)) return none('no reference price');
  if (policy.mode === 'take') {
    if (!policy.allowOpenTake) return none('taking open offers is off by policy');
    if (!s.candidate) return none('no fresh takeable offer');
    return {
      action: ACTION.TAKE_OFFER,
      terms: s.candidate.terms,
      makerSig: s.candidate.makerSig,
      ourSide: s.candidate.terms.side === 'buy' ? 'sell' : 'buy',
      rationale: `take ${s.candidate.terms.id}: a signed open offer within ${policy.maxDrift * 100}% of the reference`
    };
  }
  // Lean back toward flat; from flat, buy.
  const side = s.netPosition > 0 ? 'sell' : 'buy';
  // A shade better than the reference for whoever takes it: 0.2 % of half a
  // contract is under half a POLF, and the clawback returns it at the close.
  const px = (s.ref * (side === 'buy' ? 1 + policy.offerEdge : 1 - policy.offerEdge)).toFixed(2);
  const terms = checkedTerms({
    id: s.idHint, maker: s.ourDid, px, qty: policy.offerQty.toFixed(2), side, taker: 'any', until: s.nextSweep + policy.offerSweeps
  });
  if (!terms) return none('our own terms failed the shape check');
  return {
    action: ACTION.MAKE_OFFER,
    terms,
    ourSide: side,
    rationale: `offer to ${side} ${terms.qty} @ ${terms.px} (ref ${s.ref}), open through sweep ${terms.until}; leaning toward flat from ${s.netPosition}`
  };
}
