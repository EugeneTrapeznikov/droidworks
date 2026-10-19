#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
artifact=${1:-}
platform=${2:-}
[ -n "$artifact" ] && [ -n "$platform" ] || {
  printf 'usage: %s <artifact> <macos-arm64|linux-x86_64>\n' "$0" >&2
  exit 2
}

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
case "$platform" in
  macos-arm64)
    printf '%s\n' "$kind" | grep -q 'Mach-O 64-bit executable arm64' || die "wrong macOS artifact architecture: $kind"
    version=$("$artifact" --version | head -n1)
    ;;
  linux-x86_64)
    printf '%s\n' "$kind" | grep -Eq 'ELF 64-bit.*x86-64.*(static-pie linked|statically linked)' \
      || die "wrong Linux artifact architecture/linkage: $kind"
    command -v docker >/dev/null 2>&1 || die "docker is required to execute the Linux artifact"
    version=$(docker run --rm --platform linux/amd64 \
      --mount "type=bind,src=$artifact,dst=/artifact,readonly" \
      "$HERDR_LINUX_VERIFIER" /artifact --version | head -n1)
    ;;
  *) die "unknown platform: $platform" ;;
esac
[ "$version" = "herdr $HERDR_VERSION" ] || die "unexpected version: $version"
printf 'verified %s (%s, %s)\n' "$artifact" "$platform" "$expected"
