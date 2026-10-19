#!/usr/bin/env bash
# Install the pinned Droidworks Herdr release asset for this host.
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"

die() { printf 'install-release: %s\n' "$*" >&2; exit 1; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=macos-arm64 expected=$HERDR_RELEASE_SHA256_MACOS_ARM64 ;;
  Linux-x86_64) platform=linux-x86_64 expected=$HERDR_RELEASE_SHA256_LINUX_X86_64 ;;
  *) die "no release asset for $(uname -s)-$(uname -m)" ;;
esac
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "manifest has no checksum for $platform"
command -v gh >/dev/null 2>&1 || die "gh is required"

work=$(mktemp -d "${TMPDIR:-/tmp}/herdr-release.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
asset="herdr-$platform"
gh release download "herdr@$HERDR_RELEASE" --repo "$HERDR_RELEASE_REPO" --pattern "$asset" --dir "$work"
[ "$(sha256_file "$work/$asset")" = "$expected" ] || die "release asset does not match the pinned checksum"
chmod 0755 "$work/$asset"
printf '%s  %s\n' "$expected" "$asset" > "$work/$asset.sha256"
"$TOOL_DIR/scripts/install-artifact.sh" --artifact "$work/$asset" "$@"
