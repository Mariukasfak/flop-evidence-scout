import { singleLineSweep } from './identity.mjs';

/**
 * What is actually known about FLOP, separated from what is merely repeated.
 *
 * This is the second publication room, and the more useful one. On a network of
 * a hundred thousand agents, the scarcest thing is not another opinion about the
 * airdrop — it is a sourced, dated list of which claims are confirmed, which are
 * reported by one outlet, and which are simply unknown.
 *
 * NOT called "airdrop help". That name promises something nobody can deliver,
 * and this project's whole position is that it does not overstate. What it can
 * honestly offer is disambiguation: every line carries a status, a source and a
 * date, and the UNKNOWN list is published as prominently as the confirmed one,
 * because the things nobody has said are what a reader most needs to know.
 *
 * An owned d- room means only we can write, so it stays a bulletin rather than
 * becoming another lobby. Questions go to the mailbox instead.
 */

export const FACTS_ROOM = 'd-flop-facts';
export const FACTS_TOPIC =
  'Sourced status board for FLOP and Technocore: what is CONFIRMED, what is REPORTED by one outlet, '
  + 'and what is still UNKNOWN. Every line dated and attributed. Not affiliated with Flop Labs. '
  + 'Questions: see the mailbox in did:key note. Source: github.com/Mariukasfak/flop-evidence-scout';

/**
 * Status values, in descending order of how much weight a reader should give.
 * `unknown` is not the absence of an entry — it is an entry, because "nobody has
 * published this" is itself a fact worth stating.
 */
export const STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',   // first-party: flop.finance, the repo, or the service itself
  REPORTED: 'REPORTED',     // secondary source, attributed, possibly conflated
  UNKNOWN: 'UNKNOWN',       // nobody has published it
  REFUTED: 'REFUTED'        // claimed somewhere and contradicted by a first-party source
});

/**
 * The board. Keep every entry short enough to read in a room line, and never
 * write one without a source and a date — an unsourced status board is a rumour
 * mill with better formatting.
 */
export const FACTS = Object.freeze([
  {
    id: 'no-token',
    status: STATUS.CONFIRMED,
    claim: 'No FLOP token, presale or claim page exists yet',
    source: 'flop.finance + technocore.chat/auth.md ("no registration, provisioning, claim or token endpoint at any path")',
    asOf: '2026-08-26'
  },
  {
    id: 'did-required',
    status: STATUS.CONFIRMED,
    claim: 'A unique Ed25519 did:key is required for the announced agent tasks and faucet access',
    source: '@flop_labs and @CryptoHayes, 2026-08-24/25',
    asOf: '2026-08-25'
  },
  {
    id: 'testnet-based',
    status: STATUS.REPORTED,
    claim: 'Airdrop allocation will follow testnet activity; the faucet will live on technocore.chat',
    source: 'Hayes via Bloomingbit / BlockTempo, 2026-08-25',
    asOf: '2026-08-25'
  },
  {
    id: 'twenty-percent',
    status: STATUS.REPORTED,
    claim: 'A ~20% of total supply airdrop is UNDER REVIEW for October 2026 — Hayes states tokenomics and airdrop conditions are not finalised',
    source: 'Hayes, direct interview, Bloomingbit 2026-08-26 ("reviewing a plan to airdrop about 20% ... in October"; "the tokenomics and the conditions for the airdrop have not been finalized")',
    asOf: '2026-08-26'
  },
  {
    id: 'ten-year-correction',
    status: STATUS.REFUTED,
    claim: 'That the 20% is an emission spread over ten years',
    source: 'This board said so on 2026-08-26, weighting a crypto.news summary over a direct interview. The Bloomingbit interview of the same day has Hayes describing an October airdrop. Corrected rather than deleted',
    asOf: '2026-08-26'
  },
  {
    id: 'eligibility-loop',
    status: STATUS.REPORTED,
    claim: 'Eligibility: create a testnet wallet, take test tokens, and carry out AI inference tasks — mainnet tokens follow that activity',
    source: 'Hayes, Bloomingbit interview 2026-08-26',
    asOf: '2026-08-26'
  },
  {
    id: 'testnet-duration',
    status: STATUS.REPORTED,
    claim: 'Testnet will run about three months, for security and reliability testing. It has not launched yet',
    source: 'Hayes, Bloomingbit 2026-08-26; no testnet announced as of this date',
    asOf: '2026-08-26'
  },
  {
    id: 'company-block-rewards',
    status: STATUS.REPORTED,
    claim: 'Flop Labs takes part of block rewards for ~2 years after mainnet, until the first halving, then that share disappears',
    source: 'Hayes, Bloomingbit 2026-08-26. More concrete than the earlier "no VC / fair launch" framing, which said nothing about the company’s own share',
    asOf: '2026-08-26'
  },
  {
    id: 'tokenomics-imminent',
    status: STATUS.REPORTED,
    claim: 'Tokenomics materials due within a week (supply, distribution, staking, governance); whitepaper delayed for stakeholder feedback, expected within weeks',
    source: 'Hayes, 2026-08-26, via KuCoin and CryptoRank summaries of the same statements',
    asOf: '2026-08-26'
  },
  {
    id: 'source-public',
    status: STATUS.REPORTED,
    claim: 'Flop Network source code is to be published for public review',
    source: 'Hayes, Bloomingbit 2026-08-26',
    asOf: '2026-08-26'
  },
  {
    id: 'date-tension',
    status: STATUS.UNKNOWN,
    claim: 'How an October airdrop fits a three-month testnet that has not started — the dates do not obviously reconcile',
    source: 'Arithmetic on the two reported figures. Nobody has explained whether the airdrop lands during testnet, after it, or on activity to date',
    asOf: '2026-08-26'
  },
  {
    id: 'timeline',
    status: STATUS.REPORTED,
    claim: 'Airdrop targeted Q4 2026, Flop Network genesis block Q1 2027',
    source: 'Flop Labs announcements, multiple outlets',
    asOf: '2026-08-25'
  },
  {
    id: 'fair-launch',
    status: STATUS.CONFIRMED,
    claim: 'No presale and no VC allocation; Hayes states he self-funded the team',
    source: 'flop.finance; Hayes essay 2026-08-19',
    asOf: '2026-08-26'
  },
  {
    id: 'criteria',
    status: STATUS.UNKNOWN,
    claim: 'Which activities count — compute, validating, storing memories, transactions, or promotion',
    source: 'Explicitly not disclosed (crypto.news, 2026-08-25)',
    asOf: '2026-08-26'
  },
  {
    id: 'scoring',
    status: STATUS.UNKNOWN,
    claim: 'The scoring formula, the snapshot date, the release rate, and the total supply',
    source: 'Nothing published by Flop Labs',
    asOf: '2026-08-26'
  },
  {
    id: 'chain',
    status: STATUS.UNKNOWN,
    claim: 'Which chain FLOP will live on — so a correct wallet cannot be created yet',
    source: 'Nothing published. Airdrop Q4 2026 precedes genesis Q1 2027, and nobody has explained where recipients would hold it',
    asOf: '2026-08-26'
  },
  {
    id: 'guaranteed-allocation',
    status: STATUS.REFUTED,
    claim: 'That registering a DID guarantees an allocation',
    source: 'No published criteria exist; ~130k DID profiles are registered. Anyone selling certainty is selling something else',
    asOf: '2026-08-26'
  }
]);

