/**
 * Prints every airdrop scenario worth preparing for, and writes them for the site.
 *
 * Run: node tools/airdrop-model.mjs [--cost=75] [--set-size=1000]
 *
 * Every number is derived from the Flop Network Teaser v0.1 by src/tokenomics.mjs
 * and the two model modules beside it. Nothing is forecast. Where a value would
 * require a $FLOP price, the question is inverted into a break-even threshold.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SOURCE, TEASER, COHORTS, GENESIS_AIRDROP,
  reconcile, derivePerBlockSplit, emissionSchedule, deriveAgentUnlock
} from '../src/tokenomics.mjs';
import {
  PARTICIPANT_SCENARIOS, FAUCET_REGIMES, UNMODELLED,
  agentGrid, uptimeEffect
} from '../src/airdrop-model.mjs';
import {
  VALIDATOR_SPEC, HOSTING_TIERS, selfHostCost,
  validatorIncome, stakeSchedule, breakEven, testnetCase
} from '../src/validator-model.mjs';

const OUT = path.resolve('docs/airdrop-model.json');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; })
);
const monthlyEur = Number(args.cost ?? 75);
const setSize = Number(args['set-size'] ?? TEASER.validatorSetSize);

const MULTIPLES = [1, 2, 5, 10, 25];

const fmt = (n, dp = 0) => n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: dp });
const M = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmt(n));
const rule = (w = 78) => console.log('-'.repeat(w));

function head(title) {
  console.log(`\n${title}`);
  rule(title.length);
}

// ---------------------------------------------------------------- tokenomics
head('THE DOCUMENT, CHECKED');

const r = reconcile();
console.log(`Source: ${SOURCE.title} ${SOURCE.version} - ${SOURCE.url} (updated ${SOURCE.updated})`);
console.log(`${SOURCE.caveat}\n`);
console.log(`  Block reward stated            ${TEASER.baseBlockReward} $FLOP`);
console.log(`  Labs + Foundation, additive    ${TEASER.labsPerBlock + TEASER.foundationPerBlock} $FLOP`);
console.log(`  ACTUALLY ISSUED PER BLOCK      ${r.totalPerBlock} $FLOP  (${r.dilutionFactor.toFixed(3)}x the headline)`);
console.log();
console.log(`  Derived supply at year 10      ${(r.derivedSupply / 1e9).toFixed(3)}bn`);
console.log(`  Stated cohort table totals     ${(r.statedSupply / 1e9).toFixed(3)}bn`);
console.log(`  Gap                            ${M(r.supplyGap)} (${(r.supplyGapPct * 100).toFixed(2)}%) - rounding in the published table`);

head('WHO GETS EACH BLOCK (derived - the teaser never prints this)');
const { split } = derivePerBlockSplit();
for (const [name, s] of Object.entries(split)) {
  console.log(`  ${name.padEnd(16)} ${s.perBlock.toFixed(3).padStart(7)} $FLOP  ${(s.shareOfReward * 100).toFixed(1).padStart(5)}% of the block reward`);
}
console.log(`  ${'Labs'.padEnd(16)} ${TEASER.labsPerBlock.toFixed(3).padStart(7)} $FLOP   on top`);
console.log(`  ${'Foundation'.padEnd(16)} ${TEASER.foundationPerBlock.toFixed(3).padStart(7)} $FLOP   on top`);

head('EMISSION SCHEDULE');
console.log('  Period  Days         Reward  +Team   Issued in period');
for (const p of emissionSchedule()) {
  console.log(`    ${p.period}     ${String(p.startDay).padStart(4)}-${String(p.endDay).padEnd(5)} ${String(p.blockReward).padStart(6)}  ${String(p.teamPerBlock).padStart(5)}   ${(p.totalIssued / 1e9).toFixed(3)}bn`);
}

// --------------------------------------------------------------------- agent
head('THE AGENT AIRDROP: share = (our multiple of the average) / (participants)');

console.log(`Pool: ${(GENESIS_AIRDROP.agents / 1e9).toFixed(1)}bn $FLOP, "based largely on what they spend on inference".`);
console.log('Uniform faucet, so faucet size and absolute spend both cancel out. Two numbers survive.\n');

const header = `  ${'Participants'.padEnd(36)}` + MULTIPLES.map((m) => `${m}x`.padStart(10)).join('');
console.log(header);
console.log(`  ${'(gross $FLOP before the 3:1 lock)'.padEnd(36)}${'-'.repeat(MULTIPLES.length * 10)}`);
for (const row of agentGrid({ multiples: MULTIPLES })) {
  const label = `${fmt(row.n).padStart(9)}  ${row.label}`;
  console.log(`  ${label.padEnd(36)}` + row.cells.map((c) => M(c.gross).padStart(10)).join(''));
}

console.log('\n  Same grid, after the 3:1 unlock - what could ever become liquid:');
console.log(header);
for (const row of agentGrid({ multiples: MULTIPLES })) {
  const label = `${fmt(row.n).padStart(9)}  ${row.label}`;
  console.log(`  ${label.padEnd(36)}` + row.cells.map((c) => M(c.maxLiquid).padStart(10)).join(''));
}

head('THE 3:1 UNLOCK, READ CAREFULLY');
const u = deriveAgentUnlock(GENESIS_AIRDROP.agents);
console.log('  "arrives locked and spendable only on inference or staking - every 3 $FLOP spent');
console.log('   on inference unlocks 1 airdropped $FLOP"\n');
console.log('  The locked balance is the balance being spent, so each unlock consumes four');
console.log('  tokens: three spent on inference, one freed.\n');
console.log(`    Of any allocation:  ${(u.liquidShare * 100).toFixed(0)}% can become liquid`);
console.log(`                        ${((1 - u.liquidShare) * 100).toFixed(0)}% necessarily returns to miners and validators as compute`);
console.log('\n  This is the mechanism working, not a flaw. An agent that genuinely wants the');
console.log('  compute pays market rate and gets liquidity as a rebate. An agent that only');
console.log('  wanted tokens should read its allocation with a 0.25 multiplier.');

head('WHY UPTIME IS THE ENTIRE STRATEGY');
console.log('  Under a refilling faucet, spend = throughput x time online.\n');
console.log('    Uptime    Days online    Spend vs a perfect run    Days forfeited');
for (const e of uptimeEffect()) {
  console.log(`     ${(e.uptime * 100).toFixed(0).padStart(3)}%      ${e.daysOnline.toFixed(1).padStart(5)}          ${(e.relativeSpend * 100).toFixed(0).padStart(4)}%                 ${e.daysLost.toFixed(1).padStart(5)}`);
}
console.log('\n  No optimisation available to us beats simply not stopping.');

// ----------------------------------------------------------------- validator
head('VALIDATOR: WHAT IT COSTS');
console.log(`  Recommended spec (provisional): ${VALIDATOR_SPEC.cpuCores}+ core CPU, ${VALIDATOR_SPEC.ramGb} GB RAM, `
  + `${VALIDATOR_SPEC.storageTb} TB ${VALIDATOR_SPEC.storageType}, ${VALIDATOR_SPEC.networkGbps} Gbps ${VALIDATOR_SPEC.networkNote}`);
console.log(`  No GPU listed.\n  OPEN QUESTION: ${VALIDATOR_SPEC.openQuestion}\n`);
for (const tier of HOSTING_TIERS) {
  console.log(`  ${tier.label.padEnd(38)} EUR ${String(tier.monthlyEur).padStart(4)}/mo  (band ${tier.bandEur[0]}-${tier.bandEur[1]})`);
  console.log(`    ${tier.fits}`);
  console.log(`    ${tier.risk}\n`);
}
const self = selfHostCost();
console.log(`  Self-hosting at home: EUR ${self.electricityEur.toFixed(0)}/mo in electricity alone `
  + `(${self.watts} W, EUR ${self.pricePerKwh}/kWh, 24/7)`);
for (const d of self.disqualifiers) console.log(`    - ${d}`);

head('VALIDATOR: WHAT IT EARNS');
const income = validatorIncome({ setSize });
console.log(`  Assuming an even split across a set of ${fmt(setSize)}. ${income.assumption ?? ''}`);
console.log(`  ${income.feeNote}\n`);
console.log('    Period   Years     $FLOP/day    $FLOP/year');
for (const p of income.periods) {
  console.log(`      ${p.period}      ${p.years.padEnd(7)}  ${fmt(p.perDay).padStart(9)}   ${fmt(p.perYear).padStart(11)}`);
}
console.log(`\n    Ten-year block rewards   ${fmt(income.tenYearBlockRewards)} $FLOP`);
console.log(`    Genesis stake granted    ${fmt(income.genesisStake)} $FLOP`);

const stake = stakeSchedule({ setSize });
console.log(`\n  The stake is not income for a while:`);
console.log(`    bonded at launch, locked ${stake.lockedDays} days, then released over ${stake.releaseDays} days`);
console.log(`    first unlock day ${stake.firstUnlockDay}, fully liquid day ${stake.fullyLiquidDay} (~${(stake.fullyLiquidDay / 365).toFixed(1)} years)`);
console.log(`    slashable up to the entire amount, throughout`);

head(`VALIDATOR: BREAK-EVEN $FLOP PRICE AT EUR ${monthlyEur}/MONTH`);
console.log('  What one $FLOP must be worth for block rewards alone to cover hosting.');
console.log('  Rises over time: rewards halve every 730 days, the hosting bill does not.\n');
console.log('    Horizon    $FLOP earned      Cost        Break-even price');
for (const b of breakEven({ monthlyEur, setSize })) {
  console.log(`     ${String(b.year).padStart(2)} yr      ${fmt(b.earnedFlop).padStart(11)}    EUR ${fmt(b.costEur).padStart(6)}     EUR ${b.breakEvenPriceEur.toFixed(5)}`);
}

head('VALIDATOR: THE ACTUAL CASE FOR THE TESTNET');
const tc = testnetCase({ monthlyEur, setSize });
console.log(`  Testnet pays in test tokens, worth nothing. What ${tc.testnetDays} days buys is the option:\n`);
console.log(`    Hosting for the testnet           EUR ${tc.costEur.toFixed(0)}`);
console.log(`    Stake granted on selection        ${fmt(tc.stakeGranted)} $FLOP`);
console.log(`    A latecomer must buy that stake   ${fmt(tc.latecomerMustBuyFlop)} $FLOP at market`);
console.log(`    Ten-year block rewards on top     ${fmt(tc.tenYearBlockRewards)} $FLOP`);
console.log(`\n    Break-even $FLOP price on the stake alone   EUR ${tc.breakEvenPriceEur.toFixed(6)}`);
console.log('\n  That is the whole argument: during the testnet a seat costs hosting.');
console.log('  Afterwards it costs capital.\n');
console.log('  Against that:');
for (const c of tc.caveats) console.log(`    - ${c}`);

head('WHAT THIS MODEL DOES NOT KNOW');
for (const gap of UNMODELLED) console.log(`  - ${gap}`);
console.log(`  - Faucet regime assumptions: ${Object.values(FAUCET_REGIMES).map((f) => f.label).join(' / ')}`);

// ------------------------------------------------------------------ artefact
const report = {
  generatedAt: new Date().toISOString(),
  source: SOURCE,
  teaser: TEASER,
  cohorts: COHORTS,
  genesisAirdrop: GENESIS_AIRDROP,
  reconciliation: reconcile(),
  perBlockSplit: derivePerBlockSplit(),
  emissionSchedule: emissionSchedule(),
  agent: {
    pool: GENESIS_AIRDROP.agents,
    unlock: deriveAgentUnlock(GENESIS_AIRDROP.agents),
    multiples: MULTIPLES,
    participantScenarios: PARTICIPANT_SCENARIOS,
    grid: agentGrid({ multiples: MULTIPLES }),
    uptime: uptimeEffect(),
    faucetRegimes: FAUCET_REGIMES
  },
  validator: {
    spec: VALIDATOR_SPEC,
    hostingTiers: HOSTING_TIERS,
    selfHost: selfHostCost(),
    income: validatorIncome({ setSize }),
    stake: stakeSchedule({ setSize }),
    breakEven: breakEven({ monthlyEur, setSize }),
    testnetCase: tc,
    assumedMonthlyEur: monthlyEur
  },
  unmodelled: UNMODELLED,
  disclaimer: 'Derived from a draft document by division. Not affiliated with Flop Labs, not a '
    + 'valuation, not advice. Verify against flop.finance/teaser/ before acting on any of it.'
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(`\nWrote ${OUT}\n`);
