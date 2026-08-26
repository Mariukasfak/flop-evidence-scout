/**
 * What running a Flop validator would cost, and what it could return.
 *
 * The teaser publishes a provisional validator spec, a capped set of 1,000, a
 * genesis stake, and cohort totals. It never puts them together, so this does.
 *
 * The single most important thing the arithmetic shows is not an income figure.
 * It is this: section 04 says a validator's airdrop *is* the stake it must post.
 * Anyone selected through the testnet is handed their entry ticket. Anyone
 * arriving afterwards has to buy 305,505 $FLOP on the open market to sit down.
 * The testnet is therefore the only moment when a validator seat costs hosting
 * rather than capital, and that window is ninety days in Q4 2026.
 *
 * Nothing here is advice or a valuation. Costs are inputs, not claims — pass a
 * real quote and the model uses it. Where a price is unavoidable the question is
 * inverted into "what would $FLOP have to be worth to cover this", which needs no
 * forecast.
 */

import { COHORTS, GENESIS_AIRDROP, TEASER, derivePerBlockSplit, blocksPerPeriod } from './tokenomics.mjs';

const SECONDS_PER_DAY = 86_400;

/**
 * Section 02, "Recommended hardware", marked provisional and "subject to
 * refinement before testnet".
 *
 * Note what is absent: no GPU. That sits awkwardly beside section 02's third
 * verification layer, which has validators "re-execute a randomised sample of
 * sessions" — re-running an LLM inference is not an 8-core CPU job. Either the
 * sampled re-execution is rarer or smaller than it reads, or the recommended spec
 * is incomplete. It is an open question, not a gotcha, and it is the one thing
 * that could change this budget by an order of magnitude.
 */
export const VALIDATOR_SPEC = Object.freeze({
  cpuCores: 8,
  ramGb: 64,
  storageTb: 2,
  storageType: 'NVMe',
  networkGbps: 1,
  networkNote: 'redundant',
  gpu: null,
  provisional: true,
  openQuestion: 'The spec lists no GPU, yet validators re-execute a random sample of inference '
    + 'sessions. If sampled re-execution needs accelerator hardware, this budget is wrong.'
});

/**
 * Reference hosting tiers.
 *
 * These are indicative monthly bands for hardware meeting the spec, not quotes,
 * and they are deliberately wide. Verify current pricing before committing — pass
 * `--cost=` to the tool and every number below recomputes.
 *
 * The tiers are ordered by the thing that actually matters here. Uptime is an
 * explicit selection criterion and the worst 50 validators are replaced monthly,
 * so the cheapest host is not the best value: an unreliable box does not earn
 * less, it loses the seat.
 */
export const HOSTING_TIERS = Object.freeze([
  {
    id: 'budget-dedicated',
    label: 'Budget dedicated server',
    monthlyEur: 45,
    bandEur: [40, 60],
    fits: 'Typically 8c/16t, 64 GB, 2 x 1 TB NVMe. Note 2 x 1 TB in RAID1 is 1 TB usable, not 2 TB.',
    risk: 'Consumer-grade lines and best-effort support. Cheapest per month, weakest on the criterion being scored.'
  },
  {
    id: 'standard-dedicated',
    label: 'Standard dedicated server',
    monthlyEur: 75,
    bandEur: [60, 110],
    fits: 'Modern 8c/16t, 64 GB ECC, 2 TB NVMe, 1 Gbps unmetered.',
    risk: 'The sensible default if the provisional spec holds.'
  },
  {
    id: 'managed-cloud',
    label: 'Managed cloud instance + block storage',
    monthlyEur: 150,
    bandEur: [110, 220],
    fits: '16 vCPU / 64 GB plus a 2 TB volume. Snapshots and quick rebuilds included.',
    risk: 'Most expensive, easiest to recover, and the only tier where a failed disk is somebody else’s problem.'
  }
]);

/**
 * Self-hosting is modelled so it can be ruled out on numbers rather than vibes.
 *
 * A machine at home fails this brief on the criterion that decides selection.
 * Residential power and consumer ISPs both drop; the spec asks for a *redundant*
 * 1 Gbps line, which a home connection is not; and a validator scored on uptime,
 * block production and latency competes against a thousand racked machines.
 *
 * Note that the running cost argues the other way: electricity comes to well
 * under a rented server, so this is a reliability case, not a cost one.
 */
export function selfHostCost({ watts = 120, pricePerKwh = 0.16, hoursPerDay = 24 } = {}) {
  const kwhPerMonth = (watts / 1000) * hoursPerDay * 30.44;
  const electricityEur = kwhPerMonth * pricePerKwh;
  return {
    watts,
    pricePerKwh,
    kwhPerMonth,
    electricityEur,
    /**
     * Being accurate about this matters, because the honest answer cuts against
     * the recommendation. Electricity is *cheap* - well under a rented server.
     * Self-hosting loses on reliability, not on running cost, and saying
     * otherwise would be arguing the case with a number that does not support it.
     */
    verdict: 'Electricity is the cheap part, and well under a rented server. Self-hosting loses '
      + 'on the criterion that decides selection - uptime and a redundant line - not on cost. '
      + 'Add the hardware itself and the gap narrows further, but the reliability gap does not.',
    disqualifiers: [
      'A residential connection is not redundant, which the spec explicitly asks for.',
      'Power cuts and ISP maintenance are scored against you; the worst 50 validators are replaced monthly.',
      'The machine is also the operator’s desktop, so reboots and updates cost uptime.'
    ]
  };
}

