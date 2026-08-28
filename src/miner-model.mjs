/**
 * Mining against validating, on rented hardware, priced honestly.
 *
 * The operator asked which is the better bet if the machine is rented rather
 * than owned. That question has a clean answer, and it is not the one the
 * headline numbers suggest.
 *
 * The teaser gives miners 74.6% of every block and validators 10.2% — a 7.3x
 * advantage that makes mining look obviously better. It is not, for two reasons
 * the split does not show:
 *
 *   THE DENOMINATOR   A validator competes for one of 1,000 seats. A miner
 *                     competes against however much compute shows up, which
 *                     nothing caps and nobody has announced. Miners share a
 *                     larger pie among an unknown number of people; validators
 *                     share a smaller one among exactly 1,000.
 *
 *   THE COST FLOOR    A validator needs no GPU — the published spec lists CPU,
 *                     RAM, disk and a redundant link. A miner needs a GPU with
 *                     16 GB of VRAM per unit, and rented GPU-hours cost several
 *                     times what a dedicated server costs.
 *
 * So mining pays a higher rent to compete in a race with no field limit, and
 * validating pays a lower rent to compete in a race with a known field. This
 * file computes both rather than asserting either.
 *
 * Everything here is provisional twice over: the teaser says its own figures are
 * under review, and the rental prices are market observations that move. Prices
 * are therefore ranges, and every result carries the assumption that produced it.
 */

import { TEASER, GENESIS_AIRDROP, derivePerBlockSplit } from './tokenomics.mjs';

/** Blocks per year at the stated ~1s block time. */
export const BLOCKS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * The published miner hardware line, and what it does not say.
 *
 * "16 GB+ VRAM per unit" sets a floor, not a target. Nothing published says how
 * throughput converts to reward share, so a bigger card may earn proportionally
 * more, or may not — that is the single largest unknown in the miner case and it
 * is named rather than assumed away.
 */
export const MINER_SPEC = Object.freeze({
  vramGb: 16,
  note: 'Provisional. "GPU with 16 GB+ VRAM per unit" is the whole published requirement. '
    + 'No throughput-to-reward curve, no minimum uptime, and no unit cap is stated.'
});

/**
 * Rented GPU capacity, at the going rate for the class.
 *
 * Marketplace pricing, not list pricing: the cheap end is interruptible capacity
 * on a spot-style marketplace, the dear end is a reserved instance from a major
 * cloud. Interruptible is much cheaper and much worse for anything scored on
 * uptime, which is the trade that matters here.
 */
export const GPU_TIERS = Object.freeze([
  {
    id: 'marketplace-16gb',
    label: 'Marketplace 16 GB (spot / interruptible)',
    hourlyUsd: 0.22,
    bandUsd: [0.15, 0.35],
    fits: 'Meets the stated 16 GB floor and nothing more.',
    risk: 'Interruptible. Reclaimed without notice, which is fatal to anything measured on continuity.'
  },
  {
    id: 'marketplace-24gb',
    label: 'Marketplace 24 GB (dedicated)',
    hourlyUsd: 0.45,
    bandUsd: [0.30, 0.70],
    fits: 'Comfortable headroom over the floor; the sensible default if mining at all.',
    risk: 'Small providers, variable reliability, and payment usually up front.'
  },
  {
    id: 'cloud-80gb',
    label: 'Major-cloud 80 GB (reserved)',
    hourlyUsd: 2.40,
    bandUsd: [1.80, 3.50],
    fits: 'Datacentre-grade, contractual uptime.',
    risk: 'Ten times the marketplace rate. Needs a reward curve that pays for capability, and no such curve is published.'
  }
]);

/** A month of continuous rental, in euro, at an assumed USD/EUR rate. */
export function monthlyRentEur(hourlyUsd, { hoursPerMonth = 730, usdPerEur = 1.08 } = {}) {
  return (hourlyUsd * hoursPerMonth) / usdPerEur;
}

/**
 * What one participant earns per year from block rewards alone, given a share.
 *
 * Deliberately expressed as a share rather than as hardware, because no
 * published rule converts hardware into share. Anyone claiming otherwise is
 * guessing, and this returns the guess as an input the caller must supply.
 */
export function annualBlockReward(cohort, share, { t = TEASER, year = 1 } = {}) {
  const { split } = derivePerBlockSplit(undefined, t);
  const perBlock = split[cohort]?.perBlock;
  if (!Number.isFinite(perBlock)) throw new Error(`unknown cohort: ${cohort}`);
  // Halvings land every 730 days; year 1 and 2 are pre-halving.
  const halvings = Math.floor(((year - 1) * 365) / t.halvingDays);
  const factor = 1 / 2 ** Math.min(halvings, t.halvingCount);
  return perBlock * factor * BLOCKS_PER_YEAR * share;
}

