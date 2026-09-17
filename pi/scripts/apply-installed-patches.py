#!/usr/bin/env python3
"""Apply Droidworks' guarded patches to an installed Pi npm package."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

SUPPORTED_PI_VERSION = "0.85.1"
SUPPORTED_TUI_VERSION = "0.85.1"

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
RENDERER_NEW = '''        return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
            selectionStyle: (text) => theme.bg("selectedBg", theme.fg("text", text)),
            searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
'''

BUNDLE_FIELDS_OLD = "searchMatchStyle;searchCurrentMatchStyle;searchNavigationButtonStyle;scrollToEndIndicator;"
BUNDLE_FIELDS_NEW = "searchMatchStyle;searchCurrentMatchStyle;searchNavigationButtonStyle;selectionStyle;scrollToEndIndicator;"
BUNDLE_CONSTRUCTOR_OLD = r'''this.searchNavigationButtonStyle=options.searchNavigationButtonStyle??(text=>text),this.scrollToEndIndicator=options.scrollToEndIndicator'''
BUNDLE_CONSTRUCTOR_NEW = r'''this.searchNavigationButtonStyle=options.searchNavigationButtonStyle??(text=>text),this.selectionStyle=options.selectionStyle??(text=>`\x1B[7m${text}\x1B[27m`),this.scrollToEndIndicator=options.scrollToEndIndicator'''
BUNDLE_HIGHLIGHT_ORIGINAL = r'''applySelectionHighlight(text){let result="\x1B[7m",index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){result+=text[index3],index3+=1;continue}result+=ansi.code,ansi.code.endsWith("m")&&(result+="\x1B[7m"),index3+=ansi.length}return`${result}\x1B[27m`}'''
BUNDLE_HIGHLIGHT_HARDCODED = r'''applySelectionHighlight(text){let selectionStyle="\x1B[38;2;215;218;224;48;2;62;68;81m",result=selectionStyle,index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){result+=text[index3],index3+=1;continue}result+=ansi.code,ansi.code.endsWith("m")&&(result+=selectionStyle),index3+=ansi.length}return`${result}\x1B[39;49m`}'''
BUNDLE_HIGHLIGHT_NEW = r'''applySelectionHighlight(text){let result="",plainStart=0,index3=0;for(;index3<text.length;){let ansi=extractAnsiCode(text,index3);if(!ansi){index3+=1;continue}index3>plainStart&&(result+=this.selectionStyle(text.slice(plainStart,index3))),result+=ansi.code,index3+=ansi.length,plainStart=index3}return plainStart<text.length&&(result+=this.selectionStyle(text.slice(plainStart))),result}'''
BUNDLE_RENDERER_OLD = '''return new TuiAltScreen(terminal,options.showHardwareCursor,options.logDirectory,{searchMatchStyle:text=>theme.underline'''
BUNDLE_RENDERER_NEW = '''return new TuiAltScreen(terminal,options.showHardwareCursor,options.logDirectory,{selectionStyle:text=>theme.bg("selectedBg",theme.fg("text",text)),searchMatchStyle:text=>theme.underline'''


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
    if patched_count == 1 and sum(original_counts) == 0:
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
    if pi_version != SUPPORTED_PI_VERSION:
        fail(f"unsupported pi-coding-agent version: {pi_version} (expected {SUPPORTED_PI_VERSION})")

    tui_dir = package_dir / "node_modules/@earendil-works/pi-tui"
    tui_version = read_version(tui_dir / "package.json", "pi-tui")
    if tui_version != SUPPORTED_TUI_VERSION:
        fail(f"unsupported pi-tui version: {tui_version} (expected {SUPPORTED_TUI_VERSION})")

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
        (renderer, (RENDERER_OLD,), RENDERER_NEW, "coding-agent theme wiring"),
        (bundle, (BUNDLE_FIELDS_OLD,), BUNDLE_FIELDS_NEW, "bundled selection field"),
        (bundle, (BUNDLE_CONSTRUCTOR_OLD,), BUNDLE_CONSTRUCTOR_NEW, "bundled selection option"),
        (bundle, (BUNDLE_HIGHLIGHT_ORIGINAL, BUNDLE_HIGHLIGHT_HARDCODED), BUNDLE_HIGHLIGHT_NEW, "bundled selection renderer"),
        (bundle, (BUNDLE_RENDERER_OLD,), BUNDLE_RENDERER_NEW, "bundled theme wiring"),
    ]
    statuses = [replace_alternative(path, originals, patched, args.check, label) for path, originals, patched, label in changes]
    action = "verified" if args.check else ("applied" if "applied" in statuses else "already applied")
    print(f"✓ {action} Pi {pi_version} theme-driven fullscreen selection")
    print(f"  runtime: {bundle}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
