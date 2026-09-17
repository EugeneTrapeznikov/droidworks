# TokenJuice + RTK

Layered Bash-output compaction for Pi without double filtering:

```text
Pi tool_call → RTK rewrites supported commands → command executes
Pi tool_result → TokenJuice handles only results not prefixed by rtk
```

This capability keeps TokenJuice and the RTK integration separate. It pins the official TokenJuice package, generates TokenJuice's official Pi extension, then applies one guarded integration rule: commands beginning with `rtk ` bypass TokenJuice. RTK owns commands in its registry; TokenJuice remains the fallback for unsupported commands and its generic reducer.

No generated TokenJuice bundle is stored in Droidworks.

## Requirements

- [Pi](https://github.com/earendil-works/pi)
- Node.js 20 or newer and npm
- [RTK](https://github.com/rtk-ai/rtk) 0.42.0 or newer, with its Pi adapter configured

TokenJuice 0.8.5 is an exact npm dependency installed locally by this capability.

## Install

From the Droidworks repository root:

```bash
rtk init --agent pi --global
rtk telemetry disable
tokenjuice-rtk/scripts/install.sh
```

The installer:

1. Installs the exact TokenJuice dependency from `package-lock.json` without lifecycle scripts.
2. Runs the official TokenJuice Pi generator.
3. Applies a version- and source-shape-guarded RTK bypass.
4. Removes the managed `tokenjuice-rtk` directory symlink used by the bundled integration.
5. Verifies the generated extension.

The generated runtime lives at `~/.pi/agent/extensions/tokenjuice.js`. Run `/reload` in an existing Pi process after installation.

## Verification

```bash
(cd tokenjuice-rtk && npm test)
python3 tokenjuice-rtk/scripts/apply-rtk-bypass.py --check \
  ~/.pi/agent/extensions/tokenjuice.js
```

The tests prove:

- The official TokenJuice 0.8.5 generator remains compatible with the guarded patch.
- RTK-prefixed command output receives no TokenJuice result patch.
- Unsupported verbose output still receives TokenJuice compaction and metadata.

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
- **TokenJuice:** update the exact dependency and lockfile, regenerate the official extension, update the guarded patch if its source shape changed, then run the verifier.

## Local data

RTK keeps bounded SQLite history and failure tee files according to its configuration. TokenJuice writes bounded statistics metadata by default and supports opt-in raw artifact storage. Metadata can include command strings; set `TOKENJUICE_STATS=off` in the Pi process environment to disable statistics writes.

## Upstream status

The RTK bypass is maintained as a guarded generated-extension patch until TokenJuice offers a native command-skip option. Once upstream support is available, the patcher can be removed while retaining the same behavioral tests.
