# Mosh Droidworks

A macOS ARM64 [Mosh](https://github.com/mobile-shell/mosh) `1.4.0` client with one opt-in patch: it turns on Kitty keyboard encoding in the laptop terminal, so ⌘C reaches a remote TUI such as Herdr that owns the mouse selection. Remote `mosh-server` stays stock.

The source is the official `1.4.0` release archive. `scripts/prepare-source.sh` verifies its checksum, the patch checksum, the patched blobs, and a digest of the whole patched tree before anything builds.

## Why

Over plain Mosh, ⌘C works when the laptop terminal owns the selection. A remote TUI that captures the mouse owns the selection itself, so ⌘C has to reach it as a key, and a Command-modified key is only representable with the Kitty keyboard protocol. The remote app asks the terminal for that mode, but Mosh does not forward the request.

## Behavior

With `MOSH_KITTY_KEYBOARD=1`:

- The client pushes Kitty flags `CSI > 7 u` after alternate-screen entry and pops them with one `CSI < u` before restore, also across suspend and resume.
- Every frame that draws sets the flags again with `CSI = 7 u`. A terminal can reset its input modes without telling the client, as Orca does when it restores a terminal view; a remote selection draws its highlight before ⌘C arrives, so ⌘C still reaches the app. Idle screens emit nothing.
- Unset, the client is byte-for-byte upstream. Any other value fails closed.

Flags `7`, not `31`: with `31`, Ghostty also reports a standalone left-Command press (`ESC[57444;9u`), which Herdr forwards and uses to clear its selection before ⌘C arrives. Flags `7` delivers ⌘C as `ESC[99;9u` alone.

Ghostty needs ⌘C unbound so the key reaches the application:

```ini
keybind = cmd+c=unbind
```

## Build and install

Prerequisites: macOS ARM64, Apple clang, `make`, `pkg-config`, and Homebrew `protobuf`, `abseil`, and `openssl@3`. The client links those Homebrew libraries dynamically, so rebuild after upgrading them; each build records the versions it saw in `build/macos-arm64/dependencies.txt`.

```bash
mosh/scripts/build-macos.sh
mosh/scripts/install-artifact.sh --artifact mosh/build/macos-arm64/mosh-client
```

The build compiles and runs `tests/display-kitty.cc` against the patched `Terminal::Display` library and checks that the artifact links only macOS system ncurses. The installer writes `~/.local/bin/mosh-client-droidworks` with a `.droidworks-managed` ownership marker and refuses to replace an official `mosh-client` path.

Use it for one connection:

```bash
MOSH_KITTY_KEYBOARD=1 mosh --client="$HOME/.local/bin/mosh-client-droidworks" host -- herdr
```

Remove an intact managed install:

```bash
mosh/scripts/uninstall-managed.sh
```

## Verify

```bash
mosh/scripts/test-upstream.sh
mosh/scripts/verify-artifact.sh mosh/build/macos-arm64/mosh-client
```

The upstream suite passes 29 tests with 2 expected failures.

## Updating

1. Pin a stable upstream release: archive URL and checksum, release commit.
2. Re-apply the patch, then pin its checksum, the patched blobs, and the patched tree digest in `manifest.env`.
3. Keep the patch client-only and opt-in; keep flags `7`.
4. Run the display harness, the upstream suite, and a real ⌘C copy from a Herdr selection; record them in `PROVENANCE.md`.

Mosh is GPL-3.0-or-later; the patch and the built client are distributed under the same license.
