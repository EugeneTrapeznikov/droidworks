#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PI_AGENT_DIR="${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
EXTENSION="$PI_AGENT_DIR/extensions/tokenjuice.js"
PATCHER="$ROOT/scripts/apply-rtk-bypass.py"
LEGACY_LINK="$PI_AGENT_DIR/extensions/tokenjuice-rtk"

(cd "$ROOT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

if ! python3 "$PATCHER" --check "$EXTENSION" >/dev/null 2>&1; then
  PI_CODING_AGENT_DIR="$PI_AGENT_DIR" \
    node "$ROOT/node_modules/tokenjuice/dist/cli/main.js" install pi
  python3 "$PATCHER" "$EXTENSION"
fi
python3 "$PATCHER" --check "$EXTENSION"

if [ -L "$LEGACY_LINK" ] && [ "$(readlink "$LEGACY_LINK")" = "$ROOT" ]; then
  rm "$LEGACY_LINK"
elif [ -e "$LEGACY_LINK" ] || [ -L "$LEGACY_LINK" ]; then
  echo "✗ refusing to remove unmanaged legacy extension: $LEGACY_LINK" >&2
  exit 1
fi

printf '✓ TokenJuice 0.8.5 + RTK bypass installed: %s\n' "$EXTENSION"
