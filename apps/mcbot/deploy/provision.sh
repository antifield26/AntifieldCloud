#!/usr/bin/env bash
# One-time Lofii bot provisioning on the Raspberry Pi.
# Usage: sudo bash deploy/provision.sh [--server-config] [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MC_SERVER_DIR="${MC_SERVER_DIR:-/home/antifield/minecraft-server}"
PROPS="$MC_SERVER_DIR/server.properties"
SERVER_CONFIG=0
FORCE=0
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

for arg in "$@"; do
  case "$arg" in
    --server-config) SERVER_CONFIG=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "provision.sh must run as root" >&2
  exit 1
fi

echo "== Lofii bot provisioning =="

if ! getent group lofiibot >/dev/null 2>&1; then
  addgroup --system lofiibot
fi
if ! id lofiibot >/dev/null 2>&1; then
  adduser --system --ingroup lofiibot --home /var/lib/lofii-bot --shell /usr/sbin/nologin --no-create-home lofiibot
fi

install -d -o root -g root -m 0755 /opt/lofii-bot /opt/lofii-bot/releases /etc/lofii-bot
install -d -o lofiibot -g lofiibot -m 0700 /var/lib/lofii-bot /var/lib/lofii-bot/memory

sudo -u lofiibot test -w /var/lib/lofii-bot

bash "$SCRIPT_DIR/bootstrap-env.sh"

install -m 0644 "$SCRIPT_DIR/lofii-bot.service" /etc/systemd/system/lofii-bot.service
systemctl daemon-reload
systemctl enable lofii-bot.service

if [ "$SERVER_CONFIG" -eq 1 ]; then
  echo "== Minecraft server configuration =="
  if [ ! -f "$PROPS" ]; then
    echo "missing $PROPS" >&2
    exit 1
  fi
  export MC_SERVER_PROPERTIES="$PROPS"
  "$NODE_BIN" "$REPO_DIR/scripts/rcon.mjs" "list" >/tmp/lofii-list.txt 2>&1 || true
  if grep -qE '§c0§6|There are 0 of a max|当前有[^0-9]*0' /tmp/lofii-list.txt; then
    echo "server is empty; safe to continue"
  elif [ "$FORCE" -eq 1 ]; then
    echo "warning: players may be online; --force supplied"
  else
    echo "players appear to be online; refusing to restart without --force" >&2
    cat /tmp/lofii-list.txt >&2
    exit 1
  fi

  TS="$(date +%Y%m%dT%H%M%S)"
  cp -a "$PROPS" "$PROPS.bak-lofii-$TS"
  cp -a "$MC_SERVER_DIR/whitelist.json" "$MC_SERVER_DIR/whitelist.json.bak-lofii-$TS" 2>/dev/null || true
  cp -a "$MC_SERVER_DIR/ops.json" "$MC_SERVER_DIR/ops.json.bak-lofii-$TS" 2>/dev/null || true

  CURRENT_MAX="$(sed -n 's/^max-players=//p' "$PROPS" | head -n 1)"
  if [ "$CURRENT_MAX" != "6" ]; then
    sed -i 's/^max-players=.*/max-players=6/' "$PROPS"
    chown antifield:antifield "$PROPS"
    echo "max-players: $CURRENT_MAX -> 6; restarting minecraft"
    systemctl restart minecraft.service
  else
    echo "max-players already 6"
  fi

  READY=0
  for _ in $(seq 1 60); do
    if "$NODE_BIN" "$REPO_DIR/scripts/rcon.mjs" "list" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 2
  done
  if [ "$READY" -ne 1 ]; then
    echo "minecraft RCON did not become ready" >&2
    systemctl status minecraft.service --no-pager -l | tail -n 40 >&2 || true
    exit 1
  fi

  "$NODE_BIN" "$REPO_DIR/scripts/rcon.mjs" "whitelist add lofii" "op lofii" "whitelist list" "list"
  echo "== server configuration done =="
fi

echo "== provision complete =="
echo "next: deploy a release and start lofii-bot.service"
echo "env: /etc/lofii-bot/env (root:lofiibot 0640)"
