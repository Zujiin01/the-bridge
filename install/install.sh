#!/usr/bin/env bash
# Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
# Creates the bridge folder and, for an agent woken by a webhook, its bridge-wake config (chmod 600).
# Run it as the Unix user your agents use (with the Door, the door's user), NOT as root:
#   bash install/install.sh <bridge-folder> <agent,agent...> [webhook-agent]
# Example: bash install/install.sh /srv/bridge claude,grokbot grokbot
set -euo pipefail
[ "$(id -u)" != 0 ] || { echo "Run this script as the agents' user, not as root."; exit 1; }
[ $# -ge 2 ] || { echo "usage: bash install/install.sh <bridge-folder> <agent,agent...> [webhook-agent]"; exit 2; }
command -v node >/dev/null || { echo "Node.js 20 or newer is required."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node.js 20 or newer is required."; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$1"; AGENTS="$2"; WAKE_AGENT="${3:-}"
umask 077
node "$REPO/bin/bridge-init" --root "$ROOT" --agents "$AGENTS"

if [ -n "$WAKE_AGENT" ]; then
  CONF_DIR="${BRIDGE_CONFIG_DIR:-$HOME/.config/bridge}"
  CONF="$CONF_DIR/$WAKE_AGENT.wake.json"
  mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
  if [ -f "$CONF" ]; then
    echo "kept the existing $CONF"
  else
    node -e '
      const fs = require("node:fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      c.agent = process.argv[2]; c.root = process.argv[3];
      fs.writeFileSync(process.argv[4], JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    ' "$REPO/config.example.json" "$WAKE_AGENT" "$ROOT" "$CONF"
    echo "created $CONF (chmod 600): put the webhook URL and header of $WAKE_AGENT in it"
  fi
  chmod 600 "$CONF"
  echo "then start it: BRIDGE_WAKE_CONFIG=$CONF node $REPO/bin/bridge-wake.js"
  echo "  (for good: deploy/bridge-wake.service.example with systemd, or deploy/pm2.example.sh)"
fi
echo "next: paste AGENT-INSTRUCTIONS.md in each agent's project (BRIDGE=$ROOT, TOOLS=$REPO)"
