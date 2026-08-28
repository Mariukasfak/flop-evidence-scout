import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TEASER, GENESIS_AIRDROP } from '../src/tokenomics.mjs';
import {
  BLOCKS_PER_YEAR, GPU_TIERS, monthlyRentEur, annualBlockReward,
  validatorCase, minerCase, breakEvenPrice, fieldSensitivity, UNMODELLED
} from '../src/miner-model.mjs';

describe('Renting to mine against renting to validate', () => {
  test('a validator seat is exactly one thousandth, not an estimate', () => {
    const v = validatorCase({});
    assert.equal(v.seats, TEASER.validatorSetSize);
    assert.equal(v.share, 1 / 1000);
    // 9.763 per block, one thousandth of it, every second for a year.
    assert.ok(Math.abs(v.flopPerYear - (9.763 * BLOCKS_PER_YEAR) / 1000) < 5000);
  });

  test('a miner unit shrinks with the field, and the field is the whole risk', () => {
    const small = minerCase({ competingUnits: 1_000 });
    const large = minerCase({ competingUnits: 100_000 });
    assert.ok(small.flopPerYear > large.flopPerYear * 99, 'reward is inversely proportional to the field');
    assert.equal(small.costEurPerYear, large.costEurPerYear, 'the rent does not care how many others show up');
  });

  /**
   * The comparison that decides it. Both routes cost euro and pay in a token
   * with no price, so the question is which needs the token to be worth less.
   */
  test('mining needs a dearer token at every realistic field size', () => {
    const rows = fieldSensitivity({});
    const realistic = rows.filter((r) => r.competingUnits >= 5_000);
    for (const row of realistic) {
      assert.ok(row.minerPenalty > 1,
        `at ${row.competingUnits} units mining should need a dearer token, got ${row.minerPenalty}`);
    }
    // And the penalty grows with the field rather than levelling off.
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].minerPenalty > rows[i - 1].minerPenalty);
    }
  });

  test('the validator break-even does not move with the miner field', () => {
    const rows = fieldSensitivity({});
    const unique = new Set(rows.map((r) => r.validatorBreakEven.toFixed(9)));
    assert.equal(unique.size, 1, 'a validator seat is priced by the set size, nothing else');
  });

  test('renting a GPU costs several times renting a server', () => {
    const gpu = monthlyRentEur(GPU_TIERS.find((t) => t.id === 'marketplace-24gb').hourlyUsd);
    assert.ok(gpu > 250 && gpu < 400, `expected roughly 300 EUR/mo, got ${gpu}`);
    assert.ok(gpu / 75 > 3, 'the miner rent floor is multiples of the validator one');
  });

  test('halvings reduce the reward, and stop after the stated count', () => {
    const y1 = annualBlockReward('validators', 1 / 1000, { year: 1 });
    const y3 = annualBlockReward('validators', 1 / 1000, { year: 3 });
    assert.ok(Math.abs(y3 - y1 / 2) < 1, 'year 3 is past the first halving');

    const far = annualBlockReward('validators', 1 / 1000, { year: 40 });
    const floor = y1 / 2 ** TEASER.halvingCount;
    assert.ok(Math.abs(far - floor) < 1, 'emission is constant in perpetuity after the last halving');
  });

  test('an unknown cohort is refused rather than silently zero', () => {
    assert.throws(() => annualBlockReward('brokers-typo', 0.1), /unknown cohort/);
  });

  /**
   * The validator airdrop is not spending money — it is the bond. Reporting it
   * as income would be the single most misleading thing this model could do.
   */
  test('the validator airdrop is flagged as the stake, not as a payout', () => {
    const v = validatorCase({});
    assert.equal(v.airdropIsStake, true);
    assert.equal(v.airdropFlop, GENESIS_AIRDROP.validators / 1000);
    assert.match(v.note, /collateral/);
  });

  test('the miner airdrop refuses to state a per-participant figure', () => {
    const m = minerCase({});
    assert.equal(m.airdropFlop, undefined, 'no per-miner number can be honestly derived');
    assert.match(m.airdropNote, /unbounded/);
  });

  test('the model says out loud what it leaves out', () => {
    const text = UNMODELLED.join(' ').toLowerCase();
    // Fees favour mining and are excluded; saying so is what keeps this honest.
    assert.match(text, /inference fees/);
    assert.match(text, /slashing/);
    assert.match(text, /price/);
    assert.ok(UNMODELLED.length >= 5);
  });

  test('break-even is infinite rather than NaN when nothing is earned', () => {
    const result = breakEvenPrice({ competingUnits: Infinity });
    assert.equal(result.miner.breakEvenEurPerFlop, Infinity);
    assert.ok(Number.isFinite(result.validator.breakEvenEurPerFlop));
  });
});
