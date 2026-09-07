/**
 * The Flop Network Teaser v0.1, as machine-readable numbers — plus the arithmetic
 * the document itself does not do.
 *
 * Everything in TEASER and COHORTS below is quoted from the primary source.
 * Everything in the derive* functions is ours, and each exists because a number a
 * reader actually needs is not printed anywhere in the paper:
 *
 *   - What does one validator earn per block? The paper gives cohort totals over
 *     ten years and a single 96 $FLOP block reward. The split is never stated.
 *   - Does the arithmetic close? Three independent figures — the 96 reward, the
 *     8 + 8 to Labs and Foundation, and the year-10 cohort table — only reconcile
 *     under one reading of "in addition to". See reconcile().
 *   - What is the agent airdrop actually worth? It arrives locked, and unlocking
 *     consumes it. See deriveAgentUnlock(), the least intuitive number in the
 *     whole document.
 *
 * The paper is stamped "Version 0.1 (draft) ... figures are provisional" and says
 * the Yellow Paper is definitive and not yet final. Nothing here is a prediction,
 * a valuation, or advice. It is division, applied to figures someone else may
 * revise tomorrow.
 */

export const SOURCE = Object.freeze({
  title: 'The Flop Network — Teaser',
  version: '0.1 (draft)',
  url: 'https://flop.finance/teaser/',
  updated: '2026-08-26',
  retrieved: '2026-08-26',
  definitive: 'Yellow Paper (not yet final)',
  caveat: 'Flop Labs states the figures are provisional and under review against the protocol parameters of record.'
});

/** Section 02, "Network parameters". Quoted, not inferred. */
export const TEASER = Object.freeze({
  blockTimeSeconds: 1,
  baseBlockReward: 96,
  halvingDays: 730,
  /** "Every 730 days for the first five halvings", then constant in perpetuity. */
  halvingCount: 5,
  /** Sections 07 and 08: 8 each, "in addition to the 96 $FLOP block reward". */
  labsPerBlock: 8,
  foundationPerBlock: 8,
  minerFeeShare: 0.85,
  validatorFeeShare: 0.15,
  validatorSetSize: 1000,
  /** "roughly every month, the worst performing 50 validators are replaced". */
  validatorChurnPerMonth: 50,
  fipApprovalThreshold: 2 / 3
});

/** Section 03, the year-10 allocation table. Stated shares kept beside ours. */
export const COHORTS = Object.freeze({
  airdrop: { flop: 3_500_000_000, statedShare: 0.204, blockFunded: false },
  miners: { flop: 8_800_000_000, statedShare: 0.512, blockFunded: true },
  validators: { flop: 1_200_000_000, statedShare: 0.068, blockFunded: true },
  brokersAgents: { flop: 1_200_000_000, statedShare: 0.068, blockFunded: true },
  teamFoundation: { flop: 2_000_000_000, statedShare: 0.114, blockFunded: false },
  stakingRewards: { flop: 600_000_000, statedShare: 0.034, blockFunded: true }
});

/**
 * The Yellow Paper, which the teaser named as definitive and which arrived on
 * 2026-09-05. Read 2026-09-07. Its parameter table is machine-checked, so these
 * are quoted parameter names rather than prose.
 */
export const YELLOWPAPER = Object.freeze({
  title: 'FLOP Network Yellow Paper',
  version: '0.5.0 (draft)',
  status: 'Implementation spec — iterating',
  url: 'https://flop.finance/intro/yellowpaper/',
  updated: '2026-09-05',
  retrieved: '2026-09-07',
  /** §9. Halving schedule, subsidy and floor all confirm the teaser's numbers. */
  firstHalvingBlock: 63_072_001,
  floorReward: 3,
  floorFromBlock: 315_360_001,
  subsidyDurationBlocks: 315_360_000,
  subsidyTotal: 1_955_232_000,
  /** SPEC-022: the airdrop vests linearly over ninety days, it is not a lump sum. */
  airdropVestingBlocks: 7_776_000,
  /** R9.2. Cumulative emission to the end of era 5, ~year 12. Not a cap. */
  cumulativeEmissionEra5: 11_920_608_000,
  /** §9. Emission split, NOT the genesis allocation — outlets conflated the two. */
  rewardSplit: Object.freeze({ miners: 0.75, validators: 0.10, agents: 0.10, stakers: 0.05 })
});

/**
 * Section 03 of the teaser, kept because this project corrects rather than deletes.
 * Superseded on 2026-09-05: three of its four figures changed and the total fell
 * by more than a billion. Nothing should read it except a note about the change.
 */
