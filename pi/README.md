# Pi

Guarded patches for the installed [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) npm package. Upstream source is not vendored.

## Fullscreen selection colors

Pi `0.86.0` renders application-owned fullscreen selections with reverse video. [`0001-fullscreen-selection-colors.patch`](patches/0001-fullscreen-selection-colors.patch) adds a `selectionStyle` callback to `pi-tui` and wires coding-agent to the active Pi theme:

```ts
selectionStyle: (text) => theme.bg("selectedBg", theme.fg("text", text))
```

Fullscreen selection therefore follows dark/light theme changes without embedding terminal-specific RGB values. Standalone `pi-tui` consumers that omit the callback retain reverse video as the default.

Selection rendering styles each plain-text span between terminal control sequences. Embedded SGR resets and OSC sequences, including OSC 8 hyperlinks, remain intact without punching holes in the selected background.

The installed Pi executable runs a bundled chunk, not the nested `pi-tui` module. The installer patches the module, declarations, coding-agent renderer, and bundled runtime. Package versions are informational; the installer refuses changed source shapes:

From the Droidworks repository root:

```bash
pi/scripts/apply-installed-patches.py
pi/scripts/apply-installed-patches.py --check
pi/tests/test-installed-patch.sh
```

Reapply the patch after Pi installation or updates. Update the canonical source patch, compiled replacements, and regression test when the relevant Pi code changes.

The source patch is based on `@earendil-works/pi-tui@0.86.0` (`v0.86.0`, commit `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`).
