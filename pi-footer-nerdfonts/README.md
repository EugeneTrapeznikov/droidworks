# Pi Footer Nerd Fonts

A small Pi extension that saves your eyes from emojis in the footer by replacing them with consistent Nerd Font glyphs.

```text
󰧑 agentmemory  󰒍 MCP: 7 servers enabled  󰝦 󱖿 ponytail: 󱐋 FULL
```

## Requirements

- [Pi](https://github.com/earendil-works/pi)
- A terminal configured with a Nerd Font v3

## Mappings

The extension currently covers status text produced by agentmemory, MCP, and Ponytail:

| Extension | Meaning | Original | Nerd Font |
|---|---|---:|---:|
| agentmemory | Memory | `🧠` | `󰧑` |
| MCP | Servers | `🔌` | `󰒍` |
| Ponytail | Inactive | `○` | `󰝦` |
| Ponytail | Active | `●` | `󰝥` |
| Ponytail | Brand | `🐴` | `󱖿` |
| Ponytail | Lite | `🌿` | `󰌪` |
| Ponytail | Full | `⚡` | `󱐋` |
| Ponytail | Ultra | `🔥` | `󰈸` |

Unmatched footer text passes through unchanged.

## Install

Add the extension directory to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/droidworks/pi-footer-nerdfonts"
  ]
}
```

Run `/reload` in an existing Pi session.

## Extend

Add another source-to-glyph entry to `GLYPHS` in [`index.ts`](index.ts):

```ts
const GLYPHS: Record<string, string> = {
  "source character": "nerd font glyph",
};
```

The extension rewrites existing footer statuses when a session starts and translates future calls to `ctx.ui.setStatus()`.

## Verify

```bash
node index.ts
```

A successful check prints `pi-footer-nerdfonts: ok`.