/**
 * The validator case, per seat, and what it costs to hold one.
 *
 * A seat's share is exactly 1/setSize — that is the whole appeal. The
 * uncertainty is not how much a seat earns but whether you keep it: roughly
 * every month the worst-performing 50 are replaced by the top 50 waiting.
 */
export function validatorCase({ setSize = TEASER.validatorSetSize, monthlyEur = 75, year = 1 } = {}) {
  const share = 1 / setSize;
  const flopPerYear = annualBlockReward('validators', share, { year });
  const airdrop = GENESIS_AIRDROP.validators / setSize;

  return {
    seats: setSize,
    share,
    flopPerYear,
    costEurPerYear: monthlyEur * 12,
    airdropFlop: airdrop,
    airdropIsStake: true,
    note: 'The airdrop IS the required stake: bonded at launch as slashing collateral, '
      + 'locked through the first halving, then released over 1,000 days. It is not spendable '
      + 'on arrival and it is at risk while bonded.'
  };
}

/**
 * The miner case, for an assumed share of network compute.
 *
 * `share` is the input nothing published can pin down. It is expressed as "one
 * unit among N units" so the caller states the field size explicitly rather than
 * hiding it inside a hashrate figure.
 */
export function minerCase({ competingUnits = 10_000, units = 1, hourlyUsd = 0.45, year = 1 } = {}) {
  const share = units / competingUnits;
  const flopPerYear = annualBlockReward('miners', share, { year });
  const monthly = monthlyRentEur(hourlyUsd) * units;

  return {
    competingUnits,
    units,
    share,
    flopPerYear,
    costEurPerYear: monthly * 12,
    monthlyEur: monthly,
    airdropNote: 'The miner airdrop is up to 1.2bn $FLOP across an unbounded field. '
      + 'Per-participant value cannot be stated because nothing caps the number of miners.'
  };
}

/**
 * The break-even $FLOP price for each route: what a token must be worth for the
 * rent to be covered.
 *
 * This is the comparison that actually decides it. Both routes cost real euro
 * per month and pay in a token with no price, so the honest question is not
 * "which earns more $FLOP" but "which needs the token to be worth less in order
 * to make sense". A lower break-even price is a safer bet, not a smaller one.
 */
export function breakEvenPrice({ competingUnits = 10_000, minerHourlyUsd = 0.45, validatorMonthlyEur = 75, setSize = TEASER.validatorSetSize, year = 1 } = {}) {
  const validator = validatorCase({ setSize, monthlyEur: validatorMonthlyEur, year });
  const miner = minerCase({ competingUnits, hourlyUsd: minerHourlyUsd, year });

  return {
    validator: {
      ...validator,
      breakEvenEurPerFlop: validator.flopPerYear > 0 ? validator.costEurPerYear / validator.flopPerYear : Infinity
    },
    miner: {
      ...miner,
      breakEvenEurPerFlop: miner.flopPerYear > 0 ? miner.costEurPerYear / miner.flopPerYear : Infinity
    }
  };
}

/**
 * The same comparison across plausible field sizes.
 *
 * A single number would hide the only thing that matters: the miner column moves
 * with a quantity nobody controls or has announced, and the validator column
 * does not move at all.
 */
export function fieldSensitivity({ fields = [1_000, 5_000, 25_000, 100_000, 500_000], minerHourlyUsd = 0.45, validatorMonthlyEur = 75, year = 1 } = {}) {
  return fields.map((competingUnits) => {
    const result = breakEvenPrice({ competingUnits, minerHourlyUsd, validatorMonthlyEur, year });
    return {
      competingUnits,
      minerFlopPerYear: result.miner.flopPerYear,
      minerBreakEven: result.miner.breakEvenEurPerFlop,
      validatorFlopPerYear: result.validator.flopPerYear,
      validatorBreakEven: result.validator.breakEvenEurPerFlop,
      // How many times dearer the token must be for mining to pay, at this field size.
      minerPenalty: result.miner.breakEvenEurPerFlop / result.validator.breakEvenEurPerFlop
    };
  });
}

/**
 * What neither model captures, stated rather than buried.
 *
 * Every one of these can invert the conclusion, and none of them is knowable
 * today. A model whose limits are not written down gets quoted as a forecast.
 */
export const UNMODELLED = Object.freeze([
  'Inference fees. Miners take 85% of every fee and validators 15%, on top of block rewards. '
    + 'No fee level is published, so this models block rewards only — and the omission favours mining.',
  'How compute converts to miner reward share. "16 GB+ VRAM per unit" is a floor, not a curve.',
  'How many miners show up. The field size is the dominant term and it is a guess.',
  'Whether a validator seat can be won at all: 1,000 seats, selection criteria unpublished, '
    + 'and roughly monthly replacement of the worst 50.',
  'Slashing. A validator stake is collateral, so the downside is not merely a missed reward.',
  'The $FLOP price, which does not exist, and the token has no market and no wallet format.',
  'Rental prices, which are market observations from 2026-08 and move.'
]);
