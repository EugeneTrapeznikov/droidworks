#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
locked=$(awk -F= '$1 == "tag" { print $2 }' "$root/upstream.lock")
ci=0
[[ ${1:-} != --ci ]] || ci=1

if command -v gh >/dev/null 2>&1; then
  latest=$(gh api repos/manaflow-ai/cmux/releases/latest --jq .tag_name)
else
  latest=$(curl -fsSL https://api.github.com/repos/manaflow-ai/cmux/releases/latest \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
fi

if [[ $latest == "$locked" ]]; then
  printf 'cmux %s is current\n' "$locked"
  exit 0
fi

printf 'New stable cmux release: %s (locked: %s)\n' "$latest" "$locked"
printf 'https://github.com/manaflow-ai/cmux/releases/tag/%s\n' "$latest"
[[ $ci == 0 ]] || exit 1
