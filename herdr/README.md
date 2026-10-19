# Herdr Droidworks

A pinned [Herdr](https://github.com/herdrdev/herdr) build with three small patches for agents running on a remote machine and attached over Mosh or SSH.

The source is pinned to stable Herdr `v0.9.5` at `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`. `scripts/prepare-source.sh` verifies the tag, each patch checksum, and the resulting source blobs before anything builds.

## Behavior

- **Agent notifications reach any terminal.** With `[ui.toast] delivery = "terminal"`, Herdr sends a desktop notification escape (OSC 9 or OSC 99) only to Ghostty, iTerm2, WezTerm, and kitty. Anywhere else it sent nothing, and Mosh drops OSC notifications even for those terminals. This build writes a terminal bell instead, so "agent finished" and "agent needs input" reach the laptop through Mosh for every agent Herdr detects. The bell rings even for the tab you are looking at: Herdr's focus tracking does not survive hosts such as Orca that drop focus reporting, so the laptop terminal decides. Orca, for one, shows no notification for the workspace in front of you.
- **Finished tabs are marked.** An unfocused tab whose status is `Done` shows a trailing accent-blue `●`; focusing it clears the mark.

Recommended `~/.config/herdr/config.toml` on the remote machine:

```toml
[ui.toast]
delivery = "terminal"

[ui.sound]
enabled = false  # the sound would play on the remote machine
```

The laptop terminal turns the bell into a notification or sound: Orca's Terminal Bell notification, Ghostty's `bell-features`, or cmux.

## Install

Releases carry prebuilt `herdr-macos-arm64` and `herdr-linux-x86_64` assets. `install-release.sh` downloads the asset for this host with `gh`, checks it against the SHA-256 pinned in `manifest.env`, and installs it:

```bash
herdr/scripts/install-release.sh                 # ~/.local/bin/herdr-droidworks
```

The installer stages under a lock, keeps the previous managed binary until the new one is published, writes a `.droidworks-managed` ownership marker, and refuses to replace a foreign or modified file or the official `~/.local/bin/herdr` binary.

Move a running session to the new binary without restarting its panes, then reattach:

```bash
herdr-droidworks --session <name> server live-handoff --import-exe ~/.local/bin/herdr-droidworks
```

Remove an intact managed install:

```bash
herdr/scripts/uninstall-managed.sh
```

## Build

Build from the pinned source instead of downloading. macOS ARM64 needs Rust `1.96.0` and Zig `0.16.0`; Linux x86_64 builds as a static PIE inside the pinned Docker image, which downloads and verifies Zig itself:

```bash
herdr/scripts/build-macos.sh   # build/macos-arm64/herdr
herdr/scripts/build-linux.sh   # build/linux-x86_64/herdr
herdr/scripts/install-artifact.sh --artifact herdr/build/macos-arm64/herdr
```

Each build writes an adjacent `.sha256` and runs `verify-artifact.sh` (architecture, linkage, and `herdr 0.9.5`).

## Verify

```bash
herdr/tests/test-prepare-source.sh

cd herdr/herdr
ZIG=/opt/homebrew/opt/zig@0.16/bin/zig CARGO_TARGET_DIR=../build/cargo-macos \
  cargo test --locked --bin herdr -- terminal_notify client::shell notification
```

## Plugins

Approved Herdr plugins live under [`plugins/`](plugins/) as data-only manifests. Reconcile them for a given binary:

```bash
HERDR_BIN=~/.local/bin/herdr-droidworks herdr/scripts/reconcile-plugins.sh            # install missing, fix enabled state
HERDR_BIN=~/.local/bin/herdr-droidworks herdr/scripts/reconcile-plugins.sh --refresh  # reinstall from latest
```

## Updating Herdr

1. Pin the new version, tag, and release commit in `manifest.env`.
2. Prepare the source, reapply each patch, and regenerate `patches/` from the result.
3. Pin the patch checksums and patched blob IDs, run the checks above, build both artifacts, and record them in `PROVENANCE.md`.
4. Publish the release and pin the asset checksums in `manifest.env`.

Herdr is Apache-2.0; the upstream license and notice apply to the patched source and binaries.
