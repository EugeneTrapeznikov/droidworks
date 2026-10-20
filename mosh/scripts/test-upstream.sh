#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
SOURCE_DIR=${MOSH_SOURCE_DIR:-"$TOOL_DIR/mosh"}
BUILD_DIR=${MOSH_BUILD_DIR:-"$TOOL_DIR/build"}
TEST_DIR="$BUILD_DIR/test-source"

die() { printf 'test-upstream: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "requires macOS"
for command_name in brew make pkg-config; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
for formula in protobuf abseil openssl@3; do
  brew --prefix "$formula" >/dev/null 2>&1 || die "Homebrew $formula is required"
done
"$TOOL_DIR/scripts/prepare-source.sh"
protobuf_prefix=$(brew --prefix protobuf)
openssl_prefix=$(brew --prefix openssl@3)
export PKG_CONFIG_PATH="$protobuf_prefix/lib/pkgconfig:$openssl_prefix/lib/pkgconfig"
export CPPFLAGS="-I$protobuf_prefix/include -I$openssl_prefix/include"
export LDFLAGS="-L$protobuf_prefix/lib -L$openssl_prefix/lib"
export CXXFLAGS="-O2 -std=c++17"
rm -rf "$TEST_DIR"
mkdir -p "$BUILD_DIR"
cp -a "$SOURCE_DIR" "$TEST_DIR"
(
  cd "$TEST_DIR"
  ./configure --prefix="$BUILD_DIR/test-install"
  make -j"$(sysctl -n hw.ncpu)"
  make check
)
