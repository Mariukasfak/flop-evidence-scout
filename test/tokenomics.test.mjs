import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEASER, COHORTS, GENESIS_AIRDROP,
  blocksPerPeriod, blockEquivalents, emissionSchedule,
  derivePerBlockSplit, reconcile, deriveAgentUnlock, deriveValidatorIncome
} from '../src/tokenomics.mjs';

test('a halving period is 63,072,000 blocks at one second', () => {
  assert.equal(blocksPerPeriod(), 63_072_000);
});

test('ten years is 122,202,000 period-one-equivalent blocks', () => {
  // 1 + 1/2 + 1/4 + 1/8 + 1/16 = 1.9375 periods at the opening rate.
  assert.equal(blockEquivalents(), 63_072_000 * 1.9375);
  assert.equal(blockEquivalents(), 122_202_000);
});

test('the halving schedule runs 96, 48, 24, 12, 6', () => {
  assert.deepEqual(emissionSchedule().map((r) => r.blockReward), [96, 48, 24, 12, 6]);
  // Labs and Foundation halve on the same schedule.
  assert.deepEqual(emissionSchedule().map((r) => r.teamPerBlock), [16, 8, 4, 2, 1]);
});

test('112 $FLOP leaves the protocol per block, not 96', () => {
  const r = reconcile();
  assert.equal(r.totalPerBlock, 112);
  assert.equal(r.dilutionFactor, 112 / 96);
});

test('the teaser reconciles to within 1% under the literal reading', () => {
  const r = reconcile();
  // Derived: 3.5bn airdrop + 96/block + 16/block over ten years.
  assert.ok(Math.abs(r.supplyGapPct) < 0.01,
    `expected the document to close within 1%, got ${(r.supplyGapPct * 100).toFixed(2)}%`);
  assert.ok(r.derivedSupply > 17.1e9 && r.derivedSupply < 17.3e9);
});

test('the team allocation is only 2.0bn if it is additive to the 96', () => {
  // This is the load-bearing test. Sections 07 and 08 say Labs and the Foundation
  // each take 8 $FLOP per block "in addition to the 96 $FLOP block reward". If
  // that phrase instead meant a carve-out of the 96, the decade's issuance would
  // be 96/block flat and the stated 17.2-17.3bn total could not be reached.
  const additive = reconcile();

  const carvedOut = reconcile(COHORTS, { ...TEASER, labsPerBlock: 0, foundationPerBlock: 0 });
  const carvedOutMiss = Math.abs(carvedOut.supplyGapPct);

  assert.ok(carvedOutMiss > 0.10,
    `the carve-out reading should miss badly, it misses by ${(carvedOutMiss * 100).toFixed(1)}%`);
  assert.ok(Math.abs(additive.supplyGapPct) < carvedOutMiss / 10,
    'the additive reading should fit an order of magnitude better than the carve-out reading');

  // And it lands on the stated 2.0bn, give or take the rounding in the table.
  assert.ok(Math.abs(additive.teamEmissionVsStated) < 50e6);
});

test('the derived per-block split sums to exactly the block reward', () => {
  const { split } = derivePerBlockSplit();
  const sum = Object.values(split).reduce((total, s) => total + s.perBlock, 0);
  assert.ok(Math.abs(sum - TEASER.baseBlockReward) < 1e-9);

  // Miners take roughly three quarters of every block; the paper never says so.
  assert.ok(split.miners.perBlock > 71 && split.miners.perBlock < 72);
  assert.ok(split.validators.perBlock > 9.7 && split.validators.perBlock < 9.8);
  // Validators and brokers hold equal 1.2bn allocations, so equal slices.
  assert.equal(split.validators.perBlock, split.brokersAgents.perBlock);
});

test('the agent airdrop frees at most a quarter of itself by inference', () => {
  const u = deriveAgentUnlock(GENESIS_AIRDROP.agents);
  assert.equal(u.maxLiquid, 300_000_000);
  assert.equal(u.inferenceRequired, 900_000_000);
  assert.equal(u.liquidShare, 0.25);
  // Every unlock consumes four tokens: three spent, one freed.
  assert.equal(u.maxLiquid + u.inferenceRequired, GENESIS_AIRDROP.agents);
});

test('the genesis airdrop breakdown adds up to the stated 3.5bn', () => {
  const sum = GENESIS_AIRDROP.miners + GENESIS_AIRDROP.agents
    + GENESIS_AIRDROP.validators + GENESIS_AIRDROP.reserve;
  assert.equal(sum, GENESIS_AIRDROP.total);
  assert.equal(sum, 3_500_000_000);
});

test('the validator genesis pool divides into exactly 305,505 per seat', () => {
  // 305,505,000 over a set capped at 1,000 is a round per-seat number, which is
  // some evidence the figure was chosen that way rather than landing there.
  const v = deriveValidatorIncome();
  assert.equal(v.genesisStake, 305_505);
  assert.equal(v.setSize, 1000);
});

test('one validator earns about 843 $FLOP a day in the opening period', () => {
  const v = deriveValidatorIncome();
  assert.ok(v.perValidatorPerDay > 840 && v.perValidatorPerDay < 845);
  assert.equal(v.tenYearTotal, 1_200_000);
});

test('a smaller validator set pays each member proportionally more', () => {
  const thousand = deriveValidatorIncome({ setSize: 1000 });
  const fiveHundred = deriveValidatorIncome({ setSize: 500 });
  assert.ok(Math.abs(fiveHundred.perValidatorPerDay - thousand.perValidatorPerDay * 2) < 1e-6);
});

test('the stated cohort percentages are normalised to exactly 100%', () => {
  // They are, and the underlying $FLOP figures are not — the round numbers total
  // 17.3bn against a derived 17.19bn. Both facts are worth pinning, because a
  // future revision that silently fixes one of them should break this test.
  const statedPct = Object.values(COHORTS).reduce((sum, c) => sum + c.statedShare, 0);
  assert.ok(Math.abs(statedPct - 1) < 1e-9);

  const statedFlop = Object.values(COHORTS).reduce((sum, c) => sum + c.flop, 0);
  assert.equal(statedFlop, 17_300_000_000);
});
