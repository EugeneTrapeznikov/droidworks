#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
"$root/materialize.sh"
repo="$root/repo"

[[ -f "$repo/vendor/bonsplit/Package.swift" ]] \
  || { echo "bonsplit package submodule is incomplete" >&2; exit 1; }
for patch in "$root"/patches/cmux/*.patch; do
  git -C "$repo" apply --reverse --check "$patch"
done
for patch in "$root"/patches/ghostty/*.patch; do
  git -C "$repo/ghostty" apply --reverse --check "$patch"
done

python3 - "$repo" <<'PY'
from pathlib import Path
import sys

repo = Path(sys.argv[1])
view = (repo / "Sources/GhosttyTerminalView.swift").read_text()
sidebar = (repo / "Sources/VerticalTabsSidebar+EmptyAreasAndFooter.swift").read_text()
tests = (repo / "cmuxTests/WindowKeyDownReplayGuardTests.swift").read_text()
header = (repo / "ghostty/include/ghostty.h").read_text()
embedded = (repo / "ghostty/src/apprt/embedded.zig").read_text()
surface = (repo / "ghostty/src/Surface.zig").read_text()

assert "ghostty_surface_uses_kitty_keyboard_disambiguation(surface)" in view
assert "!hasCopyableSelection && !usesKittyKeyboardDisambiguation" in view
assert 'environment["CMUX_TAG"]?.uppercased()' in sidebar
assert "unavailableCopyPolicyForwardsKittyApplicationKeysOnly" in tests
assert "GHOSTTY_API bool ghostty_surface_uses_kitty_keyboard_disambiguation" in header
assert "export fn ghostty_surface_uses_kitty_keyboard_disambiguation" in embedded
assert "screens.active.kitty_keyboard.current().disambiguate" in surface
print("cmux copy-routing patch checks passed")
PY
