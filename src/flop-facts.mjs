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
    status: STATUS.CONFIRMED,
    claim: 'Genesis airdrop is 3,500,000,000 $FLOP — 20.4% of the year-10 supply of ~17.2bn',
    source: 'Flop Network Teaser v0.1 §03, flop.finance/teaser/, updated 2026-08-26. Supersedes the earlier "about 20%, under review" reading from the Bloomingbit interview',
    asOf: '2026-08-26'
  },
  {
    id: 'airdrop-split',
    status: STATUS.CONFIRMED,
    claim: 'Airdrop split: miners up to 1.2bn, AI agents up to 1.2bn, validators 305,505,000, reserve 794,495,000',
    source: 'Teaser v0.1 §03, flop.finance/teaser/',
    asOf: '2026-08-26'
  },
  {
    id: 'agent-scoring',
    status: STATUS.CONFIRMED,
    claim: 'An agent’s allocation is "based largely on what they spend on inference over the testnet, along with various prizes"',
    source: 'Teaser v0.1 §04, flop.finance/teaser/',
    asOf: '2026-08-26'
  },
  {
    id: 'agent-unlock',
    status: STATUS.CONFIRMED,
    claim: 'The agent airdrop arrives locked, spendable only on inference or staking, and every 3 $FLOP spent on inference unlocks 1 — so the inference route frees at most a quarter of an allocation and returns three quarters to miners and validators as compute',
    source: 'Teaser v0.1 §04 for the 3:1 rule; the quarter follows by arithmetic, since the locked balance is itself what is spent — derived in src/tokenomics.mjs and tested',
    asOf: '2026-08-26'
  },
  {
    id: 'issuance-per-block',
    status: STATUS.CONFIRMED,
    claim: '112 $FLOP is issued per block, not 96: Flop Labs and the Foundation each take 8 "in addition to" the 96 block reward, so real issuance is 1.167x the headline',
    source: 'Teaser v0.1 §02, §07 and §08. The additive reading is the only one under which the stated 96 reward, the 8+8, and the ~17.2bn year-10 table reconcile — checked in test/tokenomics.test.mjs, where the alternative reading misses by over 13%',
    asOf: '2026-08-26'
  },
  {
    id: 'network-parameters',
    status: STATUS.CONFIRMED,
    claim: 'Block time ~1s, block reward 96 $FLOP, halving every 730 days for five halvings then constant in perpetuity; miners take 85% of each inference fee, validators 15%',
    source: 'Teaser v0.1 §02, flop.finance/teaser/',
    asOf: '2026-08-26'
  },
  {
    id: 'validator-set',
    status: STATUS.CONFIRMED,
    claim: 'The validator set is capped at 1,000, and roughly every month the worst-performing 50 are replaced by the top 50 in waiting — a seat is not permanent',
    source: 'Teaser v0.1 §02, flop.finance/teaser/',
    asOf: '2026-08-26'
  },
  {
    id: 'validator-stake',
    status: STATUS.CONFIRMED,
    claim: 'A validator’s airdrop IS its required stake: bonded at launch as slashing collateral, locked through the first halving, then released over 1,000 days. At a set of 1,000 that is 305,505 $FLOP each',
    source: 'Teaser v0.1 §04 for the mechanism; the per-seat figure is 305,505,000 divided by the stated cap of 1,000',
    asOf: '2026-08-26'
  },
  {
    id: 'hardware',
    status: STATUS.CONFIRMED,
    claim: 'Recommended hardware, marked provisional: miner needs a GPU with 16 GB+ VRAM per unit; validator needs 8+ core CPU, 64 GB RAM, 2 TB NVMe and a redundant 1 Gbps link. No GPU is listed for validators',
    source: 'Teaser v0.1 §02 "Recommended hardware", explicitly "subject to refinement before testnet"',
    asOf: '2026-08-26'
  },
  {
    id: 'validator-gpu-tension',
    status: STATUS.UNKNOWN,
    claim: 'Whether a validator needs a GPU. The recommended spec lists none, yet the same section has validators "re-execute a randomised sample of sessions" — which is not an 8-core CPU job',
    source: 'Teaser v0.1 §02, reading the verification stack against the hardware table. Nobody has reconciled the two',
    asOf: '2026-08-26'
  },
  {
    id: 'no-sale',
    status: STATUS.CONFIRMED,
    claim: 'No token sale and no investor allocation; the genesis supply is distributed through the testnet airdrop',
    source: 'Teaser v0.1 §03, flop.finance/teaser/',
    asOf: '2026-08-26'
  },
  {
    id: 'draft-status',
    status: STATUS.REPORTED,
    claim: 'Every figure above is provisional — the teaser is stamped "Version 0.1 (draft)" and names the not-yet-final Yellow Paper as the definitive specification',
    source: 'Teaser v0.1 front matter: "The figures in this document are provisional ... may change"',
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
    status: STATUS.CONFIRMED,
    claim: 'Testnet is planned for Q4 2026 and runs roughly ninety days; mainnet follows in Q1 2027. No testnet has launched and no validator or miner software has been published',
    source: 'Teaser v0.1 §04 and front matter, flop.finance/teaser/. Absence of software verified against technocore.chat/openapi.json',
    asOf: '2026-08-26'
  },
  {
    id: 'company-block-rewards',
    status: STATUS.REFUTED,
    claim: 'That Flop Labs takes block rewards only for ~2 years, until the first halving, after which its share disappears',
    source: 'This board said so on 2026-08-26 from an interview summary. Teaser v0.1 §07 and §08 instead give Flop Labs LLC and the Flop Foundation 8 $FLOP per block EACH, halving on the same schedule and sunsetting only after year TEN — cumulatively 5.7% of supply each, 11.4% together. Corrected rather than deleted',
    asOf: '2026-08-26'
  },
  {
    id: 'tokenomics-imminent',
    status: STATUS.CONFIRMED,
    claim: 'The tokenomics document arrived: Flop Labs published "The Flop Network — Teaser v0.1" at flop.finance/teaser/ on 2026-08-26. The Yellow Paper it names as definitive is still not final',
    source: 'flop.finance/teaser/ — first-party, linked from the apex page',
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
    status: STATUS.REFUTED,
    claim: 'That the airdrop lands in October 2026, separately from and before the testnet concludes',
    source: 'This board carried an October date from interview coverage and flagged that it would not reconcile with a ninety-day testnet. Teaser v0.1 §04 resolves it: results are "settled into the genesis block" at the end of the testnet, with the bulk distributed at the token generation event. No October date appears in the first-party document',
    asOf: '2026-08-26'
  },
  {
    id: 'timeline',
    status: STATUS.CONFIRMED,
    claim: 'Testnet Q4 2026 (~90 days), mainnet Q1 2027. Airdrop results settle into the genesis block; the bulk is distributed at the token generation event, any remainder later',
    source: 'Teaser v0.1 front matter and §04, flop.finance/teaser/',
    asOf: '2026-08-26'
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
    status: STATUS.CONFIRMED,
    claim: 'Which activities count is now stated per cohort: miners on compute delivered, agents on inference spend, validators on uptime, block production, accuracy and latency',
    source: 'Teaser v0.1 §04, flop.finance/teaser/. Supersedes the earlier "explicitly not disclosed" reading',
    asOf: '2026-08-26'
  },
  {
    id: 'scoring',
    status: STATUS.UNKNOWN,
    claim: 'The exact scoring formula and the snapshot date. Cohort criteria are now published, but nothing says how spend is weighted, whether allocation is capped per identity, or what the "various prizes" are worth',
    source: 'Teaser v0.1 §04 states the inputs and none of the weights',
    asOf: '2026-08-26'
  },
  {
    id: 'chain',
    status: STATUS.CONFIRMED,
    claim: 'FLOP lives on its own chain: an account-based proof-of-useful-inference blockchain, genesis Q1 2027. A wallet still cannot be created — no client or address format is published',
    source: 'Teaser v0.1 §02. Supersedes the earlier UNKNOWN; the "which chain" question is answered, the "how do I hold it" question is not',
    asOf: '2026-08-26'
  },
  {
    id: 'faucet-endpoint',
    status: STATUS.UNKNOWN,
    claim: 'Where the faucet will be and what a session request looks like on the wire. No inference or faucet route appears in technocore.chat/openapi.json',
    source: 'Checked against the published OpenAPI manifest, 25 paths, none of them a session or faucet route. auth.md asks that nobody probe for unpublished paths',
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

  /**
   * The disclaimer is not the part that gets truncated.
   *
   * The first version of this built the whole line, then sliced it to 4000. That
   * worked while the board was short. When the Teaser landed and CONFIRMED grew
   * to fourteen entries, the slice started cutting mid-source — taking "Not
   * affiliated with Flop Labs" and the repository link with it, so the longest
   * and most authoritative-looking post was the one that shed its disclaimer.
   *
   * The trailer is now reserved before anything is measured and appended after
   * any truncation, so it is present on every post by construction. A test
   * asserts it for all four sections.
   */
  const TRAILER = ' | Not affiliated with Flop Labs. Verify against flop.finance before acting. '
    + '| github.com/Mariukasfak/flop-evidence-scout';
  const OVERFLOW = ' …full board: github.com/Mariukasfak/flop-evidence-scout';
  const CAP = 4000;

  const prefix = `[flop-facts ${status}] as of ${entries[0].asOf} — `;
  const budget = CAP - prefix.length - TRAILER.length;

  // Sources are what make a status board worth reading, so they go first and are
  // only dropped when the section genuinely will not fit. Claims alone still
  // carry the substance; the sources are always on the site.
  const withSources = singleLineSweep(entries.map((f) => `${f.claim} [${f.source}]`).join(' ;; '));
  const claimsOnly = singleLineSweep(entries.map((f) => f.claim).join(' ;; '));

  let body;
  if (withSources.length <= budget) {
    body = withSources;
  } else if (claimsOnly.length <= budget - OVERFLOW.length) {
    body = claimsOnly + OVERFLOW;
  } else {
    body = claimsOnly.slice(0, budget - OVERFLOW.length - 1) + '…' + OVERFLOW;
  }

  return {
    type: 'facts',
    status,
    key: `facts:${status}:${factsDigest(entries)}`,
    line: singleLineSweep(prefix + body) + TRAILER
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
