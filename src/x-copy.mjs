/**
 * What each refutation says on X, written by hand.
 *
 * The first version assembled these from the status board's own fields, and
 * reading the six it produced settled the question: it does not work.
 *
 *   - All six opened with the same 54-character header. Six posts with an
 *     identical first line is a bot signature, and a reader stops at the second.
 *   - The board writes claims to complete "REFUTED: that X", so lifted out they
 *     are fragments. "That the 20% is an emission spread over ten years" is not
 *     a sentence.
 *   - Two hit exactly 280 and truncated mid-word — "at…", "official-testnet-…".
 *     A bot visibly running out of room is the worst available look.
 *   - One published "~130k DID profiles" from a field written on 2026-08-26.
 *     The measured figure that day was 839,481. Six and a half times wrong, and
 *     it would have gone out under the operator's own name.
 *   - Two refuted a claim without saying what is true instead, which leaves a
 *     reader worse off than before: distrusting something, and still not knowing
 *     what to trust.
 *
 * So the copy is written, not generated. Six texts is not many, and public
 * writing under a person's name should not be machine-assembled out of fields
 * authored for a different purpose.
 *
 * The consequence is deliberate: a refutation with no entry here CANNOT be
 * posted. A new one goes to the status board immediately and to X only once
 * somebody has written the sentence. That is the correct order.
 *
 * Rules each of these follows:
 *   - Opens differently from its neighbours. No shared template line.
 *   - Says what is true, not only what is false.
 *   - Carries a number only where that number is stable, or names the date.
 *   - Comfortably under 280 with the link, so nothing is ever cut mid-word.
 */

const REPO = 'github.com/Mariukasfak/flop-evidence-scout';

/** Written per fact id. Anything absent here is not eligible for X. */
export const X_COPY = Object.freeze({
  'fake-faucet-room': {
    text: 'technocore.chat has a /r/faucet room. It is not a faucet.\n\n'
      + 'A stranger made it. Inside, dozens of bots request testnet tokens from each other. '
      + 'Nothing reads it.\n\n'
      + 'auth.md: no claim or token endpoint at any path.'
  },

  'faucet-namespace': {
    text: 'Agents are queueing in /kv/faucet, waiting for testnet tokens.\n\n'
      + 'I read all 58 entries. Nothing reads that namespace — it is world-writable scratch space.\n\n'
      + '74% wrote "did:did:key:", so their own entry names no parseable key.'
  },

  'guaranteed-allocation': {
    text: 'Registering a DID does not earn a FLOP allocation.\n\n'
      + 'No criteria are published, and the field is not small. I measure it daily: '
      + '279,773 → 533,468 → 839,481 in three days.\n\n'
      + 'Anyone selling certainty is selling something else.'
  },

  'company-block-rewards': {
    text: 'Doing the rounds: Flop Labs takes block rewards only until the first halving.\n\n'
      + 'Teaser v0.1 says otherwise. Labs and the Foundation take 8 each per block, "in addition to" '
      + 'the 96 — so 112 leaves the protocol, indefinitely.'
  },

  'date-tension': {
    text: 'The FLOP airdrop is not a separate October event.\n\n'
      + 'Teaser v0.1: results settle into the genesis block at the end of the ~90-day testnet, the bulk '
      + 'distributed at the token generation event.\n\n'
      + 'Testnet Q4 2026, mainnet Q1 2027.'
  },

  'ten-year-correction': {
    text: 'A correction to something I published.\n\n'
      + 'On 2026-08-26 I wrote that the 20% airdrop was an emission spread over ten years. It is not — '
      + 'I weighted a news summary over a direct interview.\n\n'
      + 'Recorded as refuted, not deleted.'
  }
});

/** The trailer. Separate, so every text above can be read as the sentence it is. */
export const X_TRAILER = `\n\nSources: ${REPO}`;

export function xCopyFor(factId) {
  const entry = X_COPY[factId];
  if (!entry) return null;
  return entry.text + X_TRAILER;
}

/**
 * The order they should go out in, which is not the order the board holds them.
 *
 * The board is chronological. Taking its first unpublished entry made the very
 * first post on the account "A correction to something I published" — a
 * correction to a post nobody there had seen, from an account that had said
 * nothing yet. True, and unreadable as an opener.
 *
 * So the two that are immediately useful to a stranger lead: the room that looks
 * like a faucet and is not, and the queue that looks like a queue and is not.
 * Someone who reads only one post should get the one that saves them something.
 * The self-correction is worth publishing — it is the strongest credibility
 * signal here — but it lands after the account has said something to correct
 * against.
 */
export const X_ORDER = Object.freeze([
  'fake-faucet-room',
  'faucet-namespace',
  'guaranteed-allocation',
  'company-block-rewards',
  'date-tension',
  'ten-year-correction'
]);

/** Facts in publication order, with anything unwritten left out. */
export function orderForX(facts = []) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  return X_ORDER.map((id) => byId.get(id)).filter(Boolean);
}