export const GENESIS_AIRDROP_TEASER = Object.freeze({
  miners: 1_200_000_000,
  agents: 1_200_000_000,
  validators: 305_505_000,
  reserve: 794_495_000,
  total: 3_500_000_000
});

/**
 * The genesis airdrop breakdown, from the Yellow Paper parameter table. Exact.
 *
 * genesis_miner_airdrop 40%, genesis_agent_airdrop 24%, genesis_validator_airdrop
 * 12.3%, genesis_reserve 23.7%. The validator figure is the only one that survived
 * the teaser unchanged, which is why validator models are unaffected by the change.
 * The agent figure is the paper's own least settled: it is adopted "sheet-canonical
 * ... over the 50/24-25/30 conflict".
 */
export const GENESIS_AIRDROP = Object.freeze({
  miners: 993_384_000,
  agents: 596_030_400,
  validators: 305_505_000,
  reserve: 588_540_600,
  total: 2_483_460_000
});

/** Section 02, "Recommended hardware". Marked provisional in the source itself. */
export const HARDWARE = Object.freeze({
  miner: 'A single GPU, or a cluster of GPUs, with 16 GB+ VRAM per unit',
  validator: '8+ core CPU, 64 GB RAM, 2 TB NVMe storage, 1 Gbps redundant connection'
});

const SECONDS_PER_DAY = 86_400;

/** Blocks in one halving period, at the stated one-second average block time. */
export function blocksPerPeriod(t = TEASER) {
  return (t.halvingDays * SECONDS_PER_DAY) / t.blockTimeSeconds;
}

/**
 * Blocks weighted by their reward multiplier, summed over the halving periods.
 *
 * Emission over ten years is not blocks × 96: the reward halves four times along
 * the way. Expressing the decade as "period-one-equivalent blocks" makes every
 * later division a one-liner.
 */
export function blockEquivalents(periods = TEASER.halvingCount, t = TEASER) {
  let total = 0;
  for (let i = 0; i < periods; i++) total += blocksPerPeriod(t) / 2 ** i;
  return total;
}

/** Per-period emission table: reward, blocks, and what each period issues. */
export function emissionSchedule(t = TEASER) {
  const blocks = blocksPerPeriod(t);
  const rows = [];
  for (let i = 0; i < t.halvingCount; i++) {
    const factor = 2 ** -i;
    const baseReward = t.baseBlockReward * factor;
    const teamReward = (t.labsPerBlock + t.foundationPerBlock) * factor;
    rows.push({
      period: i + 1,
      startDay: i * t.halvingDays,
      endDay: (i + 1) * t.halvingDays,
      blockReward: baseReward,
      teamPerBlock: teamReward,
      totalPerBlock: baseReward + teamReward,
      blocks,
      baseIssued: baseReward * blocks,
      teamIssued: teamReward * blocks,
      totalIssued: (baseReward + teamReward) * blocks
    });
  }
  return rows;
}

/**
 * The per-block split of the 96 $FLOP reward between the four cohorts it funds.
 *
 * The paper never prints this, and it is the number a prospective validator or
 * miner most needs. It follows from the year-10 cohort totals: if each of the
 * four block-funded cohorts takes a fixed slice of every block, its slice must be
 * its share of their combined total.
 */
export function derivePerBlockSplit(cohorts = COHORTS, t = TEASER) {
  const funded = Object.entries(cohorts).filter(([, c]) => c.blockFunded);
  const pool = funded.reduce((sum, [, c]) => sum + c.flop, 0);

  const split = {};
  for (const [name, cohort] of funded) {
    split[name] = {
      perBlock: (cohort.flop / pool) * t.baseBlockReward,
      shareOfReward: cohort.flop / pool
    };
  }
  return { pool, split };
}

/**
 * Does the document close?
 *
 * Three figures are stated independently and can be checked against each other:
 * the 96 $FLOP block reward, the 8 + 8 to Labs and Foundation, and the year-10
 * cohort table totalling about 17.2bn. They reconcile only if "in addition to the
 * 96 $FLOP block reward" is read literally — 112 $FLOP leaves the protocol per
 * block, not 96 with the team share carved out of it.
 *
 * Under that reading the derived supply lands within a fraction of a percent of
 * the stated total. Under the alternative it misses by well over a billion $FLOP.
 * That is strong evidence for the literal reading, and worth stating plainly:
 * issuance is 112/96 = 1.167x what the headline block reward suggests.
 */
