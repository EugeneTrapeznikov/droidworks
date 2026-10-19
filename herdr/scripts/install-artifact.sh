#!/usr/bin/env bash
set -euo pipefail

artifact=""
destination="$HOME/.local/bin/herdr-droidworks"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact) [ "$#" -ge 2 ] || exit 2; artifact=$2; shift 2 ;;
    --destination) [ "$#" -ge 2 ] || exit 2; destination=$2; shift 2 ;;
    *) printf 'install-artifact: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -n "$artifact" ] || { printf 'install-artifact: --artifact is required\n' >&2; exit 2; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
canonical_path() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}
die() { printf 'install-artifact: %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 is required for protected-path validation"
[ -f "$artifact" ] && [ -x "$artifact" ] || die "artifact is not an executable file: $artifact"
source_sidecar="$artifact.sha256"
[ -f "$source_sidecar" ] || die "missing artifact checksum: $source_sidecar"
expected=$(awk 'NR == 1 { print $1 }' "$source_sidecar")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "invalid artifact checksum"
[ "$(sha256_file "$artifact")" = "$expected" ] || die "artifact checksum mismatch"
destination=$(canonical_path "$destination")
# A symlink at the official path is a managed alias, not the official binary.
official=$HOME/.local/bin/herdr
[ -L "$official" ] || [ "$destination" != "$(canonical_path "$official")" ] || die "refusing to replace official Herdr"

parent=$(dirname "$destination")
marker="$destination.droidworks-managed"
mkdir -p "$parent"
lock="$destination.install.lock"
mkdir "$lock" 2>/dev/null || die "install lock is held: $lock"
staged_binary="$destination.tmp.$$"
staged_marker="$marker.tmp.$$"
backup_binary="$destination.backup.$$"
backup_marker="$marker.backup.$$"
had_existing=0
backup_binary_moved=0
backup_marker_moved=0
published_binary=0
published_marker=0
committed=0
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  set +e
  rm -f "$staged_binary" "$staged_marker"
  if [ "$committed" -eq 0 ]; then
    if [ "$had_existing" -eq 1 ]; then
      if [ "$backup_binary_moved" -eq 1 ]; then
        rm -f "$destination"
        mv -f "$backup_binary" "$destination"
      fi
      if [ "$backup_marker_moved" -eq 1 ]; then
        rm -f "$marker"
        mv -f "$backup_marker" "$marker"
      fi
    else
      [ "$published_binary" -eq 0 ] || rm -f "$destination"
      [ "$published_marker" -eq 0 ] || rm -f "$marker"
    fi
  else
    rm -f "$backup_binary" "$backup_marker"
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM

if [ -e "$destination" ] || [ -e "$marker" ]; then
  had_existing=1
  [ -f "$destination" ] && [ -f "$marker" ] || die "refusing partial existing install"
  installed_type=$(sed -n 's/^type=//p' "$marker")
  installed_expected=$(sed -n 's/^sha256=//p' "$marker")
  installed_name=$(sed -n 's/^name=//p' "$marker")
  [ "$(sed -n '1p' "$marker")" = droidworks-managed-v1 ] \
    && [ "$installed_type" = herdr ] \
    && [ "$installed_name" = "$(basename "$destination")" ] \
    && printf '%s\n' "$installed_expected" | grep -Eq '^[0-9a-f]{64}$' \
    || die "refusing invalid installed ownership marker"
  [ "$(sha256_file "$destination")" = "$installed_expected" ] || die "refusing to replace foreign or modified destination"
  mv "$destination" "$backup_binary"
  backup_binary_moved=1
  mv "$marker" "$backup_marker"
  backup_marker_moved=1
fi

install -m 0755 "$artifact" "$staged_binary"
[ "$(sha256_file "$staged_binary")" = "$expected" ] || die "staged binary checksum mismatch"
printf 'droidworks-managed-v1\ntype=herdr\nsha256=%s\nname=%s\n' "$expected" "$(basename "$destination")" > "$staged_marker"
chmod 0644 "$staged_marker"
mv -f "$staged_binary" "$destination"
published_binary=1
mv -f "$staged_marker" "$marker"
published_marker=1
[ "$(sha256_file "$destination")" = "$expected" ] || die "published binary checksum mismatch"
committed=1
printf 'installed %s (%s)\n' "$destination" "$expected"
