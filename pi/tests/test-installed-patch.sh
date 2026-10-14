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
(package / "dist/modes/interactive/theme").mkdir(parents=True)
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
    "function createInteractiveTui(terminal, options, theme) {\n" + module.RENDERER_PREVIOUS + "    return null;\n}\n"
)
for name, text in {
    "theme.js": module.THEME_FALLBACK_OLD + module.THEME_BG_KEYS_OLD,
    "theme-json.js": module.THEME_JSON_OLD,
    "theme.d.ts": "\n".join((module.THEME_TYPES_FG_OLD, module.THEME_TYPES_BG_OLD,
                           module.THEME_TYPES_OPTIONAL_FG_OLD, module.THEME_TYPES_OPTIONAL_BG_OLD)),
    "theme-json.d.ts": module.THEME_JSON_TYPES_OLD,
    "theme-schema.json": module.THEME_SCHEMA_OLD,
}.items():
    (package / "dist/modes/interactive/theme" / name).write_text(text)
(package / "dist/bundle/chunks/chunk-fixture.js").write_text(
    "class TuiAltScreen{" + module.BUNDLE_FIELDS_OLD
    + "constructor(options={}){" + module.BUNDLE_CONSTRUCTOR_OLD + "}"
    + module.BUNDLE_HIGHLIGHT_ORIGINAL + "}\n"
    + "function createInteractiveTui(terminal,options,theme){"
    + module.BUNDLE_RENDERER_PREVIOUS + "(text)}}\n"
    + module.BUNDLE_FALLBACK_OLD + module.BUNDLE_BG_KEYS_OLD + module.BUNDLE_JSON_OLD
)
PY

# Pi 0.99 layout: renamed highlight loop variable and background-token set, bundle split across chunks.
V099="$TMP/v099"
cp -R "$PKG" "$V099"
python3 -B - "$PATCHER" "$V099" <<'PY'
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("pi_patcher", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
package = Path(sys.argv[2])
chunks = package / "dist/bundle/chunks"
(chunks / "chunk-fixture.js").unlink()
(chunks / "chunk-tui.js").write_text(
    "class TuiAltScreen{" + module.BUNDLE_FIELDS_OLD
    + "constructor(options={}){" + module.BUNDLE_CONSTRUCTOR_OLD + "}"
    + module.BUNDLE_HIGHLIGHT_ORIGINAL_V099 + "}\n"
    + module.BUNDLE_FALLBACK_OLD + module.BUNDLE_BG_KEYS_V099_OLD + '])\n'
)
(chunks / "chunk-app.js").write_text(
    "function createInteractiveTui(terminal,options,theme){"
    + module.BUNDLE_RENDERER_OLD + "(text)}}\n" + module.BUNDLE_JSON_OLD
)
theme = package / "dist/modes/interactive/theme/theme.js"
theme.write_text(module.THEME_FALLBACK_OLD + module.THEME_BG_KEYS_V099_OLD)
PY
PI_CODING_AGENT_PACKAGE_DIR="$V099" "$PATCHER" | grep -q 'chunk-app.js, .*chunk-tui.js'
PI_CODING_AGENT_PACKAGE_DIR="$V099" "$PATCHER" --check >/dev/null
PI_CODING_AGENT_PACKAGE_DIR="$V099" "$PATCHER" | grep -q 'already applied'
grep -q 'BACKGROUND_TOKENS=new Set(\["selectedBg","fullscreenSelectionColor","searchMatchBg"' "$V099/dist/bundle/chunks/chunk-tui.js"
grep -q '"fullscreenSelectionColor",' "$V099/dist/modes/interactive/theme/theme.js"

# Pi 1.2 layout: one THEME_TOKENS registry replaces the per-file fallbacks, background keys, schema, and types.
V120="$TMP/v120"
cp -R "$PKG" "$V120"
python3 -B - "$PATCHER" "$V120" <<'PY'
import importlib.util
import json
from pathlib import Path
import shutil
import sys

spec = importlib.util.spec_from_file_location("pi_patcher", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
package = Path(sys.argv[2])
(package / "package.json").write_text(json.dumps({"version": "99.1.2", "type": "module"}))
chunks = package / "dist/bundle/chunks"
(chunks / "chunk-fixture.js").unlink()
(chunks / "chunk-tui.js").write_text(
    "class TuiAltScreen{" + module.BUNDLE_FIELDS_OLD
    + "constructor(options={}){" + module.BUNDLE_CONSTRUCTOR_OLD + "}"
    + module.BUNDLE_HIGHLIGHT_ORIGINAL_V099 + "}\n"
    + "var THEME_TOKENS={" + module.BUNDLE_TOKENS_OLD + "};\n"
)
(chunks / "chunk-app.js").write_text(
    "function createInteractiveTui(terminal,options,theme){"
    + module.BUNDLE_RENDERER_OLD + "(text)}}\n"
)
theme = package / "dist/modes/interactive/theme"
shutil.rmtree(theme)
theme.mkdir()
(theme / "theme-tokens.js").write_text("export const THEME_TOKENS = {\n" + module.TOKENS_OLD + "};\n")
(theme / "theme-tokens.d.ts").write_text("export declare const THEME_TOKENS: {\n" + module.TOKENS_DTS_OLD + "};\n")
PY
PI_CODING_AGENT_PACKAGE_DIR="$V120" "$PATCHER" | grep -q 'chunk-app.js, .*chunk-tui.js'
PI_CODING_AGENT_PACKAGE_DIR="$V120" "$PATCHER" --check >/dev/null
PI_CODING_AGENT_PACKAGE_DIR="$V120" "$PATCHER" | grep -q 'already applied'
grep -q 'fullscreenSelectionColor:{slot:"background",.*fallback:"selectedBg"}' "$V120/dist/bundle/chunks/chunk-tui.js"
node --input-type=module -e '
const { THEME_TOKENS } = await import(process.argv[1]);
if (THEME_TOKENS.fullscreenSelectionColor.fallback !== "selectedBg" || THEME_TOKENS.fullscreenSelectionTextColor.slot !== "foreground") process.exit(1);
' "$V120/dist/modes/interactive/theme/theme-tokens.js"

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

grep -q 'theme.bg("fullscreenSelectionColor", theme.fg("fullscreenSelectionTextColor", text))' "$PKG/dist/modes/interactive/tui-renderer.js"
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
old = 'selectionStyle: (text) => theme.bg("fullscreenSelectionColor", theme.fg("fullscreenSelectionTextColor", text)),'
assert text.count(old) == 1
path.write_text(text.replace(old, "selectionStyle: (text) => text,", 1))
PY
if PI_CODING_AGENT_PACKAGE_DIR="$TMP/changed-shape" "$PATCHER" --check >/dev/null 2>&1; then
  echo "expected changed source shape check to fail" >&2
  exit 1
fi

echo "✓ Pi installed-package theme patch regression tests passed"
