# TokenJuice + RTK

Layered Bash-output compaction for Pi without double filtering:

```text
Pi tool_call → RTK rewrites supported commands → command executes
Pi tool_result → TokenJuice handles only results not prefixed by rtk
```

[`index.js`](index.js) is the TokenJuice v0.5.0 generated Pi bundle with one integration rule: results whose executed command starts with `rtk ` bypass TokenJuice. RTK therefore owns commands in its registry; TokenJuice remains the fallback for unsupported commands and its generic reducer.

## Requirements

- [Pi](https://github.com/earendil-works/pi)
- [RTK](https://github.com/rtk-ai/rtk) 0.42.0 or newer, with its Pi adapter configured

## Install

From a Droidworks checkout:

```bash
rtk init --agent pi --global
rtk telemetry disable
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/tokenjuice-rtk" ~/.pi/agent/extensions/tokenjuice-rtk
node --test tokenjuice-rtk/verify.js
```

Use an absolute checkout path when creating the symlink. Run `/reload` in an existing Pi process after installation.

## Verification

The tests prove:

- RTK-prefixed command output receives no TokenJuice result patch.
- Unsupported verbose output still receives TokenJuice compaction.

```bash
node --test tokenjuice-rtk/verify.js
```

Runtime examples:

```bash
rg -n "." a-large-text-file       # RTK history records `rtk rg`; no TokenJuice banner
python3 -c 'for i in range(100): print(i, "detail " * 8)'
                                    # ends with [tokenjuice compacted bash output]
```

## Recovering compacted output

Use compacted Bash output when it contains enough evidence. When omitted detail matters:

1. Read `details.fullOutputPath` or the path shown after `full output:`; this is the primary raw output.
2. Treat `raw artifact: <id>` as a secondary breadcrumb when no readable path is available.
3. Follow any additional recovery hints printed in the tool result.

## Updating

- **RTK:** upgrade through RTK's supported distribution, then rerun `rtk init --agent pi --global`.
- **TokenJuice:** regenerate `index.js`, reapply the `command.trim().startsWith("rtk ")` bypass before normal result handling, then run the verifier.

## Local data

RTK keeps bounded SQLite history and failure tee files according to its configuration. TokenJuice v0.5.0 writes one metadata JSON file per eligible non-RTK result under `~/.tokenjuice/artifacts` and has no retention cleanup. Metadata includes the full command string, so avoid secrets in command arguments and clean this directory deliberately.

## Attribution

`index.js` contains a generated bundle of [TokenJuice v0.5.0](https://github.com/vincentkoc/tokenjuice), modified with the RTK bypass described above. TokenJuice is distributed under the MIT License; see [`LICENSE.tokenjuice`](LICENSE.tokenjuice). RTK is an external dependency and is not redistributed here.
