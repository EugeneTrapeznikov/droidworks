# Pi Profiles

[![CI](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml/badge.svg)](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/EugeneTrapeznikov/droidworks?filter=pi-profiles%40*&label=release)](https://github.com/EugeneTrapeznikov/droidworks/releases?q=pi-profiles&expanded=true)

A Pi extension that picks a profile for the session's repo and pushes that profile's settings into the session. Extensions never see profiles: each one receives only its own key from a generic config overlay.

## Profiles file

One private file, shared by agent tools: `~/.config/agent-profiles/profiles.yaml` (override with `AGENT_PROFILES_PATH`; JSON is valid YAML). Repo-identifying matchers belong here, never in code or git.

```yaml
default: personal
profiles:
  work:
    match:
      - git_remote_includes: git.example-work.invalid
      - cwd_prefix: ~/work
    pi:
      model: provider/model-id
      config:
        pi-extension-loader: { remote-pi: "off" }
  personal:
    pi:
      config:
        moa-harness: { jev: { enabled: true } }
```

- The first profile with any matching rule wins; otherwise `default`. A rule matches when all its conditions hold. `cwd_prefix` is path-segment-safe (`~` expands, real paths). `git_remote_includes` is a substring of `git remote get-url origin`.
- No file: nothing is pushed and every extension keeps its own config. Malformed file: an error notification and nothing is pushed. Keep privacy-relevant switches in each extension's safe default and turn them on from a profile, so a missing or broken file fails closed.

## What a session gets

On `session_start`:

- `pi.events` emits `pi-config-overlay:v1` with `{ source: "pi-profiles", profile, config }`. A consumer reads `config["<its-id>"]` and applies it over its own configuration; each push replaces the previous one.
- `pi.model` (`provider/id`) is applied to fresh sessions (`startup`, `new`), unless `--model`, `--provider`, or `--models` was passed. Resumed and forked sessions keep their model.
- `AGENT_PROFILE=<name>` is exported to child processes, and the footer shows `👤 profile:<name>` ([`pi-footer-nerdfonts`](../pi-footer-nerdfonts/) renders the glyph).

## Install

From a Droidworks checkout:

```bash
(cd pi-profiles && npm ci)
ln -s "$PWD/pi-profiles" ~/.pi/agent/extensions/pi-profiles
```

## CLI

```bash
node pi-profiles/index.ts [cwd]   # prints the profile name for cwd
```

## Test

```bash
cd pi-profiles && bun test
```
