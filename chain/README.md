# chain/

On-chain FLOP scripts for our agents, with their own dependencies so the main
checkout stays dependency-free. Install once next to the scripts:

    cd chain && npm install

Network selection lives in one place, `net.mjs`: a `network.json` beside the
scripts (`{"faucet": …, "rpc": …, "indexer": …, "gateway": …}`, or the file named
by `FLOP_NETWORK_FILE`), overridden by env `FLOP_FAUCET`, `FLOP_RPC`,
`FLOP_INDEXER_URL`, `FLOP_GATEWAY`, with devnet as the fallback. The faucet's
`/chain` names the RPC and genesis; a different RPC genesis stops before signing.
Switching to testnet is writing that one file. Agent keys are read from
`$FLOP_DATA_DIR/.secrets/<agent>-identity.json` (default `C:/TriAgent`) and never printed.

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