/** One validator's block-reward income across the halving schedule. */
export function validatorIncome({ setSize = TEASER.validatorSetSize, cohorts = COHORTS, t = TEASER } = {}) {
  const { split } = derivePerBlockSplit(cohorts, t);
  const perValidatorPerBlock = split.validators.perBlock / setSize;
  const blocksPerDay = SECONDS_PER_DAY / t.blockTimeSeconds;

  const periods = [];
  for (let i = 0; i < t.halvingCount; i++) {
    const factor = 2 ** -i;
    periods.push({
      period: i + 1,
      // 730 days is 1.998 years, and truncating that printed period 1 as "0-1".
      years: `${Math.round((i * t.halvingDays) / 365.25)}-${Math.round(((i + 1) * t.halvingDays) / 365.25)}`,
      perDay: perValidatorPerBlock * factor * blocksPerDay,
      perYear: perValidatorPerBlock * factor * blocksPerDay * 365,
      periodTotal: perValidatorPerBlock * factor * blocksPerPeriod(t)
    });
  }

  return {
    setSize,
    perValidatorPerBlock,
    periods,
    tenYearBlockRewards: cohorts.validators.flop / setSize,
    genesisStake: GENESIS_AIRDROP.validators / setSize,
    feeShare: t.validatorFeeShare,
    feeNote: 'Validators also split 15% of every inference fee. Session volume is unknown, so fee '
      + 'income is not modelled — every figure here is a floor, not a forecast.'
  };
}

/**
 * The stake, which is the actual prize.
 *
 * Bonded at launch as slashing collateral rather than paid out, locked through
 * the first halving (730 days), then released over the following 1,000 days. So
 * it is not income for roughly two years and not fully liquid for nearly five.
 */
export function stakeSchedule({ setSize = TEASER.validatorSetSize, t = TEASER } = {}) {
  const stake = GENESIS_AIRDROP.validators / setSize;
  return {
    stake,
    lockedDays: t.halvingDays,
    releaseDays: 1000,
    firstUnlockDay: t.halvingDays,
    fullyLiquidDay: t.halvingDays + 1000,
    perDayDuringRelease: stake / 1000,
    note: 'Bonded as slashing collateral at launch, locked through the first halving, then '
      + 'released over 1,000 days. Slashable throughout.'
  };
}

/**
 * The inverted question: what must one $FLOP be worth to cover the hosting bill?
 *
 * This replaces a price forecast with a threshold, which is checkable rather than
 * speculative. The threshold rises over time — rewards halve every 730 days while
 * hosting costs do not — so the comfortable early years are the misleading ones.
 */
export function breakEven({ monthlyEur = 75, setSize = TEASER.validatorSetSize, years = [1, 2, 5, 10] } = {}) {
  const income = validatorIncome({ setSize });
  const blocksPerDay = SECONDS_PER_DAY / TEASER.blockTimeSeconds;
  const perBlock = income.perValidatorPerBlock;

  return years.map((year) => {
    // Sum the halving schedule day by day out to `year`.
    let earned = 0;
    const days = Math.round(year * 365);
    for (let day = 0; day < days; day++) {
      const factor = 2 ** -Math.min(Math.floor(day / TEASER.halvingDays), TEASER.halvingCount - 1);
      earned += perBlock * factor * blocksPerDay;
    }
    const cost = monthlyEur * 12 * year;
    return {
      year,
      earnedFlop: earned,
      costEur: cost,
      breakEvenPriceEur: earned > 0 ? cost / earned : Infinity
    };
  });
}

/**
 * What the ninety days of testnet actually buy.
 *
 * The testnet pays in test tokens, which are worth nothing. The return is
 * entirely the option it creates: a seat in the capped mainnet set, with the
 * required stake granted rather than purchased.
 */
export function testnetCase({ monthlyEur = 75, testnetDays = 90, setSize = TEASER.validatorSetSize } = {}) {
  const cost = (monthlyEur / 30.44) * testnetDays;
  const stake = GENESIS_AIRDROP.validators / setSize;
  const income = validatorIncome({ setSize });

  return {
    testnetDays,
    costEur: cost,
    stakeGranted: stake,
    tenYearBlockRewards: income.tenYearBlockRewards,
    totalTenYearFlop: stake + income.tenYearBlockRewards,
    /** What a latecomer pays instead: the same stake, at market. */
    latecomerMustBuyFlop: stake,
    breakEvenPriceEur: cost / stake,
    caveats: [
      'Selection is competitive: the top 1,000 on uptime, block production, accuracy and latency.',
      'The seat is not permanent - roughly 50 of 1,000 are replaced each month.',
      'The stake is slashable, up to the entire amount, for a dishonest block.',
      'The hardware spec is provisional and may gain a GPU requirement before testnet.',
      'No testnet has launched and no validator software has been published.'
    ]
  };
}
