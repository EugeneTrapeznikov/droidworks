#!/usr/bin/env bash
set -euo pipefail

destination="$HOME/.local/bin/herdr-droidworks"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination) [ "$#" -ge 2 ] || exit 2; destination=$2; shift 2 ;;
    *) printf 'uninstall-managed: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

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
die() { printf 'uninstall-managed: %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 is required for protected-path validation"
destination=$(canonical_path "$destination")
# A symlink at the official path is a managed alias, not the official binary.
official=$HOME/.local/bin/herdr
[ -L "$official" ] || [ "$destination" != "$(canonical_path "$official")" ] || die "refusing to remove official Herdr"
marker="$destination.droidworks-managed"
if [ ! -e "$destination" ] && [ ! -e "$marker" ]; then
  printf 'managed Herdr already absent: %s\n' "$destination"
  exit 0
fi
[ -f "$destination" ] && [ -f "$marker" ] || die "refusing partial managed install"
installed_type=$(sed -n 's/^type=//p' "$marker")
expected=$(sed -n 's/^sha256=//p' "$marker")
installed_name=$(sed -n 's/^name=//p' "$marker")
[ "$(sed -n '1p' "$marker")" = droidworks-managed-v1 ] \
  && [ "$installed_type" = herdr ] \
  && [ "$installed_name" = "$(basename "$destination")" ] \
  && printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' \
  || die "refusing invalid ownership marker"
[ "$(sha256_file "$destination")" = "$expected" ] || die "refusing to remove foreign or modified destination"
lock="$destination.install.lock"
mkdir "$lock" 2>/dev/null || die "install lock is held: $lock"
trap 'rmdir "$lock" 2>/dev/null || true' EXIT HUP INT TERM
rm -f "$destination" "$marker"
printf 'removed managed Herdr: %s\n' "$destination"
