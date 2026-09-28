#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
lock="$root/upstream.lock"
destination="$root/repo"

fail() { printf 'cmux materialize: %s\n' "$*" >&2; exit 1; }
value() {
  local key=$1 matches
  matches=$(grep -c "^${key}=" "$lock" || true)
  [[ $matches == 1 ]] || fail "upstream.lock needs exactly one ${key} entry"
  grep "^${key}=" "$lock" | cut -d= -f2-
}

[[ -f "$lock" ]] || fail "missing $lock"
url=$(value url)
tag=$(value tag)
commit=$(value commit)
ghostty_commit=$(value ghostty_commit)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "invalid commit"
[[ $ghostty_commit =~ ^[0-9a-f]{40}$ ]] || fail "invalid ghostty_commit"
tag_commit=$(git ls-remote "$url" "refs/tags/$tag^{}" | awk 'NR == 1 { print $1 }')
[[ -n "$tag_commit" ]] || tag_commit=$(git ls-remote "$url" "refs/tags/$tag" | awk 'NR == 1 { print $1 }')
[[ $tag_commit == "$commit" ]] || fail "$tag resolves to ${tag_commit:-nothing}, expected $commit"

staging=$(mktemp -d "$root/.repo.staging.XXXXXX")
cleanup() { [[ ! -d "$staging" ]] || rm -rf -- "$staging"; }
trap cleanup EXIT

git -C "$staging" init --quiet
git -C "$staging" remote add origin "$url"
git -C "$staging" fetch --quiet --depth 1 origin "$commit"
git -C "$staging" checkout --quiet --detach "$commit"
git -C "$staging" submodule update --init --depth 1 --recursive ghostty vendor/bonsplit
[[ $(git -C "$staging/ghostty" rev-parse HEAD) == "$ghostty_commit" ]] \
  || fail "Ghostty submodule does not match upstream.lock"
[[ -f "$staging/vendor/bonsplit/Package.swift" ]] \
  || fail "bonsplit package submodule is incomplete"

for patch in "$root"/patches/ghostty/*.patch; do
  git -C "$staging/ghostty" apply --check "$patch"
  git -C "$staging/ghostty" apply "$patch"
done
for patch in "$root"/patches/cmux/*.patch; do
  git -C "$staging" apply --check "$patch"
  git -C "$staging" apply "$patch"
done

git -C "$staging" diff --check
git -C "$staging/ghostty" diff --check

backup=
if [[ -e "$destination" ]]; then
  backup="$root/.repo.backup.$$"
  mv -- "$destination" "$backup"
fi
mv -- "$staging" "$destination"
staging=
[[ -z "$backup" ]] || rm -rf -- "$backup"
printf 'Materialized cmux %s (%s) at %s\n' "$tag" "$commit" "$destination"
