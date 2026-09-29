# Pi Update

[![CI](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml/badge.svg)](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/EugeneTrapeznikov/droidworks?filter=pi-update%40*&label=release)](https://github.com/EugeneTrapeznikov/droidworks/releases?q=pi-update&expanded=true)

A Pi extension that runs `pi update --all --no-approve` in the background on every Pi startup, then reapplies the [Droidworks `pi` patches](../pi/).

## Behavior

- Runs only for TUI startup sessions (`pi`), not `/reload`, `/new`, or `pi -p` print runs.
- Starts after a short delay so the TUI can open first.
- Records the last run in `~/.pi/agent/pi-update/state.json`.
- Uses a lock file to avoid multiple Pi sessions updating at the same time.
- Reapplies the guarded installed-Pi patches (`../pi/scripts/apply-installed-patches.py` in the same checkout) after every successful update. A changed patch target records `patch-failed`, notifies visibly, and retries on the next startup instead of silently losing the patch.
- Shows footer status while checking and notifies on failures.

Pi's built-in package-update check runs concurrently. Its banner can appear before the background update finishes and is not removed afterward. Use `/pi-update status` to confirm completion; restart Pi to load newly installed package code.

## Install

Link the directory into Pi's extensions from a Droidworks checkout:

```bash
ln -s /path/to/droidworks/pi-update ~/.pi/agent/extensions/pi-update
```

## Commands

Inside Pi:

```text
/pi-update          # run pi update --all now
/pi-update status   # show last run status
/pi-update reset    # clear recorded state
```

## Environment variables

- `PI_UPDATE_DISABLED=1` disables the extension.
- `PI_UPDATE_INTERVAL_HOURS=0` sets a minimum number of hours between automatic runs; `0` (default) runs on every startup. Failed or interrupted runs always retry on the next startup.
- `PI_UPDATE_START_DELAY_MS=1500` controls startup delay before background check.
- `PI_UPDATE_TIMEOUT_MS=600000` controls update timeout.
- `PI_UPDATE_NOTIFY_SUCCESS=1` notifies on successful automatic checks.
- `PI_UPDATE_COMMAND=pi` changes the command.
- `PI_UPDATE_ARGS="update --all --no-approve"` changes command arguments.
- `PI_UPDATE_PATCHER=/path/to/apply-installed-patches.py` overrides the post-update patcher.

## Verify

```bash
node pi-update/verify.js
```

A successful check prints `PI_UPDATE_VERIFY_PASS`.
