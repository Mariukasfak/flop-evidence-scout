# Hourly FLOP Testnet faucet claims for our two agents (mini PC task FLOP-faucet-claims).
# Scribe first: the flop-htlc rail needs its balance. Each run is a no-op for a wallet in its
# 24 h rest; an unfinished claim is re-sent with the same nonce, so nothing can pay twice.
# User consent 2026-11-23: one official faucet request per agent (Scout, Scribe) per day.
Set-Location C:/FlopChain
$env:FLOP_DATA_DIR = 'C:/TriAgent'
$log = 'C:/FlopChain/faucet-claims.log'
foreach ($a in @('scribe', 'scout')) {
  "=== $(Get-Date -Format o) $a" | Out-File -Append -Encoding utf8 $log
  node testnet-agent-claim.mjs --agent $a *>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log
}
