# Pi

Guarded patches for the installed [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) npm package. Upstream source is not vendored.

Requires Pi 0.87.1 or newer. Releases are tagged `pi@<tested Pi version>-dw.<n>`.

## Fullscreen selection colors

[`0001-fullscreen-selection-colors.patch`](patches/0001-fullscreen-selection-colors.patch) adds a `selectionStyle` callback to `pi-tui`; [`0002-fullscreen-selection-theme-roles.patch`](patches/0002-fullscreen-selection-theme-roles.patch) gives fullscreen transcript selection two dedicated optional theme roles:

```ts
selectionStyle: (text) => theme.bg("fullscreenSelectionColor", theme.fg("fullscreenSelectionTextColor", text))
```

The active One Dark Pro Darker theme maps them to `border` (`#3e4451`) and `bright` (`#d7dae0`), matching Ghostty. Other themes fall back to `selectedBg` and `text`. Standalone `pi-tui` consumers that omit the callback use reverse video.

Selection rendering styles each plain-text span between terminal control sequences. Embedded SGR resets and OSC sequences, including OSC 8 hyperlinks, remain intact without punching holes in the selected background.

The installed Pi executable runs a bundled chunk, not the nested `pi-tui` module. The installer patches the module, declarations, theme roles, coding-agent renderer, and bundled runtime. Package versions are informational; the installer refuses changed source shapes:

From the Droidworks repository root:

```bash
pi/scripts/apply-installed-patches.py
pi/scripts/apply-installed-patches.py --check
pi/tests/test-installed-patch.sh
```

Reapply the patch after Pi installation or updates. Update the canonical source patch, compiled replacements, and regression test when the relevant Pi code changes.

The TUI source patch is based on `@earendil-works/pi-tui@0.86.0` (`v0.86.0`, commit `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`). The theme roles patch targets the coding-agent source shape installed with Pi `0.87.1`.
