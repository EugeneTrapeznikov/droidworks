#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
install=0
[[ ${1:-} != --install ]] || { install=1; shift; }
[[ $# == 0 ]] || { echo "usage: $0 [--install]" >&2; exit 2; }

command -v zig >/dev/null || { echo "Zig 0.16 or newer is required" >&2; exit 1; }
zig_version=$(zig version)
IFS=. read -r zig_major zig_minor _ <<< "$zig_version"
((zig_major > 0 || zig_minor >= 16)) \
  || { echo "Zig 0.16 or newer is required (found $zig_version)" >&2; exit 1; }
developer_dir=$(xcode-select -p 2>/dev/null || true)
[[ -d "$developer_dir/Platforms/MacOSX.platform/Developer/SDKs" ]] \
  || { echo "Full Xcode is required; xcode-select currently points to ${developer_dir:-nothing}" >&2; exit 1; }

name="cmux Droidworks"
bundle_id="dev.droidworks.cmux"
# reload.sh quits every running app with this bundle id, including the
# installed copy and any terminal session running this build inside it.
! ps -axo comm= | grep -Fq "/$name.app/Contents/MacOS/" \
  || { echo "Quit $name first, then build from another terminal" >&2; exit 1; }

"$root/materialize.sh"
repo="$root/repo"
derived="${CMUX_DROIDWORKS_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/cmux-droidworks}"
# Precompiled modules from a prior pin survive into the next one and fail
# against changed package headers (Iroh), so a new pin starts from clean.
if ! cmp -s "$root/upstream.lock" "$derived/upstream.lock"; then
  rm -rf -- "$derived"
  mkdir -p "$derived"
  cp "$root/upstream.lock" "$derived/upstream.lock"
fi

(
  cd "$repo"
  ./scripts/reload.sh \
    --tag droidworks \
    --name "$name" \
    --bundle-id "$bundle_id" \
    --derived-data "$derived" \
    --prod-auth \
    --no-global-cli-links
)

app="$derived/Build/Products/Debug/$name.app"
plist="$app/Contents/Info.plist"
[[ -f "$plist" ]] || { echo "missing built app: $app" >&2; exit 1; }

# Sparkle keeps checking the official feed so the sidebar shows new releases;
# patch 0003 turns Install into opening the release page. Without the EdDSA
# key Sparkle also cannot validate an official archive, so a stray install
# path cannot replace the patched bundle.
/usr/libexec/PlistBuddy -c 'Delete :SUPublicEDKey' "$plist" 2>/dev/null || true
codesign --force --sign - "$app"

[[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist") == "$bundle_id" ]] \
  || { echo "unexpected bundle identifier" >&2; exit 1; }
! /usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$plist" >/dev/null 2>&1 \
  || { echo "Sparkle signing key remains" >&2; exit 1; }
codesign --verify --deep --strict "$app"

if [[ $install == 1 ]]; then
  destination="/Applications/$name.app"
  staging="/Applications/.$name.staging.$$"
  ditto "$app" "$staging"
  if [[ -e "$destination" ]]; then
    mkdir -p "$HOME/.Trash"
    backup="$HOME/.Trash/$name $(date +%Y%m%d-%H%M%S).app"
    mv -- "$destination" "$backup"
    printf 'Moved prior build to %s\n' "$backup"
  fi
  mv -- "$staging" "$destination"
  printf 'Installed %s\n' "$destination"
else
  printf 'Built %s\n' "$app"
fi
