# chain/

On-chain FLOP scripts for our agents, with their own dependencies so the main
checkout stays dependency-free. Install once next to the scripts:

    cd chain && npm install

Network selection is env only: `FLOP_RPC` (default `wss://rpc.devnet.flop.network`),
`FLOP_FAUCET` (default `https://faucet.flop.network`; its `/chain` genesis must
match the RPC) and `FLOP_INDEXER_URL` for session offers. Agent keys are read from
`$FLOP_DATA_DIR/.secrets/<agent>-identity.json` (default `C:/TriAgent`) and never printed.

- `direct-session.mjs` — one paid session from the agent's own account to a named
  miner (`runDirectSession`, escrow capped at 0.1 FLOP). Only for miners whose
  operator accepts outside buyers.

Rules: no self-reported tasks (`reportTaskCompletion`), no pause/resume status
flips, no transfers between our own wallets. Only settled compute spend counts.
