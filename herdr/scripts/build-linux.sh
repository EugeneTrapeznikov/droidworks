#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
BUILD_DIR=${HERDR_BUILD_DIR:-"$TOOL_DIR/build"}
OUTPUT_DIR="$BUILD_DIR/linux-x86_64"

die() { printf 'build-linux: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker is required"

"$TOOL_DIR/scripts/prepare-source.sh"
mkdir -p "$OUTPUT_DIR"
host_uid=$(id -u)
host_gid=$(id -g)

docker run --rm --platform linux/amd64 \
  --mount "type=bind,src=$TOOL_DIR,dst=/workspace" \
  --workdir /workspace/herdr \
  --env "HOST_UID=$host_uid" \
  --env "HOST_GID=$host_gid" \
  --env "ZIG_URL=$HERDR_ZIG_LINUX_URL" \
  --env "ZIG_SHA256=$HERDR_ZIG_LINUX_SHA256" \
  --env "ZIG_VERSION_EXPECTED=$HERDR_ZIG_VERSION" \
  --env "RUST_VERSION_EXPECTED=$HERDR_RUST_VERSION_LINUX" \
  --env "HERDR_VERSION_EXPECTED=$HERDR_VERSION" \
  "$HERDR_LINUX_BUILDER" \
  bash -ceu '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl musl-tools xz-utils >/dev/null
    rustup target add x86_64-unknown-linux-musl
    rm -rf /opt/zig /tmp/zig.tar.xz /tmp/zig-extract
    mkdir -p /opt/zig /tmp/zig-extract /workspace/build/cargo-home /workspace/build/cargo-linux /workspace/build/linux-x86_64
    curl --fail --location --proto "=https" --tlsv1.2 --retry 3 "$ZIG_URL" -o /tmp/zig.tar.xz
    printf "%s  %s\n" "$ZIG_SHA256" /tmp/zig.tar.xz | sha256sum --check --status
    tar -xJf /tmp/zig.tar.xz -C /tmp/zig-extract --strip-components=1
    cp -a /tmp/zig-extract/. /opt/zig/
    export ZIG=/opt/zig/zig
    export CARGO_HOME=/workspace/build/cargo-home
    export CARGO_TARGET_DIR=/workspace/build/cargo-linux
    "$ZIG" version | grep -Fx "$ZIG_VERSION_EXPECTED"
    case "$(rustc --version)" in
      "rustc $RUST_VERSION_EXPECTED "*) ;;
      *) printf "unexpected rustc: %s\\n" "$(rustc --version)" >&2; exit 1 ;;
    esac
    cargo build --release --locked --target x86_64-unknown-linux-musl
    artifact="$CARGO_TARGET_DIR/x86_64-unknown-linux-musl/release/herdr"
    test -x "$artifact"
    "$artifact" --version | grep -Fx "herdr $HERDR_VERSION_EXPECTED"
    install -m 0755 "$artifact" /workspace/build/linux-x86_64/herdr.tmp
    mv -f /workspace/build/linux-x86_64/herdr.tmp /workspace/build/linux-x86_64/herdr
    sha256sum /workspace/build/linux-x86_64/herdr | sed "s#  .*#  herdr#" > /workspace/build/linux-x86_64/herdr.sha256
    chown -R "$HOST_UID:$HOST_GID" /workspace/build
    for path in vendor/libghostty-vt/.zig-cache vendor/libghostty-vt/zig-out; do
      if test -e "$path"; then chown -R "$HOST_UID:$HOST_GID" "$path"; fi
    done
  '

"$TOOL_DIR/scripts/verify-artifact.sh" "$OUTPUT_DIR/herdr" linux-x86_64
printf 'built %s\n' "$OUTPUT_DIR/herdr"
