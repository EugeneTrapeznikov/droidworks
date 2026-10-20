#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
artifact=${1:-}
[ -n "$artifact" ] || { printf 'usage: %s <artifact>\n' "$0" >&2; exit 2; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
die() { printf 'verify-artifact: %s\n' "$*" >&2; exit 1; }

[ -f "$artifact" ] && [ -x "$artifact" ] || die "not an executable file: $artifact"
artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
sidecar="$artifact.sha256"
[ -f "$sidecar" ] || die "missing checksum: $sidecar"
expected=$(awk 'NR == 1 { print $1 }' "$sidecar")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "invalid checksum"
[ "$(sha256_file "$artifact")" = "$expected" ] || die "checksum mismatch"
kind=$(file "$artifact")
printf '%s\n' "$kind" | grep -q 'Mach-O 64-bit executable arm64' || die "wrong macOS artifact architecture: $kind"
version=$("$artifact" --version | head -n1)
[ "$version" = "mosh-client (mosh $MOSH_VERSION) [build mosh $MOSH_VERSION]" ] || die "unexpected version: $version"
printf 'verified %s (macos-arm64, %s)\n' "$artifact" "$expected"
