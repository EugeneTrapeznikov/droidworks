#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
SOURCE_DIR=${HERDR_SOURCE_DIR:-"$TOOL_DIR/herdr"}
BUILD_DIR=${HERDR_BUILD_DIR:-"$TOOL_DIR/build"}
OUTPUT_DIR="$BUILD_DIR/macos-arm64"
CARGO_TARGET_DIR=${HERDR_MACOS_CARGO_TARGET_DIR:-"$BUILD_DIR/cargo-macos"}

die() { printf 'build-macos: %s\n' "$*" >&2; exit 1; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

[ "$(uname -s)" = Darwin ] || die "requires macOS"
[ "$(uname -m)" = arm64 ] || die "requires ARM64"
command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v rustc >/dev/null 2>&1 || die "rustc is required"
rust_version=$(rustc --version | awk '{print $2}')
[ "$rust_version" = "$HERDR_RUST_VERSION_MACOS" ] || die "requires rustc $HERDR_RUST_VERSION_MACOS, found $rust_version"
if [ -z "${ZIG:-}" ]; then
  command -v brew >/dev/null 2>&1 || die "set ZIG to Zig $HERDR_ZIG_VERSION"
  ZIG="$(brew --prefix zig@0.16)/bin/zig"
fi
[ -x "$ZIG" ] || die "Zig executable not found: $ZIG"
[ "$("$ZIG" version)" = "$HERDR_ZIG_VERSION" ] || die "requires Zig $HERDR_ZIG_VERSION"
export ZIG CARGO_TARGET_DIR

"$TOOL_DIR/scripts/prepare-source.sh"
mkdir -p "$OUTPUT_DIR"
(
  cd "$SOURCE_DIR"
  cargo build --release --locked
)
source_binary="$CARGO_TARGET_DIR/release/herdr"
[ -x "$source_binary" ] || die "build did not produce $source_binary"
staged="$OUTPUT_DIR/herdr.tmp.$$"
trap 'rm -f "$staged"' EXIT HUP INT TERM
install -m 0755 "$source_binary" "$staged"
mv -f "$staged" "$OUTPUT_DIR/herdr"
digest=$(sha256_file "$OUTPUT_DIR/herdr")
printf '%s  herdr\n' "$digest" > "$OUTPUT_DIR/herdr.sha256"
"$TOOL_DIR/scripts/verify-artifact.sh" "$OUTPUT_DIR/herdr" macos-arm64
printf 'built %s\n' "$OUTPUT_DIR/herdr"
