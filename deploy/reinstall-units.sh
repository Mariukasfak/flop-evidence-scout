#!/usr/bin/env bash
#
# Sync the systemd units from the checkout into /etc, and reload only if
# something actually changed.
#
#   reinstall-units.sh <user> <app-dir>
#
# This is a separate file rather than a line inside triagent-update.service on
# purpose. The units carry `__USER__` and `__APP_DIR__` placeholders that the
# installer rewrites, so a sed command written *inside* a unit would have its
# own placeholders rewritten too — `s|__USER__|__USER__|g` after installation
# is `s|root|root|g`, which silently leaves the placeholders in every unit it
# then copies. Passing the values as arguments removes the whole class.
#
set -euo pipefail

RUN_USER="${1:?usage: reinstall-units.sh <user> <app-dir>}"
APP_DIR="${2:?usage: reinstall-units.sh <user> <app-dir>}"

UNITS="triagent.service triagent-scan.service triagent-scan.timer triagent-update.service triagent-update.timer triagent-ollama-recycle.service triagent-ollama-recycle.timer"

changed=0
agent_changed=0
for u in $UNITS; do
  src="$APP_DIR/deploy/$u"
  [ -f "$src" ] || continue
  tmp="$(mktemp)"
  sed "s|__USER__|$RUN_USER|g; s|__APP_DIR__|$APP_DIR|g" "$src" > "$tmp"
  if ! cmp -s "$tmp" "/etc/systemd/system/$u"; then
    install -m 644 "$tmp" "/etc/systemd/system/$u"
    echo "updated $u"
    changed=1
    [ "$u" = "triagent.service" ] && agent_changed=1
  fi
  rm -f "$tmp"
done

if [ "$changed" = 0 ]; then
  echo "units unchanged"
  exit 0
fi

systemctl daemon-reload
echo "units reloaded"

# Restart the agent only when its own unit moved, and note that this is
# recorded as a flag during the loop rather than asked of systemd afterwards:
# `NeedDaemonReload` answers "no" once daemon-reload has run, so testing it
# here would never fire and the restart would silently never happen.
#
# Timers need no restart — each picks up its new definition when it next fires.
if [ "$agent_changed" = 1 ] && systemctl is-active --quiet triagent.service; then
  systemctl restart triagent.service
  echo "triagent restarted onto its new unit"
fi
