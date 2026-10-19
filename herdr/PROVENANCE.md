# Herdr Droidworks provenance

## Upstream inputs

- Upstream: `https://github.com/herdrdev/herdr.git` (Apache-2.0, see `LICENSE.upstream`)
- Stable tag: `v0.9.5`
- Release commit: `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`
- Patches, applied in order; checksums and resulting blob IDs are pinned in `manifest.env`:
  - `0001-completed-tab-indicator.patch` — an unfocused tab with Herdr's `Done` status renders a trailing accent-blue `●`. Carried from 0.9.0 with a three-way merge.
  - `0002-terminal-notification-bell-fallback.patch` — `terminal` toast delivery writes BEL when no OSC notification backend is detected, instead of writing nothing.
  - `0003-focus-reporting-rearm.patch` — with no known terminal detected, the client writes `?1004l` and, 500 ms later, `?1004h` every 10 seconds so focus reporting that the host dropped is restored through Mosh.

## Build inputs

- macOS ARM64: Rust 1.96.0, Zig 0.16.0, `cargo build --release --locked`.
- Linux x86_64: static PIE for `x86_64-unknown-linux-musl`, Rust 1.96.1 in `rust:1.96-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663`, Zig 0.16.0 from its checksum-pinned official archive.

## Release `herdr@0.9.5-dw.2`

- `herdr-macos-arm64` SHA-256: `0f183fa876df0f3dd5fdafa0463cc3038dd880f752402a2dc914ac5b88c7fc64`
- `herdr-linux-x86_64` SHA-256: `8af2ca6f8149598cfa61b4f99aff20e317dc9052897223118b345d38f7cc95a4`

## Validation evidence

Validated on 2026-10-19 (focus re-arm added the same day):

- `tests/test-prepare-source.sh`: passed (pinned commit, patch checksums, patched blobs, idempotent re-prepare, refusal of foreign changes without mutation).
- `cargo test --locked --bin herdr -- terminal_notify client::shell notification`: 411 passed (418 with `client::timer`), including `unknown_terminal_notification_falls_back_to_bell` and `known_terminal_notification_keeps_osc`. Upstream's `semantic_notifications_broadcast_only_to_client_shells` failed once in a parallel run and passed on every rerun, with and without the patches.
- `cargo fmt --check` on the patched files: passed.
- Both artifacts passed `verify-artifact.sh` as `herdr 0.9.5`.
- Behavior: a client attached in a pty with `TERM=xterm-256color`, no `TERM_PROGRAM`, `delivery = "terminal"`, and outer focus lost received one BEL for `herdr notification show`; stock Herdr under the same conditions wrote nothing.
- Focus re-arm: a pty-attached client wrote `?1004l` then `?1004h` 0.5 s apart every 10 s. In Orca 1.4.225 over Mosh 1.4.0, a terminal that had stopped sending focus reports resumed after the toggle: it answered `CSI I` at once and reported later app switches.
- Installer: fresh install, upgrade with `~/.local/bin/herdr` as a symlink to the managed binary, refusal to replace a real official binary, and refusal to replace a modified managed binary.
