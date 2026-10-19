#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
SOURCE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/herdr-source.XXXXXX")
trap 'rm -rf "$SOURCE_DIR"' EXIT HUP INT TERM
rmdir "$SOURCE_DIR"

output=$(HERDR_SOURCE_DIR="$SOURCE_DIR" "$TOOL_DIR/scripts/prepare-source.sh")

[[ "$output" == "prepared Herdr $HERDR_VERSION + 2 downstream patches at $SOURCE_DIR" ]]
[[ $(git -C "$SOURCE_DIR" rev-parse HEAD) == "$HERDR_BASE_COMMIT" ]]
[[ $(git -C "$SOURCE_DIR" describe --tags --exact-match HEAD) == "$HERDR_TAG" ]]
expected_status=$(for entry in $HERDR_PATCHED_BLOBS; do printf ' M %s\n' "${entry%%=*}"; done | sort)
[[ $(git -C "$SOURCE_DIR" status --porcelain=v1 --untracked-files=all | sort) == "$expected_status" ]]
git -C "$SOURCE_DIR" diff --check
grep -Fq 'None => return b"\x07".to_vec(),' "$SOURCE_DIR/src/terminal_notify.rs"

# A prepared tree is accepted again.
HERDR_SOURCE_DIR="$SOURCE_DIR" "$TOOL_DIR/scripts/prepare-source.sh" >/dev/null

printf '\ndirty-source sentinel\n' >> "$SOURCE_DIR/README.md"
dirty_hash=$(git -C "$SOURCE_DIR" hash-object README.md)
set +e
dirty_output=$(HERDR_SOURCE_DIR="$SOURCE_DIR" "$TOOL_DIR/scripts/prepare-source.sh" 2>&1)
dirty_status=$?
set -e
[[ "$dirty_status" -ne 0 ]]
[[ "$dirty_output" == *"prepare-source: source tree has foreign changes; clean it explicitly before retrying"* ]]
[[ $(git -C "$SOURCE_DIR" hash-object README.md) == "$dirty_hash" ]]

echo "test-prepare-source: PASS"
