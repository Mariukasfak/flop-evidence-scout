/**
 * Rent a GPU and mine, or rent a server and validate?
 *
 * Prints the comparison and the assumption behind every number, because the
 * conclusion is entirely driven by one quantity nobody has published: how many
 * miners show up.
 *
 * Run: node tools/hardware-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { TEASER, GENESIS_AIRDROP, derivePerBlockSplit } from '../src/tokenomics.mjs';
import {
  GPU_TIERS, MINER_SPEC, monthlyRentEur, validatorCase, minerCase,
  breakEvenPrice, fieldSensitivity, UNMODELLED, BLOCKS_PER_YEAR
} from '../src/miner-model.mjs';
import { HOSTING_TIERS, VALIDATOR_SPEC } from '../src/validator-model.mjs';

const eur = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));
const flop = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}bn`
  : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : n.toFixed(0));
const price = (n) => (n >= 1 ? `EUR ${n.toFixed(2)}` : `EUR ${n.toFixed(4)}`);

console.log('\nWHAT EACH ROLE COSTS TO RENT, PER MONTH');
console.log('---------------------------------------');
const server = HOSTING_TIERS.find((h) => h.id === 'standard-dedicated');
console.log(`  validator   ${VALIDATOR_SPEC.cpuCores}+ cores, ${VALIDATOR_SPEC.ramGb} GB RAM, ${VALIDATOR_SPEC.storageTb} TB NVMe, no GPU`);
console.log(`              ${server.label}: EUR ${server.monthlyEur}/mo (band ${server.bandEur[0]}-${server.bandEur[1]})`);
console.log(`  miner       GPU, ${MINER_SPEC.vramGb} GB+ VRAM per unit`);
for (const tier of GPU_TIERS) {
  const m = monthlyRentEur(tier.hourlyUsd);
  console.log(`              ${tier.label.padEnd(42)} EUR ${eur(m).padStart(5)}/mo  ($${tier.hourlyUsd}/h)`);
}
console.log(`\n  A miner's floor is ${(monthlyRentEur(GPU_TIERS[1].hourlyUsd) / server.monthlyEur).toFixed(1)}x a validator's, for the same uptime.`);

console.log('\n\nWHAT THE BLOCK PAYS EACH ROLE');
console.log('-----------------------------');
const { split } = derivePerBlockSplit();
for (const role of ['miners', 'validators']) {
  const s = split[role];
  console.log(`  ${role.padEnd(12)} ${s.perBlock.toFixed(3)} $FLOP/block   ${(s.shareOfReward * 100).toFixed(1)}% of the block reward`);
}
console.log(`  Mining's pool is ${(split.miners.perBlock / split.validators.perBlock).toFixed(1)}x larger. That is the entire case for mining,`);
console.log('  and it is shared among a field nothing caps.');

console.log('\n\nYEAR-1 BLOCK REWARDS AND THE PRICE THAT COVERS THE RENT');
console.log('------------------------------------------------------');
console.log('  A validator seat is exactly 1/1000 of its pool. A miner unit is one of however');
console.log('  many turn up. Break-even is what one $FLOP must be worth to pay the rent.\n');
console.log(`  ${'miner field'.padEnd(14)} ${'miner $FLOP/yr'.padStart(15)} ${'miner b/e'.padStart(14)} ${'validator b/e'.padStart(14)}   mining must be worth`);
console.log(`  ${'-'.repeat(14)} ${'-'.repeat(15)} ${'-'.repeat(14)} ${'-'.repeat(14)}   ${'-'.repeat(20)}`);

const rows = fieldSensitivity({});
for (const r of rows) {
  console.log(
    `  ${r.competingUnits.toLocaleString('en-US').padEnd(14)}`
    + ` ${flop(r.minerFlopPerYear).padStart(15)}`
    + ` ${price(r.minerBreakEven).padStart(14)}`
    + ` ${price(r.validatorBreakEven).padStart(14)}`
    + `   ${r.minerPenalty.toFixed(1)}x dearer`
  );
}

const crossover = rows.find((r) => r.minerBreakEven <= r.validatorBreakEven);
console.log(
  crossover
    ? `\n  Mining wins below about ${crossover.competingUnits.toLocaleString('en-US')} competing units.`
    : `\n  Mining does not beat validating at any field size in this table. It would need`
      + `\n  fewer than ${rows[0].competingUnits.toLocaleString('en-US')} competing units worldwide to draw level on rent alone.`
);

console.log('\n\nTHE AIRDROP, WHICH IS THE PART PEOPLE ACTUALLY WANT');
console.log('--------------------------------------------------');
const v = validatorCase({});
console.log(`  validator   ${flop(v.airdropFlop)} $FLOP per seat, at ${v.seats} seats`);
console.log('              But it IS the stake: bonded as slashing collateral, locked through the');
console.log('              first halving (730 days), then released over 1,000 days. Not spendable');
console.log('              on arrival, and at risk the whole time it is bonded.');
console.log(`  miner       up to ${flop(GENESIS_AIRDROP.miners)} $FLOP across an unbounded field.`);
console.log('              Per-participant value cannot be stated, because nothing caps the field.');
console.log(`  agent       up to ${flop(GENESIS_AIRDROP.agents)} $FLOP, and we measured the field at 533,468 DIDs`);
console.log('              on 2026-08-28, up from 279,773 a day earlier.');

console.log('\n\nTHE HONEST SUMMARY');
console.log('------------------');
console.log('  Validating is the lower-variance bet and the cheaper one. Its reward per seat is');
console.log('  arithmetic, not a guess, and its rent is a fifth of a miner\'s. Its risk is');
console.log('  concentrated in one place: whether a seat can be won and held, since roughly every');
console.log('  month the worst 50 of 1,000 are replaced.');
console.log('');
console.log('  Mining is the higher-ceiling bet and the one that cannot be sized today. It pays');
console.log('  7.3x more per block into a field with no limit, at 5x the rent, with no published');
console.log('  rule converting hardware into reward share.');
console.log('');
console.log('  Neither is a reason to rent anything yet: there is no testnet, no faucet, no miner');
console.log('  or validator software, and no wallet format. Renting today buys idle hardware.');

console.log('\n\nWHAT THIS MODEL DOES NOT CAPTURE');
console.log('--------------------------------');
for (const item of UNMODELLED) console.log(`  - ${item}`);

console.log(`\n  Source: ${TEASER.version ?? 'Teaser v0.1 (draft)'} — figures marked provisional by Flop Labs.`);
console.log('  Rental prices are market observations from 2026-08 and move.\n');

const out = path.resolve('docs/hardware-model.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  blocksPerYear: BLOCKS_PER_YEAR,
  perBlock: split,
  gpuTiers: GPU_TIERS,
  serverTiers: HOSTING_TIERS,
  validator: validatorCase({}),
  minerAt10k: minerCase({}),
  breakEvenAt10k: breakEvenPrice({}),
  fieldSensitivity: rows,
  unmodelled: UNMODELLED
}, null, 2), 'utf8');
console.log(`Wrote ${out}\n`);