export function reconcile(cohorts = COHORTS, t = TEASER) {
  const equivalents = blockEquivalents(t.halvingCount, t);
  const teamPerBlock = t.labsPerBlock + t.foundationPerBlock;

  const derivedBaseEmission = t.baseBlockReward * equivalents;
  const derivedTeamEmission = teamPerBlock * equivalents;
  const derivedSupply = cohorts.airdrop.flop + derivedBaseEmission + derivedTeamEmission;

  const statedSupply = Object.values(cohorts).reduce((sum, c) => sum + c.flop, 0);
  const blockFundedStated = Object.values(cohorts)
    .filter((c) => c.blockFunded)
    .reduce((sum, c) => sum + c.flop, 0);

  return {
    equivalents,
    totalPerBlock: t.baseBlockReward + teamPerBlock,
    derivedBaseEmission,
    derivedTeamEmission,
    derivedSupply,
    statedSupply,
    /**
     * The stated cohort figures are round numbers while the stated percentages
     * are normalised to exactly 100%, so the two disagree slightly. Reporting the
     * gap is more useful than picking a side.
     */
    supplyGap: statedSupply - derivedSupply,
    supplyGapPct: (statedSupply - derivedSupply) / derivedSupply,
    teamEmissionVsStated: derivedTeamEmission - cohorts.teamFoundation.flop,
    blockFundedStated,
    blockFundedDerived: derivedBaseEmission,
    dilutionFactor: (t.baseBlockReward + teamPerBlock) / t.baseBlockReward
  };
}

/**
 * What an agent airdrop is actually worth.
 *
 * Section 04: the agent airdrop "arrives locked and spendable only on inference
 * or staking — every 3 $FLOP spent on inference unlocks 1 airdropped $FLOP".
 *
 * Read carefully, that is a self-consuming schedule. The locked balance is the
 * thing being spent, so each unlock removes four tokens from it: three spent on
 * inference and one converted to liquid. An agent taking the inference route and
 * nothing else can free at most a quarter of its allocation; the other three
 * quarters necessarily flow back to miners and validators as compute purchases.
 *
 * This is not a criticism — it is the mechanism working. The airdrop is largely a
 * compute voucher rather than a token grant, and an agent that genuinely wants
 * the compute loses nothing: it pays market rate and gets liquidity as a rebate.
 * An agent that only wanted tokens should read the multiplier as 0.25.
 *
 * The staking route is deliberately not modelled: the yield on staked locked
 * $FLOP is not stated anywhere in the teaser.
 */
export function deriveAgentUnlock(allocation, ratio = 3) {
  const perEvent = ratio + 1;
  return {
    allocation,
    unlockRatio: ratio,
    maxLiquid: allocation / perEvent,
    inferenceRequired: allocation * (ratio / perEvent),
    liquidShare: 1 / perEvent,
    note: 'Inference route only. Locked $FLOP is itself the spendable balance, so each unlock '
      + 'consumes 3 spent plus 1 freed. Staking is the other permitted use and its yield is unstated.'
  };
}

/**
 * One validator's block-reward income, assuming an evenly-shared cohort slice.
 *
 * Even sharing is an assumption, not a quote — the paper says validators earn
 * block rewards without saying whether the split weights stake or performance.
 * It is the neutral reading, and it is flagged rather than hidden.
 */
export function deriveValidatorIncome({ setSize = TEASER.validatorSetSize, cohorts = COHORTS, t = TEASER } = {}) {
  const { split } = derivePerBlockSplit(cohorts, t);
  const cohortPerBlock = split.validators.perBlock;
  const perValidatorPerBlock = cohortPerBlock / setSize;
  const blocksPerDay = SECONDS_PER_DAY / t.blockTimeSeconds;

  return {
    setSize,
    cohortPerBlock,
    perValidatorPerBlock,
    perValidatorPerDay: perValidatorPerBlock * blocksPerDay,
    perValidatorPerYear: perValidatorPerBlock * blocksPerDay * 365,
    firstPeriodTotal: perValidatorPerBlock * blocksPerPeriod(t),
    tenYearTotal: cohorts.validators.flop / setSize,
    genesisStake: GENESIS_AIRDROP.validators / setSize,
    assumption: 'Cohort rewards shared evenly across the set. The teaser does not state the split rule.'
  };
}

/** Round to a fixed number of decimals without dragging in a formatter. */
export const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
