/**
 * What the agent airdrop is worth under every assumption we cannot pin down.
 *
 * The teaser says an agent's allocation is "based largely on what they spend on
 * inference over the testnet". Write that out and almost everything cancels.
 *
 * If the faucet hands every agent the same amount F, and an agent spends a
 * fraction u of it, then that agent's share of the 1.2bn pool is
 *
 *     share = (F x u_ours) / (N x F x u_avg)  =  u_ours / (N x u_avg)  =  M / N
 *
 * where M is simply how many times the average agent's spend we manage. The
 * faucet size drops out. The absolute number of $FLOP spent drops out. Two
 * numbers survive: how many agents show up, and our multiple of the average.
 *
 * One of those is entirely outside our control. The other is the only thing
 * worth engineering, and it is bounded — an agent cannot spend more than the
 * faucet gives it, so under a fixed one-time faucet M is capped by how far below
 * full utilisation the average agent falls. Under a refilling faucet the cap
 * lifts and sustained throughput over ninety days becomes the whole game.
 *
 * That is the actionable finding in the entire document: uptime is the strategy.
 * An agent running unattended for 90 days beats an identical agent running for
 * 45 by exactly two times, and no amount of cleverness substitutes for it.
 */

import { GENESIS_AIRDROP, deriveAgentUnlock } from './tokenomics.mjs';

/**
 * Two regimes, because the teaser does not say which faucet it means.
 *
 * "claim a test-token faucet and spend it on inference" reads like a one-time
 * grant, but faucets on testnets usually drip. The difference decides whether
 * throughput matters at all, so both are modelled rather than one assumed.
 */
export const FAUCET_REGIMES = Object.freeze({
  fixed: {
    id: 'fixed',
    label: 'One-time grant',
    note: 'Every agent gets the same allowance once. Our multiple is capped by how much of it '
      + 'the average agent leaves unspent, so M above ~4-5x is not credible.',
    plausibleMaxMultiple: 5
  },
  drip: {
    id: 'drip',
    label: 'Refilling faucet',
    note: 'The allowance refills over the testnet. Nothing caps the multiple except sustained '
      + 'request throughput and uptime across roughly ninety days.',
    plausibleMaxMultiple: 50
  }
});

/**
 * Participant counts to model.
 *
 * Grounded in our own measurements rather than picked: 115,558 sharded DID notes
 * plus 40,960 legacy profiles were counted on 2026-08-26, growing at about 4,700
 * an hour. Registration is not participation — the same measurements show 69-78%
 * of room traffic is templated and a reply audit found zero genuine responders —
 * but claiming a faucet and spending it is a far lower bar than conversation, and
 * bot farms clear it trivially.
 */
export const PARTICIPANT_SCENARIOS = Object.freeze([
  { n: 1_000, label: 'Agents doing real work', basis: 'Our template analysis suggests genuine actors are a tiny minority' },
  { n: 5_000, label: 'Small serious cohort', basis: 'Roughly 3% of DIDs measured on 2026-08-26' },
  { n: 25_000, label: 'Moderate turnout', basis: 'About one registered DID in six participates' },
  { n: 130_000, label: 'Everyone registered today', basis: '115,558 sharded + 40,960 legacy, measured 2026-08-26' },
  { n: 500_000, label: 'Registration keeps growing', basis: 'Measured growth was ~4,700 DIDs/hour; testnet is months away' }
]);

/**
 * One cell of the grid.
 *
 * `multiple` is the only lever we control: our inference spend divided by the
 * average participant's. A multiple of 1 means we are indistinguishable from the
 * median bot.
 */
export function agentScenario({
  participants,
  multiple,
  cohort = GENESIS_AIRDROP.agents,
  unlockRatio = 3
} = {}) {
  if (!(participants > 0)) throw new Error('participants must be positive');
  if (!(multiple > 0)) throw new Error('multiple must be positive');

  // share = M / N, and no agent can take more than the whole pool.
  const share = Math.min(multiple / participants, 1);
  const gross = cohort * share;
  const unlock = deriveAgentUnlock(gross, unlockRatio);

  return {
    participants,
    multiple,
    share,
    gross,
    maxLiquid: unlock.maxLiquid,
    inferenceRequired: unlock.inferenceRequired
  };
}

/**
 * Not a valuation. The inverse question: what would one $FLOP have to be worth
 * for a holding to cover a given cost? Answering that needs no price forecast,
 * which is the whole point of asking it this way round.
 *
 * Kept as a plain function rather than a closure on the scenario, so a scenario
 * stays serialisable straight to JSON.
 */
export function breakEvenPrice(flopHeld, cost) {
  return flopHeld > 0 ? cost / flopHeld : Infinity;
}

/** The full grid: every participant scenario against every multiple. */
export function agentGrid({ multiples = [1, 2, 5, 10, 25], cohort = GENESIS_AIRDROP.agents } = {}) {
  return PARTICIPANT_SCENARIOS.map((scenario) => ({
    ...scenario,
    cells: multiples.map((multiple) => agentScenario({ participants: scenario.n, multiple, cohort }))
  }));
}

/**
 * The uptime argument, in the only units that matter.
 *
 * Under a refilling faucet, spend is throughput times time online. Two agents
 * with identical throughput and different uptime differ by exactly the ratio of
 * their uptimes — which makes continuous unattended operation worth more than any
 * optimisation available to us, and it is the one thing this repository already
 * does. Nothing here is a claim about what the network will reward; it is what
 * "spend the most" reduces to when the faucet refills.
 */
export function uptimeEffect({ testnetDays = 90, uptimes = [0.5, 0.9, 0.99, 1] } = {}) {
  const best = Math.max(...uptimes);
  return uptimes.map((uptime) => ({
    uptime,
    daysOnline: testnetDays * uptime,
    relativeSpend: uptime / best,
    /** How many days of the testnet are forfeited outright. */
    daysLost: testnetDays * (best - uptime)
  }));
}

/**
 * The prize component is deliberately absent.
 *
 * Section 04 says allocation is "based largely on what they spend on inference
 * over the testnet, along with various prizes". Nothing quantifies the prizes, so
 * modelling them would be inventing a number. This records the gap instead.
 */
export const UNMODELLED = Object.freeze([
  'The "various prizes" component of the agent allocation is unquantified in the teaser.',
  'Whether the faucet is a one-time grant or refills is not stated.',
  'Whether inference spend is counted in $FLOP, in FLOPs of compute, or in sessions is not stated.',
  'Whether the agent cohort is capped per-identity — one DID, one share — is not stated.',
  'The staking yield on locked airdrop $FLOP is not stated, so only the inference unlock route is modelled.'
]);
