#!/usr/bin/env bash
#
# Restart ollama when its model server has grown past what this box can hold
# in RAM.
#
#   ollama-recycle.sh [threshold-mb]
#
# Measured on the 4 GB Hetzner box, 2026-09-04, qwen2.5:3b at -c 4096 -np 1:
#
#   fresh load          RSS 2147 MB, swap 0 MB
#   after 4.5 hours     RSS 3106 MB, swap 2049 MB   (~660 MB/h of growth)
#
# The model itself is 2.1 GB, so the second reading is roughly 3 GB of growth
# that does not belong to it. Long before it can OOM, it pushes the weights
# into swap, and a model that runs from disk drags the cycle past its own 60 s
# interval — the daemon's cycles were already measuring 62.6 s. So the
# threshold is set to keep llama-server in RAM, not merely to keep it alive:
# recycling costs one ~50 s warm-up, thrashing costs every cycle after it.
#
# Anything above ~3000 MB starts swapping once the daemon and the system take
# their share of 3819 MB, hence the default.
set -euo pipefail

THRESHOLD_MB="${1:-${OLLAMA_RECYCLE_THRESHOLD_MB:-2900}}"

pid="$(pgrep -f 'llama-server .*--model' | head -1 || true)"
if [ -z "$pid" ]; then
  echo "no model loaded — nothing to recycle"
  exit 0
fi

# RSS alone understates it: once the box starts swapping, the pages that left
# RAM stop being counted there, so a leaking process looks like it shrank.
# VmSwap adds them back.
rss_kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
swap_kb="$(awk '/^VmSwap:/ {print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
total_mb=$(( (rss_kb + swap_kb) / 1024 ))

if [ "$total_mb" -lt "$THRESHOLD_MB" ]; then
  echo "llama-server at ${total_mb} MB (rss $((rss_kb / 1024)), swap $((swap_kb / 1024))) — under ${THRESHOLD_MB} MB, leaving it alone"
  exit 0
fi

echo "llama-server at ${total_mb} MB (rss $((rss_kb / 1024)), swap $((swap_kb / 1024))) — over ${THRESHOLD_MB} MB, restarting ollama"
systemctl restart ollama
echo "ollama restarted; the next cycle pays the model's warm-up"
