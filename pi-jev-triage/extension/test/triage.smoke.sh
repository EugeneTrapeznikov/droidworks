#!/usr/bin/env bash
# Integration smoke: run pi once in shadow mode over a big file read and assert the triage
# hook wrote a decision line. Uses the offline `mock` judge.
#
#   extension/test/triage.smoke.sh
#
# Costs one real model call. Everything else (judge, triage) is local.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext="$(dirname "$here")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

log="$work/decisions.jsonl"
big="$work/big.txt"
awk 'BEGIN { for (i = 1; i <= 400; i++) printf "line %d: %s\n", i, "filler text that makes this file worth triaging" }' >"$big"

PI_JEV_JUDGE=mock \
PI_JEV_SHADOW=1 \
PI_JEV_FEATURES=triage \
PI_JEV_LOG="$log" \
	pi -ne -e "$ext/src/index.ts" -p "read the whole file $big with the read tool, then tell me what its last line says" >"$work/pi.out" 2>&1 ||
	{ cat "$work/pi.out"; echo "smoke: pi exited non-zero"; exit 1; }

if ! grep -q '"feature":"triage"' "$log" 2>/dev/null; then
	cat "$work/pi.out"
	echo "smoke: no triage decision in $log"
	exit 1
fi

echo "smoke: ok"
grep '"feature":"triage"' "$log" | tail -1
