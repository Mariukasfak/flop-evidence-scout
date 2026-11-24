/**
 * How large one turn may be at the chain's price, with no imports so the repo's tests
 * reach it without the chain's node_modules.
 *
 * SDK 0.10 prices a turn at BasePerTurn + pricePerGn x G_n and refuses every turn whose
 * worst case exceeds one channel's ceiling ("one worst-case turn ... exceeds
 * maxChannelPlanck"). Devnet had no per-G_n price (legacy 1 atom), so a fixed
 * turnGn of 1 000 000 cost nothing there. On a chain with a market price the same
 * number can pass the ceiling and the lane would refuse every request. The lane
 * therefore caps the configured turnGn so a worst-case turn fits `share` of one
 * channel, and refuses to open when that cap falls below a floor the real turns need
 * (a worst case below the actual G_n lets a turn's tariff pass the escrow, and the SDK
 * then leaves the channel for timeout).
 */

/** Largest G_n whose worst-case tariff fits `share` of one channel; null when the price is unknown. */
export function turnGnCap({ basePerTurn, pricePerGn, channel, share = 0.25 }) {
  if (pricePerGn === null || pricePerGn === undefined) return null;
  if (typeof pricePerGn !== 'bigint' || pricePerGn <= 0n) throw new Error('pricePerGn must be a positive bigint');
  if (!(share > 0 && share <= 1)) throw new Error('share must be in (0, 1]');
  const allowance = (channel * BigInt(Math.round(share * 1e6))) / 1_000_000n;
  if (allowance <= basePerTurn) return 0n;
  return (allowance - basePerTurn) / pricePerGn;
}

/**
 * The G_n ceiling the lane hands the SDK: min(configured, cap), refused below `floor`.
 * Returns { gn, ok, why }; `why` says what decided it, for the log and /lane/status.
 */
export function effectiveTurnGn({ configured, cap, floor }) {
  if (cap === null) return { gn: configured, ok: true, why: 'price unknown: configured turnGn' };
  const gn = cap < configured ? cap : configured;
  if (gn < floor) return { gn, ok: false, why: `price too high: one turn may meter at most ${cap} G_n within the channel share, below the floor ${floor}` };
  return { gn, ok: true, why: cap < configured ? `capped by price at ${cap} G_n` : 'configured turnGn fits the price' };
}

/** Floor a turn's worst case must not go under: the configured minimum or twice the largest G_n seen. */
export function turnGnFloor(minTurnGn, maxSeenGn) {
  const seen = 2n * maxSeenGn;
  return seen > minTurnGn ? seen : minTurnGn;
}
