# cmux Droidworks

A reproducible patch for [cmux issue #11228](https://github.com/manaflow-ai/cmux/issues/11228): ⌘C is swallowed before fullscreen Kitty-keyboard applications such as Pi and Claude Code can handle their own selection.

The source is pinned to stable cmux `v0.64.25` at `b685a275c2e411799857155e37264daf84f7e4d6`. `materialize.sh` verifies the tag and Ghostty submodule commit before applying the ordered patches.

## Behavior

- A native Ghostty selection keeps the normal Edit → Copy path.
- With no native selection, Kitty keyboard disambiguation lets ⌘C reach the focused TUI.
- A shell without Kitty keyboard disambiguation keeps cmux's unavailable-Copy no-op.
- The debug footer shows the build tag (`droidworks`) beside the footer controls.
- The sidebar update pill reports new official releases; Install opens the GitHub release page instead of replacing the patched app.

Ghostty needs a performable Copy binding so an unavailable native copy can fall through to the application:

```ini
keybind = performable:cmd+c=copy_to_clipboard:mixed
```

## Verify

```bash
cmux/tests/test-patch.sh
```

The test checks every patch against the pinned source and verifies the routing policy, C ABI, branding, and regression test are present.

## Build and install

Requires macOS, Xcode, Zig, and cmux's normal build dependencies.

```bash
cmux/scripts/build.sh
cmux/scripts/build.sh --install
```

The build uses upstream's tagged development workflow with production services and produces:

- app: `cmux Droidworks.app`
- bundle ID: `dev.droidworks.cmux`
- independent tagged socket/state
- bundled CLI: `cmux Droidworks.app/Contents/Resources/bin/cmux`

Quit cmux Droidworks and build from another terminal (Terminal.app or official cmux): upstream's tagged reload quits every running app with the Droidworks bundle ID.

`--install` places the app in `/Applications` and moves an existing Droidworks build to `~/.Trash`. It does not replace official cmux or its CLI links.

## Updates

The app checks the official stable feed and shows "Update available" in the sidebar when cmux ships a release. Install opens the release page; the build also strips Sparkle's EdDSA key, so an official archive cannot replace the patched bundle. Keep official cmux installed for rollback. Check the fork's stable pin directly with:

```bash
cmux/scripts/check-upstream.sh
```

The scheduled GitHub workflow runs the same check weekly. To update, change `upstream.lock`, refresh patches as needed, run `tests/test-patch.sh`, then rebuild. Release tags use `cmux@<upstream-version>-dw.<n>`.

## License

cmux is GPL-3.0-or-later. The source patches and any resulting binaries are governed by the upstream license in [`LICENSE.upstream`](LICENSE.upstream). Built binaries are local artifacts and are not published here.