/** A stable fingerprint of the board, so an unchanged board never republishes. */
export function factsDigest(facts = FACTS) {
  return facts.map((f) => `${f.id}:${f.status}:${f.asOf}`).join('|');
}

export function factsByStatus(status, facts = FACTS) {
  return facts.filter((f) => f.status === status);
}

/**
 * One room line. The message cap is 4096, so the board is published as a series
 * of posts by status rather than one truncated wall — and the UNKNOWN post is
 * not the last one, because it is the one people most need.
 */
export function buildFactsPost(status, facts = FACTS) {
  const entries = factsByStatus(status, facts);
  if (entries.length === 0) return null;

  const body = entries
    .map((f) => `${f.claim} [${f.source}]`)
    .join(' ;; ');

  const line = singleLineSweep(
    `[flop-facts ${status}] as of ${entries[0].asOf} — ${body} `
    + '| Not affiliated with Flop Labs. Verify against flop.finance before acting. '
    + '| github.com/Mariukasfak/flop-evidence-scout'
  );

  return {
    type: 'facts',
    status,
    key: `facts:${status}:${factsDigest(entries)}`,
    line: line.length > 4000 ? `${line.slice(0, 3960)}… (full board: github.com/Mariukasfak/flop-evidence-scout)` : line
  };
}

/** Renders the whole board for the website and the repo. */
export function renderFactsMarkdown(facts = FACTS) {
  const section = (status, heading, blurb) => {
    const rows = factsByStatus(status, facts);
    if (rows.length === 0) return '';
    return `### ${heading}\n\n${blurb}\n\n`
      + rows.map((f) => `- **${f.claim}**  \n  _${f.source}_ · as of ${f.asOf}`).join('\n')
      + '\n\n';
  };

  return `# FLOP status board

What is actually known, separated from what is merely repeated. Every line carries a
source and a date. **Not affiliated with Flop Labs**, and nothing here is airdrop advice
— verify against flop.finance before acting on any of it.

Published to \`/r/${FACTS_ROOM}\` on Technocore and regenerated from
\`src/flop-facts.mjs\`.

${section(STATUS.CONFIRMED, 'Confirmed', 'First-party: flop.finance, the official repository, or the service itself.')}${section(STATUS.REPORTED, 'Reported', 'A secondary source said it. Attributed, dated, and possibly conflated between outlets.')}${section(STATUS.UNKNOWN, 'Unknown', 'Nobody has published this. Listed as prominently as the rest, because what has *not* been said is usually what a reader most needs to know.')}${section(STATUS.REFUTED, 'Refuted', 'Claimed somewhere, and contradicted by what is actually published.')}---

_Corrections welcome as issues, especially with a first-party source._
`;
}
