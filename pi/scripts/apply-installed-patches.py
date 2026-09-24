#!/usr/bin/env python3
"""Apply Droidworks' guarded patches to an installed Pi npm package."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

MODULE_FIELDS_OLD = '''    searchCurrentMatchStyle;
    searchNavigationButtonStyle;
    scrollToEndIndicator;
'''
MODULE_FIELDS_NEW = '''    searchCurrentMatchStyle;
    searchNavigationButtonStyle;
    selectionStyle;
    scrollToEndIndicator;
'''
MODULE_CONSTRUCTOR_OLD = r'''        this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
        this.scrollToEndIndicator = options.scrollToEndIndicator;
'''
MODULE_CONSTRUCTOR_NEW = r'''        this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
        this.selectionStyle = options.selectionStyle ?? ((text) => `\x1b[7m${text}\x1b[27m`);
        this.scrollToEndIndicator = options.scrollToEndIndicator;
'''
MODULE_HIGHLIGHT_ORIGINAL = r'''    applySelectionHighlight(text) {
        let result = "\x1b[7m";
        let index = 0;
        while (index < text.length) {
            const ansi = extractAnsiCode(text, index);
            if (!ansi) {
                result += text[index];
                index += 1;
                continue;
            }
            result += ansi.code;
            if (ansi.code.endsWith("m"))
                result += "\x1b[7m";
            index += ansi.length;
        }
        return `${result}\x1b[27m`;
    }
'''
MODULE_HIGHLIGHT_HARDCODED = r'''    applySelectionHighlight(text) {
        const selectionStyle = "\x1b[38;2;215;218;224;48;2;62;68;81m";
        let result = selectionStyle;
        let index = 0;
        while (index < text.length) {
            const ansi = extractAnsiCode(text, index);
            if (!ansi) {
                result += text[index];
                index += 1;
                continue;
            }
            result += ansi.code;
            if (ansi.code.endsWith("m"))
                result += selectionStyle;
            index += ansi.length;
        }
        return `${result}\x1b[39;49m`;
    }
'''
MODULE_HIGHLIGHT_NEW = r'''    applySelectionHighlight(text) {
        let result = "";
        let plainStart = 0;
        let index = 0;
        while (index < text.length) {
            const ansi = extractAnsiCode(text, index);
            if (!ansi) {
                index += 1;
                continue;
            }
            if (index > plainStart)
                result += this.selectionStyle(text.slice(plainStart, index));
            result += ansi.code;
            index += ansi.length;
            plainStart = index;
        }
        if (plainStart < text.length)
            result += this.selectionStyle(text.slice(plainStart));
        return result;
    }
'''

DTS_OPTION_OLD = '''    /** Capture mouse events for viewport scrolling and application-owned text selection. */
    mouse?: boolean;
    /** Style a non-current transcript search match. */
'''
DTS_OPTION_NEW = '''    /** Capture mouse events for viewport scrolling and application-owned text selection. */
    mouse?: boolean;
    /** Style application-owned transcript selection text. */
    selectionStyle?: (text: string) => string;
    /** Style a non-current transcript search match. */
'''
DTS_FIELD_OLD = '''    private readonly searchNavigationButtonStyle;
    private readonly scrollToEndIndicator?;
'''
DTS_FIELD_NEW = '''    private readonly searchNavigationButtonStyle;
    private readonly selectionStyle;
    private readonly scrollToEndIndicator?;
'''

RENDERER_OLD = '''        return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
            searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
'''
RENDERER_PREVIOUS = RENDERER_OLD.replace(
    '            searchMatchStyle:',
    '            selectionStyle: (text) => theme.bg("selectedBg", theme.fg("text", text)),\n            searchMatchStyle:',
)
RENDERER_NEW = RENDERER_OLD.replace(
    '            searchMatchStyle:',
    '            selectionStyle: (text) => theme.bg("fullscreenSelectionColor", theme.fg("fullscreenSelectionTextColor", text)),\n            searchMatchStyle:',
)

THEME_FALLBACK_OLD = '''        searchMatchText: colors.searchMatchText ?? colors.text,
'''
THEME_FALLBACK_NEW = THEME_FALLBACK_OLD + '''        fullscreenSelectionColor: colors.fullscreenSelectionColor ?? colors.selectedBg,
        fullscreenSelectionTextColor: colors.fullscreenSelectionTextColor ?? colors.text,
'''
THEME_BG_KEYS_OLD = '''        "selectedBg",
        "searchMatchBg",
'''
THEME_BG_KEYS_NEW = '''        "selectedBg",
        "fullscreenSelectionColor",
        "searchMatchBg",
'''
THEME_JSON_OLD = '''        selectedBg: ColorValueSchema,
        searchMatchBg: Type.Optional(ColorValueSchema),
'''
THEME_JSON_NEW = '''        selectedBg: ColorValueSchema,
        fullscreenSelectionColor: Type.Optional(ColorValueSchema),
        fullscreenSelectionTextColor: Type.Optional(ColorValueSchema),
        searchMatchBg: Type.Optional(ColorValueSchema),
'''
THEME_TYPES_FG_OLD = '"thinkingText" | "scrollbarTrack"'
THEME_TYPES_FG_NEW = '"thinkingText" | "fullscreenSelectionTextColor" | "scrollbarTrack"'
THEME_TYPES_BG_OLD = '"selectedBg" | "searchMatchBg"'
THEME_TYPES_BG_NEW = '"selectedBg" | "fullscreenSelectionColor" | "searchMatchBg"'
THEME_TYPES_OPTIONAL_FG_OLD = '"thinkingMax" | "searchMatchText"'
THEME_TYPES_OPTIONAL_FG_NEW = '"thinkingMax" | "searchMatchText" | "fullscreenSelectionTextColor"'
THEME_TYPES_OPTIONAL_BG_OLD = 'type OptionalThemeBg = "searchMatchBg";'
THEME_TYPES_OPTIONAL_BG_NEW = 'type OptionalThemeBg = "searchMatchBg" | "fullscreenSelectionColor";'
THEME_JSON_TYPES_OLD = '        selectedBg: Type.TUnion<[Type.TString, Type.TInteger]>;'
THEME_JSON_TYPES_NEW = THEME_JSON_TYPES_OLD + '''
        fullscreenSelectionColor: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;
        fullscreenSelectionTextColor: Type.TOptional<Type.TUnion<[Type.TString, Type.TInteger]>>;'''
THEME_SCHEMA_OLD = '''\t\t\t\t"selectedBg": {
\t\t\t\t\t"$ref": "#/$defs/colorValue",
\t\t\t\t\t"description": "Selected item background"
\t\t\t\t},
'''
THEME_SCHEMA_NEW = THEME_SCHEMA_OLD + '''\t\t\t\t"fullscreenSelectionColor": {
\t\t\t\t\t"$ref": "#/$defs/colorValue",
\t\t\t\t\t"description": "Fullscreen transcript selection background (falls back to selectedBg)"
\t\t\t\t},
\t\t\t\t"fullscreenSelectionTextColor": {
\t\t\t\t\t"$ref": "#/$defs/colorValue",
\t\t\t\t\t"description": "Fullscreen transcript selection text (falls back to text)"
\t\t\t\t},
'''

BUNDLE_FIELDS_OLD = "searchMatchStyle;searchCurrentMatchStyle;searchNavigationButtonStyle;scrollToEndIndicator;"
BUNDLE_FIELDS_NEW = "searchMatchStyle;searchCurrentMatchStyle;searchNavigationButtonStyle;selectionStyle;scrollToEndIndicator;"
BUNDLE_CONSTRUCTOR_OLD = r'''this.searchNavigationButtonStyle=options.searchNavigationButtonStyle??(text=>text),this.scrollToEndIndicator=options.scrollToEndIndicator'''
BUNDLE_CONSTRUCTOR_NEW = r'''this.searchNavigationButtonStyle=options.searchNavigationButtonStyle??(text=>text),this.selectionStyle=options.selectionStyle??(text=>`\x1B[7m${text}\x1B[27m`),this.scrollToEndIndicator=options.scrollToEndIndicator'''
BUNDLE_HIGHLIGHT_ORIGINAL = r'''applySelectionHighlight(text){let result="\x1B[7m",index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){result+=text[index3],index3+=1;continue}result+=ansi.code,ansi.code.endsWith("m")&&(result+="\x1B[7m"),index3+=ansi.length}return`${result}\x1B[27m`}'''
BUNDLE_HIGHLIGHT_HARDCODED = r'''applySelectionHighlight(text){let selectionStyle="\x1B[38;2;215;218;224;48;2;62;68;81m",result=selectionStyle,index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){result+=text[index3],index3+=1;continue}result+=ansi.code,ansi.code.endsWith("m")&&(result+=selectionStyle),index3+=ansi.length}return`${result}\x1B[39;49m`}'''
BUNDLE_HIGHLIGHT_NEW = r'''applySelectionHighlight(text){let result="",plainStart=0,index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){index3+=1;continue}index3>plainStart&&(result+=this.selectionStyle(text.slice(plainStart,index3))),result+=ansi.code,index3+=ansi.length,plainStart=index3}return plainStart<text.length&&(result+=this.selectionStyle(text.slice(plainStart))),result}'''
BUNDLE_RENDERER_OLD = '''return new TuiAltScreen(terminal,options.showHardwareCursor,options.logDirectory,{searchMatchStyle:text=>theme.underline'''
BUNDLE_RENDERER_PREVIOUS = BUNDLE_RENDERER_OLD.replace(
    'searchMatchStyle:', 'selectionStyle:text=>theme.bg("selectedBg",theme.fg("text",text)),searchMatchStyle:'
)
BUNDLE_RENDERER_NEW = BUNDLE_RENDERER_OLD.replace(
    'searchMatchStyle:', 'selectionStyle:text=>theme.bg("fullscreenSelectionColor",theme.fg("fullscreenSelectionTextColor",text)),searchMatchStyle:'
)
BUNDLE_FALLBACK_OLD = 'searchMatchText:colors.searchMatchText??colors.text}}'
BUNDLE_FALLBACK_NEW = 'searchMatchText:colors.searchMatchText??colors.text,fullscreenSelectionColor:colors.fullscreenSelectionColor??colors.selectedBg,fullscreenSelectionTextColor:colors.fullscreenSelectionTextColor??colors.text}}'
BUNDLE_BG_KEYS_OLD = 'bgColorKeys=new Set(["selectedBg","searchMatchBg"'
BUNDLE_BG_KEYS_NEW = 'bgColorKeys=new Set(["selectedBg","fullscreenSelectionColor","searchMatchBg"'
BUNDLE_JSON_OLD = 'selectedBg:ColorValueSchema,searchMatchBg:typebox_exports.Optional(ColorValueSchema)'
BUNDLE_JSON_NEW = 'selectedBg:ColorValueSchema,fullscreenSelectionColor:typebox_exports.Optional(ColorValueSchema),fullscreenSelectionTextColor:typebox_exports.Optional(ColorValueSchema),searchMatchBg:typebox_exports.Optional(ColorValueSchema)'


def fail(message: str) -> "None":
    raise SystemExit(f"✗ {message}")


def package_dir_from_pi() -> Path:
    override = os.environ.get("PI_CODING_AGENT_PACKAGE_DIR")
    if override:
        return Path(override).expanduser().resolve()

    executable = shutil.which("pi")
    if not executable:
        fail("pi executable not found")
    cli = Path(executable).resolve()
    if cli.name != "cli.js" or cli.parent.name != "bundle" or cli.parent.parent.name != "dist":
        fail(f"unsupported pi executable layout: {cli}")
    return cli.parents[2]


def read_version(path: Path, label: str) -> str:
    if not path.is_file():
        fail(f"{label} package missing: {path}")
    try:
        return json.loads(path.read_text())["version"]
    except (json.JSONDecodeError, KeyError) as error:
        fail(f"cannot read {label} version from {path}: {error}")


def replace_alternative(path: Path, originals: tuple[str, ...], patched: str, check: bool, label: str) -> str:
    if not path.is_file():
        fail(f"patch target missing: {path}")
    text = path.read_text()
    patched_count = text.count(patched)
    original_counts = [text.count(original) for original in originals]
    if patched_count == 1 and all(text.count(original) == patched.count(original) for original in originals):
        return "verified"
    if patched_count != 0 or sum(original_counts) != 1:
        fail(
            f"{path} has an unsupported {label} shape "
            f"(originals={original_counts}, patched={patched_count})"
        )
    if check:
        fail(f"fullscreen selection theme patch is not applied ({label}): {path}")
    original = originals[original_counts.index(1)]
    path.write_text(text.replace(original, patched, 1))
    return "applied"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify without modifying files")
    args = parser.parse_args()

    package_dir = package_dir_from_pi()
    pi_version = read_version(package_dir / "package.json", "pi-coding-agent")
    tui_dir = package_dir / "node_modules/@earendil-works/pi-tui"
    tui_version = read_version(tui_dir / "package.json", "pi-tui")

    module = tui_dir / "dist/tui-alt-screen.js"
    declaration = tui_dir / "dist/tui-alt-screen.d.ts"
    renderer = package_dir / "dist/modes/interactive/tui-renderer.js"
    chunks = list((package_dir / "dist/bundle/chunks").glob("*.js"))
    bundle_matches = [
        chunk for chunk in chunks
        if any(marker in chunk.read_text() for marker in (
            BUNDLE_HIGHLIGHT_ORIGINAL,
            BUNDLE_HIGHLIGHT_HARDCODED,
            BUNDLE_HIGHLIGHT_NEW,
        ))
    ]
    if len(bundle_matches) != 1:
        fail(f"expected one bundled fullscreen selection target, found {len(bundle_matches)}")
    bundle = bundle_matches[0]

    changes = [
        (module, (MODULE_FIELDS_OLD,), MODULE_FIELDS_NEW, "pi-tui selection field"),
        (module, (MODULE_CONSTRUCTOR_OLD,), MODULE_CONSTRUCTOR_NEW, "pi-tui selection option"),
        (module, (MODULE_HIGHLIGHT_ORIGINAL, MODULE_HIGHLIGHT_HARDCODED), MODULE_HIGHLIGHT_NEW, "pi-tui selection renderer"),
        (declaration, (DTS_OPTION_OLD,), DTS_OPTION_NEW, "pi-tui selection option declaration"),
        (declaration, (DTS_FIELD_OLD,), DTS_FIELD_NEW, "pi-tui selection field declaration"),
        (renderer, (RENDERER_OLD, RENDERER_PREVIOUS), RENDERER_NEW, "coding-agent theme wiring"),
        (package_dir / "dist/modes/interactive/theme/theme.js", (THEME_FALLBACK_OLD,), THEME_FALLBACK_NEW, "theme selection fallbacks"),
        (package_dir / "dist/modes/interactive/theme/theme.js", (THEME_BG_KEYS_OLD,), THEME_BG_KEYS_NEW, "theme selection background"),
        (package_dir / "dist/modes/interactive/theme/theme-json.js", (THEME_JSON_OLD,), THEME_JSON_NEW, "theme selection roles"),
        (package_dir / "dist/modes/interactive/theme/theme.d.ts", (THEME_TYPES_FG_OLD,), THEME_TYPES_FG_NEW, "theme foreground type"),
        (package_dir / "dist/modes/interactive/theme/theme.d.ts", (THEME_TYPES_BG_OLD,), THEME_TYPES_BG_NEW, "theme background type"),
        (package_dir / "dist/modes/interactive/theme/theme.d.ts", (THEME_TYPES_OPTIONAL_FG_OLD,), THEME_TYPES_OPTIONAL_FG_NEW, "optional theme foreground type"),
        (package_dir / "dist/modes/interactive/theme/theme.d.ts", (THEME_TYPES_OPTIONAL_BG_OLD,), THEME_TYPES_OPTIONAL_BG_NEW, "optional theme background type"),
        (package_dir / "dist/modes/interactive/theme/theme-json.d.ts", (THEME_JSON_TYPES_OLD,), THEME_JSON_TYPES_NEW, "theme JSON types"),
        (package_dir / "dist/modes/interactive/theme/theme-schema.json", (THEME_SCHEMA_OLD,), THEME_SCHEMA_NEW, "theme JSON schema"),
        (bundle, (BUNDLE_FIELDS_OLD,), BUNDLE_FIELDS_NEW, "bundled selection field"),
        (bundle, (BUNDLE_CONSTRUCTOR_OLD,), BUNDLE_CONSTRUCTOR_NEW, "bundled selection option"),
        (bundle, (BUNDLE_HIGHLIGHT_ORIGINAL, BUNDLE_HIGHLIGHT_HARDCODED), BUNDLE_HIGHLIGHT_NEW, "bundled selection renderer"),
        (bundle, (BUNDLE_RENDERER_OLD, BUNDLE_RENDERER_PREVIOUS), BUNDLE_RENDERER_NEW, "bundled theme wiring"),
        (bundle, (BUNDLE_FALLBACK_OLD,), BUNDLE_FALLBACK_NEW, "bundled selection fallbacks"),
        (bundle, (BUNDLE_BG_KEYS_OLD,), BUNDLE_BG_KEYS_NEW, "bundled selection background"),
        (bundle, (BUNDLE_JSON_OLD,), BUNDLE_JSON_NEW, "bundled selection roles"),
    ]
    statuses = [replace_alternative(path, originals, patched, args.check, label) for path, originals, patched, label in changes]
    action = "verified" if args.check else ("applied" if "applied" in statuses else "already applied")
    print(f"✓ {action} Pi {pi_version} / TUI {tui_version} theme-driven fullscreen selection")
    print(f"  runtime: {bundle}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
