#!/usr/bin/env bash
# tclk payee lane, per UTC day, from the daemon's own journal. Read-only.
#   bash tools/tclk-daily.sh [days]
days=${1:-3}
for d in $(seq "$days" -1 0); do
  s=$(date -u -d "$d days ago" +%F)
  j=$(journalctl -u triagent --since "$s" --until "$s 23:59:59" --no-pager 2>/dev/null)
  printf '%s  priimta %4d  baigta %3d  pralaimeta %4d\n' "$s" \
    "$(grep -c 'offer_accepted' <<<"$j")" \
    "$(grep -c 'deal_claimed' <<<"$j")" \
    "$(grep -c 'another payee' <<<"$j")"
done
