#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
SOURCE_DIR=${MOSH_SOURCE_DIR:-"$TOOL_DIR/mosh"}
BUILD_DIR=${MOSH_BUILD_DIR:-"$TOOL_DIR/build"}
OUTPUT_DIR="$BUILD_DIR/macos-arm64"
WORK_DIR="$BUILD_DIR/work-macos"

die() { printf 'build-macos: %s\n' "$*" >&2; exit 1; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

[ "$(uname -s)" = Darwin ] || die "requires macOS"
[ "$(uname -m)" = arm64 ] || die "requires ARM64"
for command_name in brew clang++ make pkg-config; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
for formula in protobuf abseil openssl@3; do
  brew --prefix "$formula" >/dev/null 2>&1 || die "Homebrew $formula is required"
done
protobuf_prefix=$(brew --prefix protobuf)
openssl_prefix=$(brew --prefix openssl@3)
export PKG_CONFIG_PATH="$protobuf_prefix/lib/pkgconfig:$openssl_prefix/lib/pkgconfig"
export CPPFLAGS="-I$protobuf_prefix/include -I$openssl_prefix/include"
export LDFLAGS="-L$protobuf_prefix/lib -L$openssl_prefix/lib"
export CXXFLAGS="-O2 -std=c++17"

"$TOOL_DIR/scripts/prepare-source.sh"
rm -rf "$WORK_DIR"
mkdir -p "$OUTPUT_DIR" "$WORK_DIR"
(
  cd "$WORK_DIR"
  "$SOURCE_DIR/configure" --prefix="$BUILD_DIR/install"
  make -j"$(sysctl -n hw.ncpu)"
)

harness="$BUILD_DIR/display-kitty"
clang++ -std=c++17 \
  -I"$WORK_DIR/src/include" -I"$SOURCE_DIR/src/include" -I"$SOURCE_DIR/src/statesync" -I"$SOURCE_DIR/src/terminal" \
  -I"$SOURCE_DIR/src/network" -I"$SOURCE_DIR/src/crypto" -I"$SOURCE_DIR/src/protobufs" \
  -I"$SOURCE_DIR/src/util" \
  $CPPFLAGS \
  "$TOOL_DIR/tests/display-kitty.cc" \
  "$WORK_DIR/src/crypto/libmoshcrypto.a" \
  "$WORK_DIR/src/network/libmoshnetwork.a" \
  "$WORK_DIR/src/statesync/libmoshstatesync.a" \
  "$WORK_DIR/src/terminal/libmoshterminal.a" \
  "$WORK_DIR/src/util/libmoshutil.a" \
  "$WORK_DIR/src/protobufs/libmoshprotos.a" \
  $LDFLAGS -lprotobuf -lssl -lcrypto -lncurses -lz -lm \
  -o "$harness"
TERM=xterm-256color "$harness"

source_binary="$WORK_DIR/src/frontend/mosh-client"
[ -x "$source_binary" ] || die "build did not produce $source_binary"
staged="$OUTPUT_DIR/mosh-client.tmp.$$"
trap 'rm -f "$staged"' EXIT HUP INT TERM
install -m 0755 "$source_binary" "$staged"
mv -f "$staged" "$OUTPUT_DIR/mosh-client"
digest=$(sha256_file "$OUTPUT_DIR/mosh-client")
printf '%s  mosh-client\n' "$digest" > "$OUTPUT_DIR/mosh-client.sha256"
{
  printf 'clang=%s\n' "$(clang++ --version | head -n1)"
  printf 'cxxflags=%s\n' "$CXXFLAGS"
  printf 'protobuf=%s\n' "$(pkg-config --modversion protobuf)"
  printf 'openssl=%s\n' "$(pkg-config --modversion openssl)"
  printf 'ncurses=macOS SDK system library\n'
  brew list --versions protobuf abseil openssl@3 | sed 's/^/homebrew=/'
  for formula in protobuf abseil openssl@3; do
    formula_prefix=$(brew --prefix "$formula")
    printf 'homebrew-prefix-%s=%s\n' "$formula" "$(cd "$formula_prefix" && pwd -P)"
  done
  otool -L "$OUTPUT_DIR/mosh-client" | tail -n +2 | sed 's/^[[:space:]]*/dylib=/'
} > "$OUTPUT_DIR/dependencies.txt"
if otool -L "$OUTPUT_DIR/mosh-client" | grep -Eq '/(opt/homebrew|usr/local)/.*ncurses'; then
  die "artifact unexpectedly links non-system ncurses"
fi
"$TOOL_DIR/scripts/verify-artifact.sh" "$OUTPUT_DIR/mosh-client"
printf 'built %s\n' "$OUTPUT_DIR/mosh-client"
