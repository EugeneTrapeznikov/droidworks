#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
SOURCE_DIR=${HERDR_SOURCE_DIR:-"$TOOL_DIR/herdr"}

die() { printf 'prepare-source: %s\n' "$*" >&2; exit 1; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
verify_patched_blobs() {
  local entry
  for entry in $HERDR_PATCHED_BLOBS; do
    [ "$(git -C "$SOURCE_DIR" hash-object "${entry%%=*}")" = "${entry#*=}" ] || return 1
  done
}

patches=()
for entry in $HERDR_PATCHES; do
  patch="$TOOL_DIR/patches/${entry%%=*}"
  [ "$(sha256_file "$patch")" = "${entry#*=}" ] || die "tracked patch checksum mismatch: ${entry%%=*}"
  patches+=("$patch")
done
expected_status=$(for entry in $HERDR_PATCHED_BLOBS; do printf ' M %s\n' "${entry%%=*}"; done | sort)

if [ -e "$SOURCE_DIR" ] && [ ! -d "$SOURCE_DIR/.git" ]; then
  die "refusing non-Git source path: $SOURCE_DIR"
fi
fresh_clone=0
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone --no-checkout "$HERDR_UPSTREAM_URL" "$SOURCE_DIR"
  fresh_clone=1
fi

origin=$(git -C "$SOURCE_DIR" remote get-url origin)
[ "$origin" = "$HERDR_UPSTREAM_URL" ] || die "foreign origin: $origin"

git -C "$SOURCE_DIR" fetch --force --tags origin "$HERDR_BASE_COMMIT"
[ "$(git -C "$SOURCE_DIR" rev-parse "$HERDR_TAG^{commit}")" = "$HERDR_BASE_COMMIT" ] \
  || die "$HERDR_TAG does not resolve to pinned commit"

if [ "$fresh_clone" -eq 1 ]; then
  git -C "$SOURCE_DIR" checkout --detach "$HERDR_BASE_COMMIT"
fi

status=$(git -C "$SOURCE_DIR" status --porcelain=v1 --untracked-files=all | sort)
if [ -n "$status" ] && { [ "$status" != "$expected_status" ] || ! verify_patched_blobs; }; then
  die "source tree has foreign changes; clean it explicitly before retrying"
fi

git -C "$SOURCE_DIR" checkout --detach --force "$HERDR_BASE_COMMIT"
for patch in "${patches[@]}"; do
  git -C "$SOURCE_DIR" apply --check "$patch"
  git -C "$SOURCE_DIR" apply "$patch"
done
verify_patched_blobs || die "applied source blobs do not match pinned patched blobs"
git -C "$SOURCE_DIR" diff --check
printf 'prepared Herdr %s + %d downstream patches at %s\n' "$HERDR_VERSION" "${#patches[@]}" "$SOURCE_DIR"
