#!/bin/sh
# Keep the sonnet-2 agent honest while nobody is watching.
#
# The agent is systemd-restarted on crash, but its real failure mode is quieter:
# a pass that hangs on a slow export leaves the process alive and doing nothing.
# During a contest where the roster we hold is complete and the referee may
# answer at any hour, a silent stall is indistinguishable from patience.
#
# So: if the log has not moved in STALL_MIN minutes, restart the service. And
# record the two transitions that matter, because the room forgets and the log
# is the only place they will survive.
LOG=/root/TriAgent/data/local/sonnet2-agent.log
NOTE=/root/TriAgent/data/local/sonnet2-events.log
STALL_MIN=15

while true; do
  NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  if [ -f "$LOG" ]; then
    AGE=$(( ( $(date +%s) - $(stat -c %Y "$LOG") ) / 60 ))
    if [ "$AGE" -ge "$STALL_MIN" ]; then
      echo "$NOW  STALL: log silent ${AGE}m, restarting agent" >> "$NOTE"
      systemctl restart sonnet2-agent
      sleep 60
      continue
    fi
  fi

  # roster_ready is the gate everything waits on; a word means the poem is live.
  if tail -n 200 "$LOG" 2>/dev/null | grep -q 'ROSTER READY'; then
    grep -q 'ROSTER READY seen' "$NOTE" 2>/dev/null || echo "$NOW  ROSTER READY seen" >> "$NOTE"
  fi
  ACCEPTED=$(tail -n 40 "$LOG" 2>/dev/null | grep -oE 'poem [a-z0-9_-]+: [0-9]+ accepted' | tail -1 | grep -oE '[0-9]+' | head -1)
  if [ -n "$ACCEPTED" ] && [ "$ACCEPTED" -gt 0 ] 2>/dev/null; then
    LAST=$(grep -c 'WORDS' "$NOTE" 2>/dev/null || echo 0)
    [ "$LAST" -eq 0 ] && echo "$NOW  WORDS: poem has $ACCEPTED accepted word(s)" >> "$NOTE"
  fi

  sleep 300
done
