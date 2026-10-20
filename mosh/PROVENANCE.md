# Mosh Droidworks provenance

## Upstream inputs

- Upstream: `https://github.com/mobile-shell/mosh` (GPL-3.0-or-later)
- Version: `1.4.0`, release commit `bc73a26316ede2a79259d859f8ee309b32412420`
- Source archive: `https://github.com/mobile-shell/mosh/releases/download/mosh-1.4.0/mosh-1.4.0.tar.gz`
- Source SHA-256: `872e4b134e5df29c8933dff12350785054d2fd2839b5ae6b5587b14db1465ddd`
- Patch: `patches/0001-kitty-keyboard-opt-in.patch`; its checksum, patched blobs, and patched tree digest are pinned in `manifest.env`.
- Patch scope: `src/terminal/terminaldisplay.{cc,h}` and `src/terminal/terminaldisplayinit.cc`.

## Build inputs

Apple clang 21.0.0, `-O2 -std=c++17`, Homebrew protobuf 36.0 and OpenSSL 3.6.5, macOS SDK `/usr/lib/libncurses.5.4.dylib`. Homebrew versions are recorded per build, not pinned; the client links protobuf and Abseil dynamically.

## Validation evidence

Validated on 2026-10-20:

- `tests/display-kitty.cc`: PASS. Default emits no Kitty sequence; an invalid opt-in value is rejected; one push after alternate-screen entry and one pop before restore, balanced across duplicate open/close and reopen; one `CSI = 7 u` per drawing frame, including full and resize repaints; no output for an unchanged frame; none after close.
- Upstream suite: 29 PASS, 2 expected XFAIL, 0 FAIL, 0 ERROR.
- Orca 1.4.235 over Mosh to a Linux `mosh-server` 1.4.0. A Kitty flags query (`CSI ? u`) answered from the laptop terminal through the session reported `7` at start, `0` after Orca's input-mode reset (`CSI < 99 u`, `CSI = 0 u`), still `0` after 5 idle seconds, and `7` after the remote app drew one character.
- Over Mosh to Herdr 0.9.5 in Orca, ⌘C copied a Herdr selection to the macOS clipboard, failed after a keyboard-mode reset with no redraw, and copied again after the next redraw.
- Artifact SHA-256: `8ed80c735b60c9e179781550a058c4c998a3660824628703e10bfba6b5afcfc2`.

Uncatchable `SIGKILL` can skip terminal cleanup, as with Mosh's own alternate-screen handling. Recovery: close the affected terminal or run `reset` in its shell.
