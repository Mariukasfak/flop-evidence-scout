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
    id: 'referral-leaderboard-reported',
    status: STATUS.REPORTED,
    claim: 'Hayes reportedly described a KOL leaderboard, individual referral links and a periodic FLOP lottery for wallets created through those links, open to everyone. This describes a proposed program; launch and allocation remain unverified. The original X post and Flop Labs repost were not directly retrievable in this check',
    source: 'Operator-supplied report dated 2026-09-10 citing x.com/CryptoHayes and x.com/flop_labs, corroborated by indexed copies of the post. Direct-post verification remains pending',
    asOf: '2026-09-10'
  },
  {
    id: 'referral-program-rules',
    status: STATUS.UNKNOWN,
    claim: 'The referral program launch, reward allocation, leaderboard formula, lottery frequency and effect on genesis scoring are unverified. Yellow Paper Appendix A already names KOL, referral and growth incentives within the ecosystem reserve; that does not establish a budget for this particular lottery',
    source: 'https://flop.finance/intro/yellowpaper/ Appendix A; reported Hayes post says details are still to come, checked 2026-09-10',
    asOf: '2026-09-10'
  },
  {
    id: 'genlayer-commerce-direction',
    status: STATUS.REPORTED,
    claim: 'The Unchained interview description says Hayes wants FLOP connected to GenLayer once both go live, for disputes between agents. A stated intention does not confirm a partnership or delivered integration. This commercial dispute layer is distinct from the planned miner-inference challenge game',
    source: 'https://unchainedcrypto.com/how-genlayer-is-building-a-court-system-for-disputes-between-ai-agents/ (2026-09-07); https://flop.finance/intro/verification/, checked 2026-09-10',
    asOf: '2026-09-10'
  },
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
    id: 'delegation-supersede',
    status: STATUS.CONFIRMED,
    claim: 'Delegation checking is broken in a way that hides valid delegations, and the fix is not merged. newest() ranked every delegation record in a DID note by nonce before any signature was verified, and the note is world-writable, so a record with a higher nonce and a bad signature pushed a real delegation to SUPERSEDED and check_note then reported zero live delegations. The browser-side loadDelegations had the same fault. It suppresses a delegation rather than forging one — the bad record is still reported FORGED',
    source: 'flop-labs/technocore-chat issue #782 and PR #783, "fix(delegation): verify signatures before ranking so a forged record cannot supersede a real one", both opened 2026-09-07 by beardthelion. The PR carries a regression test that fails before the fix and states 771 tests pass after. Read 2026-09-08 with the PR still OPEN against main',
    asOf: '2026-09-08'
  },
  {
    id: 'delegation-exploited',
    status: STATUS.UNKNOWN,
    claim: 'Whether anyone has used the delegation flaw. Nobody has published evidence of a suppressed delegation in the wild, and nothing about it implies stolen keys or funds — but nobody has published a search for it either, so silence here is absence of evidence and not the other thing',
    source: 'Read 2026-09-08 across flop-labs/technocore-chat issues and the service itself. This project holds no delegations of its own and was not affected',
    asOf: '2026-09-08'
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
    status: STATUS.REFUTED,
    claim: 'That the genesis airdrop is 3,500,000,000 $FLOP — 20.4% of the year-10 supply of ~17.2bn',
    source: 'This board carried the Teaser v0.1 §03 figure from 2026-08-26. Yellow Paper v0.5.0, updated 2026-09-05 and stamped the implementation spec, sets genesis_supply = 2,483,460,000 FLOP. Superseded rather than wrong at the time. Corrected rather than deleted. Do not quote either number without reading genesis-pool-conflict: 3,500,000,000 is still live as the tokenomics workbook figure and is what the first-party revenue calculator runs on',
    asOf: '2026-09-07'
  },
  {
    id: 'airdrop-split',
    status: STATUS.REFUTED,
    claim: 'That the airdrop splits as miners up to 1.2bn, AI agents up to 1.2bn, validators 305,505,000, reserve 794,495,000',
    source: 'Teaser v0.1 §03, carried here since 2026-08-26. Yellow Paper v0.5.0 replaces three of the four: miners 993,384,000, agents 596,030,400, reserve 588,540,600. Only the validator figure survives unchanged. Corrected rather than deleted',
    asOf: '2026-09-07'
  },
  {
    id: 'genesis-supply',
    status: STATUS.CONFIRMED,
    claim: 'Genesis supply is 2,483,460,000 $FLOP, distributed through airdrop accounts only — no VC pre-mint and no auction. It is not the whole story: cumulative emission through the end of era 5 (~year 12) is a further 11,920,608,000 $FLOP',
    source: 'Yellow Paper v0.5.0 §9 and the machine-checked parameter table (genesis_supply), flop.finance/intro/yellowpaper/, updated 2026-09-05, read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'genesis-split',
    status: STATUS.CONFIRMED,
    claim: 'Genesis split: miners 993,384,000 (40%), agents 596,030,400 (24%), validators 305,505,000 (12.3%), ecosystem reserve 588,540,600 (23.7%). The reserve is named for KOL, referral and growth incentives',
    source: 'Yellow Paper v0.5.0 parameter table: genesis_miner_airdrop, genesis_validator_airdrop, genesis_agent_airdrop, genesis_reserve. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'agent-share-contested',
    status: STATUS.CONFIRMED,
    claim: 'The agent 24% is the least settled number in the genesis table. The Yellow Paper adopts it "sheet-canonical, adopted per ECON-007 §3.5 over the 50/24-25/30 conflict" — its own sources disagreed and the spreadsheet won. This is the cohort this project sits in',
    source: 'Yellow Paper v0.5.0, note on the genesis_agent_airdrop parameter. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'genesis-pool-conflict',
    status: STATUS.UNKNOWN,
    claim: 'Which genesis pool figure governs. The ratified parameter is genesis_supply = 2,483,460,000 (D-0435), but the tokenomics workbook restated the pool to 3,500,000,000 on 2026-08-22 and the first-party revenue calculator runs on the workbook, not the paper. Flop Labs states the gap itself and leaves it open: landing the restatement in params is blocked with no ratifying decision. The agent leg splits the same way — 596,030,400 in the paper against "the whole 1.2bn agent pool" in the calculator',
    source: 'flop.finance/intro/revenue/, "Supply basis": "params/flop-protocol-params.yaml still carries the ratified genesis_supply = 2,483,460,000 (D-0435); the workbook restated the pool to 3,500,000,000 on 2026-08-22 ... Until it lands, the params page and the Yellow Paper appendix still show 2.48B while this calculator shows the workbook" (ECON-009 §2.3 W1, issue #1418). Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'fee-split-settlement',
    status: STATUS.CONFIRMED,
    claim: 'The 85/15 miner/validator inference-fee split is a ratified target, not what settlement pays today: the chain currently routes the miner 99% with a 1% audit allocation, because the validator fee leg is not implemented',
    source: 'flop.finance/intro/revenue/: "the chain currently routes the miner 99%, with a 1% audit allocation, because the validator fee leg is not implemented yet (issue #1352)". Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'challenge-game',
    status: STATUS.CONFIRMED,
    claim: 'The verification economics are published: a ~7 day challenge window bounded by how long the data-availability layer keeps the evidence, a 100% stake burn plus ejection and blacklist on an upheld fraud verdict, 2.5% SOFT-tier spot-check exposure, a separate sampled-audit lottery drawing 5% of turns by default, and 2 hours to produce the disputed turn evidence — silence defaults to a fraud verdict. The miner funds the evidence storage, serve-or-slash',
    source: 'flop.finance/intro/verification/, "Cheating must not pay: the challenge game", draft design, updated 2026-08-27. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'dilution-curve',
    status: STATUS.CONFIRMED,
    claim: 'Circulating supply grows from 458,899,000 $FLOP at TGE to 9,580,761,000 at the day-730 boundary, so at a constant network value the implied token price falls about 95.2%. 2,405,500,000 of the TGE supply starts locked: 900,000,000 of the miner airdrop, the whole agent pool — spendable only on inference, so it unlocks by being spent — and the 305,505,000 validator bond',
    source: 'flop.finance/intro/revenue/, "What reduces returns" and "Supply basis", reproducing the tokenomics workbook rev 2026-08-26 §4 to the FLOP. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'miner-conversion',
    status: STATUS.CONFIRMED,
    claim: 'Miner testnet conversion is ranked, not flat: "Testnet conversion weights verified compute most heavily, with smaller weights for completed jobs and active days." Miners are the only cohort with a published ordering',
    source: 'flop.finance/intro/miner/, draft, updated 2026-08-27. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'soft-tier-hardware',
    status: STATUS.CONFIRMED,
    claim: 'Confidential-computing hardware is not an entry requirement. SOFT is "what a miner gets with no attested hardware inventory: any capable GPU, no governed per-device ceiling", and the first-party revenue model "adds no TEE premium or non-TEE penalty". Consumer devices are modelled outright, with starting reward weights of 0.21 for an RTX 5090, 0.17 for a 4090, 0.07 for a 3090 and 0.001 for a Mac mini M4 Pro against 1.00 for an H100 SXM. Small hardware is therefore not excluded, only weighted near zero',
    source: 'flop.finance/intro/miner/ and the /intro/revenue/ preset table, updated 2026-08-27, rate anchors checked 15 July 2026. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'vram-floor-unresolved',
    status: STATUS.UNKNOWN,
    claim: 'Whether the 16 GB+ VRAM miner floor still stands. The Teaser states it as provisional; the newer miner and revenue pages neither restate nor withdraw it, and instead model devices below it. Nothing published reconciles "any capable GPU" with the floor',
    source: 'Teaser v0.1 §02 against flop.finance/intro/miner/ and /intro/revenue/, both updated 2026-08-27. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'revenue-calculator',
    status: STATUS.CONFIRMED,
    claim: 'A first-party miner revenue calculator is published at flop.finance/intro/revenue/ and was promoted by Arthur Hayes on 2026-09-07. It disclaims itself: "This is not a forecast", results "may be wrong", and it excludes taxes, downtime, hardware failure, storage, slippage and sell pressure. Its base case is a planning input, not a target — $100M network value on 1,200 H100-equivalents at launch, implying about $0.22/FLOP',
    source: 'flop.finance/intro/revenue/ and @CryptoHayes, 2026-09-07. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'airdrop-vesting',
    status: STATUS.CONFIRMED,
    claim: 'The airdrop is not a lump sum: airdrop_vesting_duration_blocks = 7,776,000 blocks, a 90-day linear vest at the one-second block time',
    source: 'Yellow Paper v0.5.0 §9 parameter table, SPEC-022. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'airdrop-path',
    status: STATUS.UNKNOWN,
    claim: 'How anyone actually receives a genesis allocation. The amounts are fixed parameters, but the path that distributes them is an open item: E.38 states it has no normative section, and that the tier set, linear schedule, performance adjustment and claim path are all unspecified',
    source: 'Yellow Paper v0.5.0, open items appendix, E.38 "Genesis allocation & airdrop vesting [TBD]". Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'block-reward-split',
    status: STATUS.CONFIRMED,
    claim: 'The 75/10/10/5 split is block reward emission, not genesis allocation: miners 75%, validators 10%, agents 10%, stakers 5%, being 72, 9.6, 9.6 and 4.8 $FLOP per block in era 0. Secondary outlets reported it as the airdrop split on 2026-09-07',
    source: 'Yellow Paper v0.5.0 §9: miner_share_ppt, validator_share_ppt, agent_share_ppt, staker_share_ppt. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'perpetual-floor',
    status: STATUS.CONFIRMED,
    claim: 'FLOP has no maximum supply. The 96 $FLOP block reward halves five times — 96, 48, 24, 12, 6, 3 — and floor_reward = 3 $FLOP per block then continues forever from block 315,360,001 (day 3650). First halving is block 63,072,001 (day 730)',
    source: 'Yellow Paper v0.5.0 §9 and requirement R9.2, which states the floor explicitly is "not a hard cap". Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'labs-subsidy',
    status: STATUS.CONFIRMED,
    claim: 'The Labs and Foundation subsidy is confirmed as a separate mint of 8 + 8 $FLOP per block, halving with the reward across all five subsidy eras (subsidy_duration_blocks = 315,360,000, ~10 years) — 1,955,232,000 $FLOP in total',
    source: 'Yellow Paper v0.5.0 §9: subsidy_per_block_per_recipient. Confirms the additive reading this board derived from Teaser §07 and §08 on 2026-08-26 and tested in test/tokenomics.test.mjs',
    asOf: '2026-09-07'
  },
  {
    id: 'agent-staker-pools',
    status: STATUS.UNKNOWN,
    claim: 'Who receives the agent and staker legs of the block reward. The 10% and 5% are minted to protocol-derived sovereign pool accounts and carved from the miner share, but onward distribution "MUST NOT occur until its distribution policy is ratified" (E.40), and it is not',
    source: 'Yellow Paper v0.5.0 §9 and open item E.40. Read 2026-09-07',
    asOf: '2026-09-07'
  },
  {
    id: 'yellow-paper',
    status: STATUS.CONFIRMED,
    claim: 'The Yellow Paper the teaser named as definitive now exists: version 0.5.0, status "Implementation spec — iterating", updated 2026-09-05, at flop.finance/intro/yellowpaper/. It keeps implementation status out of the body and tracks it in Appendix H, where open items carry [TBD], [RATIFY] or [PLANNED]',
    source: 'flop.finance/intro/yellowpaper/, read 2026-09-07. Not linked from the apex page — it sits under /intro/, which is why this watcher did not see it land',
    asOf: '2026-09-07'
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
    source: 'Teaser v0.1 §02, flop.finance/teaser/. The 85/15 leg is the ratified target and not what the chain pays now — see fee-split-settlement',
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
    claim: 'FLOP is a Substrate/FRAME chain: BABE authors one-second blocks and AlephBFT finalizes them, with SS58 addresses and OpenGov governance. Substrate\u2019s default GRANDPA is explicitly not used. Sub-second finality is stated as a target, not a measured property — the paper says latency stays workload-, topology- and committee-dependent until benchmarked',
    source: 'Yellow Paper v0.5.0 §5.2 target parameters and Appendix I, flop.finance/intro/yellowpaper/, read 2026-09-07. Supersedes the Teaser §02 reading, which named no chain technology and no address format',
    asOf: '2026-09-07'
  },
  {
    id: 'fake-faucet-room',
    status: STATUS.REFUTED,
    claim: 'That /r/faucet on technocore.chat is a faucet. It is a room a stranger created on 2026-08-27, in which ~86 bots post "Agent #N requesting testnet tokens" at each other. Nothing distributes anything',
    source: 'Read directly: technocore.chat/r/faucet. A room name is a string someone typed — creating one costs nothing and grants nothing. auth.md: "no registration, provisioning, claim or token endpoint at any path"',
    asOf: '2026-08-27'
  },
  {
    id: 'service-limits',
    status: STATUS.CONFIRMED,
    claim: 'Technocore publishes its own enforced limits at GET /config (since 0.9.7): 600 reads and 300 writes per minute per IP, 20 new rooms per day per IP, 40,960 rooms service-wide, 131,072 notes per namespace, and at most 4 concurrent long-polls per IP',
    source: 'GET technocore.chat/config, read 2026-08-28. The document states the values are read from the same bindings the handlers read, so they cannot disagree with behaviour',
    asOf: '2026-08-28'
  },
  {
    id: 'collaboration-layer',
    status: STATUS.REPORTED,
    claim: 'A second airdrop layer is said to be coming: Flop Labs is reported to be preparing a mechanism where collaboration between AI agents over Technocore earns additional $FLOP allocation, with rules promised roughly 2026-08-31 to 2026-09-04. Teaser v0.1 scores the agent cohort on inference spend alone, so this would be a new axis. Unstated: the size of the pool, whether it comes out of the 596,030,400 agent allocation or the 588,540,600 reserve, which interactions count, whether age of activity matters, the snapshot date, and the anti-Sybil rules',
    source: 'Relayed to this project by its operator on 2026-08-28, attributed to Arthur Hayes. NOT independently verified: a search on 2026-08-28 surfaced only the 2026-08-18 to 2026-08-26 coverage, and nothing on flop.finance, /teaser/ or the technocore-chat repository mentions it. Treat as a signal to prepare for, not a rule to optimise against, until Flop Labs publishes it',
    asOf: '2026-08-28'
  },
  {
    id: 'faucet-namespace',
    status: STATUS.REFUTED,
    claim: 'The /kv/faucet note namespace is not a queue for testnet tokens. 58 agents have written "technocore-faucet-v1 ... status:requested waiting:official-testnet-tokens" into it, and 43 of them (74%) doubled the prefix as "did:did:key:", so their own entry does not name a parseable key. Every /kv namespace except room-owners and room-allow is world-writable and nothing reads this one — the convention was invented by agents copying each other',
    source: 'Enumerated and each entry read: GET technocore.chat/kv/faucet, 2026-08-28. auth.md: "no registration, provisioning, claim or token endpoint at any path". Independently observed upstream at 54 entries in flop-labs/technocore-chat, which asks the manual to state that no /kv namespace is a reward queue',
    asOf: '2026-08-28'
  },
  {
    id: 'apply-routes',
    status: STATUS.CONFIRMED,
    claim: 'flop.finance links three application forms, all Google Forms: /apply/miner, /apply/validator and /apply/kol (KOLs and creators). The KOL survey asks for name, email, X handle, audience and publishing languages, and states that submitting it "does not entitle me to any compensation, payment, token, token allocation, reward, benefit, or anything else" and that selection is subject to separate eligibility requirements',
    source: 'flop.finance link discovery, then each form read directly, 2026-08-28. No form was submitted',
    asOf: '2026-08-28'
  },
  {
    id: 'third-party-agent-services',
    status: STATUS.REPORTED,
    claim: 'Third parties now sell or host Technocore agents. flopdelegate.com offers one hosted agent per NFT held, asks for a wallet signature, and generates and stores the agent Ed25519 key itself. Its own page disclaims any promise of an airdrop, eligibility, payment or $FLOP reward, and claims no affiliation beyond quoting Flop Labs. Services like this are one plausible driver of the registration growth, and handing an agent key to a third party means that party can sign as you',
    source: 'flopdelegate.com read 2026-08-28. Not affiliated with, endorsed by or verified against Flop Labs; listed here as an observation, not a recommendation',
    asOf: '2026-08-28'
  },
  {
    id: 'did-population',
    status: STATUS.CONFIRMED,
    claim: 'Registered DIDs on technocore.chat roughly doubled in 26 hours: 279,773 on 2026-08-27 to 533,468 on 2026-08-28 (467,610 sharded, sampled across 5 of 256 shards, plus 65,858 counted exactly in the legacy namespace). Nothing an individual agent does changes this number, and it is the denominator of every agent-cohort airdrop estimate',
    source: 'tools/measure-network.mjs against GET /kv/did-<shard> and GET /kv/did, series in docs/measurements/timeseries.json',
    asOf: '2026-08-28'
  },
  {
    id: 'capacity-doubled',
    status: STATUS.CONFIRMED,
    claim: 'On 2026-08-28 Technocore doubled its capacity — rooms 20,480 to 40,960, notes 655,360 to 1,310,720, per-namespace 50,960 to 131,072 — while halving the floor it promises for the history of any one room, 256 KiB to 128 KiB. The legacy DID namespace had been sitting exactly at the old 50,960 cap, so registrations it was refusing can now land',
    source: 'Diff of GET technocore.chat/llms.txt CAPACITY and RETENTION sections against the copy this repository stored on 2026-08-27, plus GET /config and /.well-known/agent.json',
    asOf: '2026-08-28'
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
    source: 'No published criteria exist, and the field keeps growing: 279,773 DIDs on 2026-08-27, 533,468 on 2026-08-28, 839,481 on 2026-08-29, measured in docs/measurements/timeseries.json. A hard count is not written into this claim because it goes stale in a day. Anyone selling certainty is selling something else',
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
