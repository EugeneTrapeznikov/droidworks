#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../manifest.env
. "$TOOL_DIR/manifest.env"
SOURCE_DIR=${MOSH_SOURCE_DIR:-"$TOOL_DIR/mosh"}
BUILD_DIR=${MOSH_BUILD_DIR:-"$TOOL_DIR/build"}
ARCHIVE="$BUILD_DIR/downloads/mosh-$MOSH_VERSION.tar.gz"
ARCHIVE_TEMP="$ARCHIVE.tmp.$$"
PATCH="$TOOL_DIR/$MOSH_PATCH_FILE"
LOCK_DIR="$BUILD_DIR/.prepare.lock"
TEMP_DIR="$SOURCE_DIR.tmp.$$"
lock_acquired=0

die() { printf 'prepare-source: %s\n' "$*" >&2; exit 1; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
cleanup() {
  rm -rf "$TEMP_DIR"
  [ "$lock_acquired" -eq 0 ] || rm -rf "$LOCK_DIR"
  rm -f "$ARCHIVE_TEMP"
}
trap cleanup EXIT HUP INT TERM

[ "$(sha256_file "$PATCH")" = "$MOSH_PATCH_SHA256" ] || die "tracked patch checksum mismatch"
mkdir -p "$BUILD_DIR/downloads"
mkdir "$LOCK_DIR" 2>/dev/null || die "another source preparation is active"
lock_acquired=1
if [ ! -f "$ARCHIVE" ]; then
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "$MOSH_SOURCE_URL" -o "$ARCHIVE_TEMP"
  [ "$(sha256_file "$ARCHIVE_TEMP")" = "$MOSH_SOURCE_SHA256" ] || die "downloaded source checksum mismatch"
  mv -f "$ARCHIVE_TEMP" "$ARCHIVE"
fi
[ "$(sha256_file "$ARCHIVE")" = "$MOSH_SOURCE_SHA256" ] || die "cached source checksum mismatch; remove it explicitly"

marker_text="source=$MOSH_SOURCE_SHA256
patch=$MOSH_PATCH_SHA256"
if [ -e "$SOURCE_DIR" ]; then
  [ -d "$SOURCE_DIR" ] || die "source path is not a directory"
  [ -f "$SOURCE_DIR/.droidworks-managed-source" ] || die "refusing foreign source directory"
  [ "$(cat "$SOURCE_DIR/.droidworks-managed-source")" = "$marker_text" ] || die "source ownership marker mismatch"
  [ "$(git hash-object "$SOURCE_DIR/src/terminal/terminaldisplay.cc")" = "$MOSH_PATCHED_DISPLAY_BLOB" ] \
    && [ "$(git hash-object "$SOURCE_DIR/src/terminal/terminaldisplay.h")" = "$MOSH_PATCHED_HEADER_BLOB" ] \
    && [ "$(git hash-object "$SOURCE_DIR/src/terminal/terminaldisplayinit.cc")" = "$MOSH_PATCHED_INIT_BLOB" ] \
    || die "managed patch-scope source was modified"
  "$TOOL_DIR/scripts/verify-source-tree.sh" "$SOURCE_DIR" "$MOSH_PATCHED_SOURCE_TREE_SHA256" >/dev/null \
    || die "managed source tree was modified"
  printf 'Mosh %s source already prepared at %s\n' "$MOSH_VERSION" "$SOURCE_DIR"
  exit 0
fi

rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
tar -xzf "$ARCHIVE" -C "$TEMP_DIR" --strip-components=1
(
  cd "$TEMP_DIR"
  patch -p1 --dry-run < "$PATCH" >/dev/null
  patch -p1 < "$PATCH" >/dev/null
)
[ "$(git hash-object "$TEMP_DIR/src/terminal/terminaldisplay.cc")" = "$MOSH_PATCHED_DISPLAY_BLOB" ] \
  && [ "$(git hash-object "$TEMP_DIR/src/terminal/terminaldisplay.h")" = "$MOSH_PATCHED_HEADER_BLOB" ] \
  && [ "$(git hash-object "$TEMP_DIR/src/terminal/terminaldisplayinit.cc")" = "$MOSH_PATCHED_INIT_BLOB" ] \
  || die "patched source blobs do not match manifest"
"$TOOL_DIR/scripts/verify-source-tree.sh" "$TEMP_DIR" "$MOSH_PATCHED_SOURCE_TREE_SHA256" >/dev/null \
  || die "patched source tree does not match manifest"
printf '%s\n' "$marker_text" > "$TEMP_DIR/.droidworks-managed-source"

mv "$TEMP_DIR" "$SOURCE_DIR"
printf 'prepared Mosh %s with Kitty flags %s at %s\n' "$MOSH_VERSION" "$MOSH_KITTY_FLAGS" "$SOURCE_DIR"
