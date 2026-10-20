#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
if [ "$mode" = --digest ]; then
  source_dir=${2:-}
  expected=""
else
  source_dir=$mode
  expected=${2:-}
fi
[ -n "$source_dir" ] || { printf 'usage: %s [--digest] <source-dir> [expected-sha256]\n' "$0" >&2; exit 2; }
[ -d "$source_dir" ] || { printf 'verify-source-tree: not a directory: %s\n' "$source_dir" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { printf 'verify-source-tree: python3 is required\n' >&2; exit 1; }

digest=$(python3 - "$source_dir" <<'PY'
import hashlib
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
hash_state = hashlib.sha256()
for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
    relative = path.relative_to(root).as_posix()
    if relative == ".droidworks-managed-source":
        continue
    info = path.lstat()
    kind = "link" if stat.S_ISLNK(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "dir"
    hash_state.update(f"{kind}\0{stat.S_IMODE(info.st_mode):o}\0{relative}\0".encode())
    if kind == "file":
        hash_state.update(hashlib.sha256(path.read_bytes()).digest())
    elif kind == "link":
        hash_state.update(os.readlink(path).encode())
    hash_state.update(b"\0")
print(hash_state.hexdigest())
PY
)
if [ "$mode" = --digest ]; then
  printf '%s\n' "$digest"
  exit 0
fi
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || {
  printf 'verify-source-tree: invalid expected digest\n' >&2
  exit 2
}
[ "$digest" = "$expected" ] || {
  printf 'verify-source-tree: source tree digest mismatch: expected %s, got %s\n' "$expected" "$digest" >&2
  exit 1
}
printf 'verified source tree %s (%s)\n' "$source_dir" "$digest"
