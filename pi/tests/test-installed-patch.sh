#!/usr/bin/env bash
set -euo pipefail

PI_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATCHER="$PI_ROOT/scripts/apply-installed-patches.py"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/pi-coding-agent"

python3 -B - "$PATCHER" "$PKG" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys

patcher_path = Path(sys.argv[1])
package = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi_patcher", patcher_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)

(package / "dist/bundle/chunks").mkdir(parents=True)
(package / "dist/modes/interactive").mkdir(parents=True)
(package / "node_modules/@earendil-works/pi-tui/dist").mkdir(parents=True)
(package / "package.json").write_text(json.dumps({"version": "99.1.2"}))
(package / "node_modules/@earendil-works/pi-tui/package.json").write_text(
    json.dumps({"version": "88.7.6", "type": "module"})
)
(package / "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js").write_text(
    r'''function extractAnsiCode(text, index) {
    if (text[index] !== "\x1b") return undefined;
    if (text[index + 1] === "[") {
        const match = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (match) return { code: match[0], length: match[0].length };
    }
    if (text[index + 1] === "]") {
        const rest = text.slice(index);
        const bell = rest.indexOf("\x07", 2);
        const stringTerminator = rest.indexOf("\x1b\\", 2);
        const end = bell >= 0 && (stringTerminator < 0 || bell < stringTerminator) ? bell + 1 : stringTerminator + 2;
        if (end > 1) return { code: rest.slice(0, end), length: end };
    }
    return undefined;
}
export class TuiAltScreen {
''' + module.MODULE_FIELDS_OLD + r'''    constructor(options = {}) {
''' + module.MODULE_CONSTRUCTOR_OLD + r'''    }
''' + module.MODULE_HIGHLIGHT_ORIGINAL + "}\n"
)
(package / "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.d.ts").write_text(
    "export interface TuiAltScreenOptions {\n" + module.DTS_OPTION_OLD + "}\n"
    "export declare class TuiAltScreen {\n" + module.DTS_FIELD_OLD + "}\n"
)
(package / "dist/modes/interactive/tui-renderer.js").write_text(
    "function createInteractiveTui(terminal, options, theme) {\n" + module.RENDERER_OLD + "    return null;\n}\n"
)
(package / "dist/bundle/chunks/chunk-fixture.js").write_text(
    "class TuiAltScreen{" + module.BUNDLE_FIELDS_OLD
    + "constructor(options={}){" + module.BUNDLE_CONSTRUCTOR_OLD + "}"
    + module.BUNDLE_HIGHLIGHT_ORIGINAL + "}\n"
    + "function createInteractiveTui(terminal,options,theme){"
    + module.BUNDLE_RENDERER_OLD + "(text)}}\n"
)
PY

PI_CODING_AGENT_PACKAGE_DIR="$PKG" "$PATCHER"
PI_CODING_AGENT_PACKAGE_DIR="$PKG" "$PATCHER" --check
PI_CODING_AGENT_PACKAGE_DIR="$PKG" "$PATCHER" | grep -q 'already applied'

node --input-type=module - "$PKG" <<'JS'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const packageDir = process.argv[2];
const modulePath = path.join(packageDir, "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js");
const { TuiAltScreen } = await import(pathToFileURL(modulePath));
const themed = new TuiAltScreen({ selectionStyle: (text) => `<selection>${text}</selection>` });
const highlight = (text) => themed.applySelectionHighlight(text);

assert.equal(highlight("plain"), "<selection>plain</selection>");
assert.equal(highlight("你界"), "<selection>你界</selection>");
assert.equal(
  highlight("a\x1b[0mb"),
  "<selection>a</selection>\x1b[0m<selection>b</selection>",
);
assert.equal(
  highlight("a\x1b[31mb\x1b[39mc"),
  "<selection>a</selection>\x1b[31m<selection>b</selection>\x1b[39m<selection>c</selection>",
);
const link = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
assert.equal(
  highlight(link),
  "\x1b]8;;https://example.com\x1b\\<selection>link</selection>\x1b]8;;\x1b\\",
);

const fallback = new TuiAltScreen();
assert.equal(fallback.applySelectionHighlight("plain"), "\x1b[7mplain\x1b[27m");
JS

grep -q 'theme.bg("selectedBg", theme.fg("text", text))' "$PKG/dist/modes/interactive/tui-renderer.js"
! grep -R -q '215;218;224;48;2;62;68;81' \
  "$PKG/dist/modes/interactive/tui-renderer.js" \
  "$PKG/dist/bundle/chunks" \
  "$PKG/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"

cp -R "$PKG" "$TMP/changed-shape"
python3 - "$TMP/changed-shape/dist/modes/interactive/tui-renderer.js" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old = 'selectionStyle: (text) => theme.bg("selectedBg", theme.fg("text", text)),'
assert text.count(old) == 1
path.write_text(text.replace(old, "selectionStyle: (text) => text,", 1))
PY
if PI_CODING_AGENT_PACKAGE_DIR="$TMP/changed-shape" "$PATCHER" --check >/dev/null 2>&1; then
  echo "expected changed source shape check to fail" >&2
  exit 1
fi

echo "✓ Pi installed-package theme patch regression tests passed"
