# chain/

On-chain FLOP scripts for our agents, with their own dependencies so the main
checkout stays dependency-free. Install once next to the scripts:

    cd chain && npm install

Network selection lives in one place, `net.mjs`: a `network.json` beside the
scripts (`{"faucet": …, "rpc": …, "indexer": …, "gateway": …}`, or the file named
by `FLOP_NETWORK_FILE`), overridden by env `FLOP_FAUCET`, `FLOP_RPC`,
`FLOP_INDEXER_URL`, `FLOP_GATEWAY`, with devnet as the fallback. The faucet's
`/chain` names the RPC and genesis; a different RPC genesis stops before signing.
`"genesis"` in that file (or `FLOP_GENESIS`) pins the chain: a faucet serving another
chain is refused, and with `"rpc"` set the scripts read the chain before any faucet
exists (`faucet-claim.mjs` then stops: nothing to ask). `network.testnet.json` and
`network.devnet.json` carry both; `node use-network.mjs testnet [--dry]` checks the
RPC genesis and SDK admission, then copies one over `network.json` (old one kept as
`.bak`). The public testnet RPC answers 429 "Too many connections" at busy times;
`connect()` tries ten times over about two minutes. Agent keys are read from
`$FLOP_DATA_DIR/.secrets/<agent>-identity.json` (default `C:/TriAgent`) and never printed.

- `flop-lane.mjs`: the daemon's paid lane. Before each open it reads the model's
  per-G_n price and caps the turn's worst case (`turnGn`) to what fits `turnShare`
  (0.25) of one channel, refusing below `minTurnGn` (16384) or twice the largest
  G_n served (`lane-price.mjs`); `/lane/status` shows the price it used.
- `testnet-ready.mjs`: read-only launch-day picture (faucet tiers, genesis, runtime
  spec and whether the installed SDK admits it, our balances and registration,
  gateway models and enroll offer, session offers with a venue) ending in a TODO list.
- `faucet-claim.mjs --agent scout`: one anonymous faucet request for the agent's own
  address, logged to `data/local/flop-faucet.jsonl`. Never retries.
- `register-agent.mjs --agent scout [--yes]`: `agentIdentity.registerAgent` at the
  chain's minimum stake; dry run without `--yes`. One record per chain.
- `direct-session.mjs`: one paid session from the agent's own account to a named
  miner (`runDirectSession`, escrow capped at 0.1 FLOP). Use `--via force --lifetime 900`
  (the SDK's 120 s default ends in AttestationStale, network#166), and only miners whose
  operator accepts outside buyers.
- `technocore-faucet.mjs --agent scout [--check]`: the agent's one daily
  `!faucet request <ss58> <nonce>` in the room the faucet's `/chain` names, signed
  with the agent's did:key; refuses a second post the same UTC day, reads the bot's
  reply, logs `data/local/flop-technocore-faucet.jsonl`.
- `long-session.mjs`: many paid turns on one miner through SDK `LongSession` from a
  tasks file (tests and backfills). `--check` verifies miner and model and prints the
  bare-open escrow floor; buys nothing.
- `flop-lane.mjs`: the daemon's paid lane. One `LongSession` behind
  `http://127.0.0.1:<port>/lane` (config `lane.json`); the daemon uses it through
  `FLOP_SESSION_URL` and falls back to Ollama whenever it answers 503 (budget spent,
  frozen, not open). Budget per day = free balance minus `reserve`, optional `dayCap`.
  Several miners may be listed (`miners`, in preference order); one whose turn or open
  fails rests `minerCooldownMinutes` and the lane buys from the next. The lane closes
  each channel while `retireMarginSeconds` of its window remain, so the cooperative
  settle has time to finalize (`windowSeconds` must be at least twice that). The daemon
  sends it one request at a time (`FLOP_SESSION_CONCURRENCY=1` in `.env.local`).
- `pick-miners.mjs [--window 3600]`: read-only ranking of miners that publish signed session
  offers (their consent to outside buyers): settlement record, ghost probes, capacity rate and
  the bare-open escrow per window and per hour, enclave key from the offer, the model served,
  and the offer venue as endpoint when verified. Prints a `miners` block for lane.json. There
  is no public endpoint list: an endpoint must be one the operator publishes.
- `model-identity.mjs`: registry identity of a model from finalized state (the SDK
  does not export its resolver).

Spend economics (devnet, measured 2026-11-23): the money in a channel is the
reservation escrow, miner capacity rate x window blocks x `unconsentedReservationTariff`
(about 0.00099 FLOP per 1 s block on a 23,942 G_n/s miner), paid to the miner in full on
a cooperative close; turn tariffs are atoms. One live channel per payer. A bare open needs
the miner's enclave key pinned (`enclaveKey`, from the miner's own `forceAck` on chain).
Give turns time (`turnTimeout` 150 s, window 600 s or more): a 30 s turn timeout orphaned a
channel. `computeChannel.timeout` is a non-delivery dispute against the miner; do not file
it when the failure was ours.

Rules: no self-reported tasks (`reportTaskCompletion`), no pause/resume status
flips, no transfers between our own wallets, no extra wallets to multiply faucet
grants. Only settled compute spend counts.

## tclk deals in test FLOP (flop-htlc rail)

- `flop-rail.mjs`: local HTTP service on 127.0.0.1:8791 (FLOP-rail task on the mini PC)
  wrapping `@flop-labs/tclk-flop` (built from github flop-labs/tclk, not on npm), pinned to
  FLOP Testnet's genesis. `POST /rail/lock|verify|refund` sign with the Scribe key,
  `POST /rail/claim` with the Scout key, `GET /rail/status` reads. Every attempt is journaled
  in `data/local/flop-rail-journal.jsonl` before it is signed.
- `rail-policy.mjs`: what the service will sign. Native FLOP hash locks only, Scribe pays,
  the payee is never one of our own keys, one attempt per contract (an uncertain one counts),
  0.25 FLOP per deal, 1 FLOP per rolling 24 h, refund window within 3 h.
- The daemon's payer lane uses it when `TCLK_RAIL=flop-htlc` (and `tclk-payer` is in
  `KIBBLE_LANES`); `TCLK_FLOP_AMOUNT` in base units, default 0.1 FLOP.
- `readiness-watch.mjs`: every 10 minutes (FLOP-readiness task) records the official signals
  that would open the agent spend path; changes wait in `flop-readiness.json` until acked.
