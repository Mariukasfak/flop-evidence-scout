#!/usr/bin/env bash
#
# Put the agent on a fresh Ubuntu 24.04 server and keep it running.
#
# Run it as a normal user with sudo rights:
#
#     bash setup-vps.sh
#
# It is safe to run twice — every step checks before it acts.
#
# What it does NOT do: copy the identity keys or the saved state. Those never
# go through git and never through a paste buffer. Bring them yourself with
# `perkelimas.zip`, made on the Windows PC by SUPAKUOTI-PERKELIMUI.bat, and
# leave it in your home directory before running this.
#
set -euo pipefail

REPO="https://github.com/Mariukasfak/flop-evidence-scout.git"
APP_DIR="${APP_DIR:-$HOME/TriAgent}"
BUNDLE="${BUNDLE:-$HOME/perkelimas.zip}"
MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
# `id -un` rather than $USER: sudo, cron and a bare `ssh root@host` all reach
# this script with $USER unset or set to somebody else, and an empty User= line
# is what turns a working unit into "Failed to determine user credentials".
RUN_USER="$(id -un)"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Present on the Hetzner Ubuntu image; absent from some minimal ones, and root
# does not need it. Defining it away is cleaner than sprinkling `if root` about.
if [ "$(id -u)" -eq 0 ] && ! command -v sudo >/dev/null; then
  sudo() { "$@"; }
fi

say "1/7  System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl unzip ca-certificates

say "2/7  Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v

say "3/7  Ollama + $MODEL"
# The official installer from ollama.com. Read it first if you like:
#   curl -fsSL https://ollama.com/install.sh | less
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
sudo systemctl enable --now ollama
# The model is ~2 GB and this is the slow step. Skipped if already pulled.
ollama list | grep -q "^${MODEL%%:*}" || ollama pull "$MODEL"

say "4/7  Code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

say "5/7  Identity and saved state"
if [ ! -f "$APP_DIR/.secrets/scout-identity.json" ]; then
  [ -f "$BUNDLE" ] || { echo "MISSING: $BUNDLE — make it with SUPAKUOTI-PERKELIMUI.bat on the PC"; exit 1; }
  unzip -o -q "$BUNDLE" -d "$APP_DIR"
  chmod 700 "$APP_DIR/.secrets"; chmod 600 "$APP_DIR/.secrets/"*.json
fi
[ -f "$APP_DIR/.secrets/scout-identity.json" ] || { echo "still no identity after unzip — check the bundle"; exit 1; }

# The one thing that must NOT be inherited from the PC.
#
# `data/local/lease-holder-id` is this machine's name in the one-writer lease.
# The PC wrote `local-<random>` into it. Copy that file here and both machines
# answer to the same name, so each one reads the other's lease as its own and
# both post — the exact double-writing the lease exists to prevent. Deleting it
# makes the daemon mint a fresh id under the LEASE_HOLDER label below.
rm -f "$APP_DIR/data/local/lease-holder-id"
grep -q '^LEASE_HOLDER=' "$APP_DIR/.env.local" 2>/dev/null || echo 'LEASE_HOLDER=vps' >> "$APP_DIR/.env.local"

say "6/7  Services"
sudo cp "$APP_DIR/deploy/triagent.service" /etc/systemd/system/
sudo cp "$APP_DIR/deploy/triagent-scan.service" /etc/systemd/system/
sudo cp "$APP_DIR/deploy/triagent-scan.timer" /etc/systemd/system/
sudo sed -i "s|__USER__|$RUN_USER|g; s|__APP_DIR__|$APP_DIR|g" \
  /etc/systemd/system/triagent.service \
  /etc/systemd/system/triagent-scan.service
sudo systemctl daemon-reload
sudo systemctl enable --now triagent.service triagent-scan.timer

say "7/7  Check"
sleep 5
systemctl --no-pager --lines=0 status triagent.service || true
cat <<EOF

Done. Useful commands from here on:

  journalctl -u triagent -f            watch it live
  sudo systemctl restart triagent      restart
  cd $APP_DIR && npm run brief         the same status page as on the PC

The PC may keep running its own copy. The lease lets exactly one of them speak,
and the other takes over within a couple of minutes when the first goes quiet.
EOF
