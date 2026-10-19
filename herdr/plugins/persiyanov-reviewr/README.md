# Reviewr

[Reviewr](https://github.com/persiyanov/herdr-reviewr) is a read-only diff and file-viewer pane for Herdr. It lets a human annotate changed lines and send the resulting review back to an agent.

## Requirements

- Herdr 0.7.5 or newer
- macOS or Linux
- `git` on `PATH`
- A truecolor terminal with Unicode box-drawing
- An authenticated `gh`, `glab`, or `az` CLI only when using the read-only PR tab

The catalog follows the latest upstream release by default. `plugin.env` intentionally leaves `ref` empty and declares `required_action=toggle`. Reconciliation therefore fails closed if an installed Reviewr does not expose the action used by our shortcut. Set `ref` to a previously accepted tag or commit only when latest is broken, run an explicit refresh, and clear it after upstream is healthy.

## Install or reconcile

Official Herdr:

```bash
herdr/scripts/reconcile-plugins.sh
```

A managed or non-default Herdr binary:

```bash
HERDR_BIN="$HOME/.local/bin/herdr-droidworks" \
  herdr/scripts/reconcile-plugins.sh
```

Normal reconciliation installs a missing plugin and fixes its enabled state, but does not interrupt an already-installed plugin. Explicitly update from latest—or apply a configured rollback ref—with:

```bash
HERDR_BIN="$HOME/.local/bin/herdr-droidworks" \
  herdr/scripts/reconcile-plugins.sh --refresh
```

`--refresh` uninstalls and reinstalls the plugin, so close or save work in its panes first.

## Toggle shortcut

Merge [`config.toml.snippet`](config.toml.snippet) into `~/.config/herdr/config.toml`. Preserve every unrelated setting. Our custom binding is:

```toml
[[keys.command]]
key = "ctrl+r"
type = "plugin_action"
command = "persiyanov.reviewr.toggle"
description = "Toggle reviewr pane"
```

Apply the change to a running server:

```bash
herdr server reload-config
```

Use the same Herdr binary that owns the running server when it is not the default `herdr` on `PATH`.

Reviewr-owned settings live separately at:

```text
~/.config/herdr/plugins/config/persiyanov.reviewr/config.toml
```

## Verify

```bash
HERDR_BIN=${HERDR_BIN:-herdr}
"$HERDR_BIN" plugin list --plugin persiyanov.reviewr --json
"$HERDR_BIN" plugin action list --plugin persiyanov.reviewr
```

The plugin must be enabled and expose `persiyanov.reviewr.toggle`. Invoke it for the focused workspace with:

```bash
"$HERDR_BIN" plugin action invoke toggle --plugin persiyanov.reviewr
```
