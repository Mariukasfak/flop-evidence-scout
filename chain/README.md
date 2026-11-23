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

Rules: no self-reported tasks (`reportTaskCompletion`), no pause/resume status
flips, no transfers between our own wallets, no extra wallets to multiply faucet
grants. Only settled compute spend counts.
