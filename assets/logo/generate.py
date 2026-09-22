"""Generate editable, font-free SVG wordmarks from glyphs.json. Python 3 stdlib only."""

import json
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
CONFIG = json.loads((HERE / "glyphs.json").read_text())
GLYPHS = CONFIG["glyphs"]
WORD = CONFIG["word"]
CELL = CONFIG["cell_size"]
BODY = CONFIG["body_height"]
GRAY_ROWS = CONFIG["gray_rows"]
GAP = CONFIG["letter_gap"]
PALETTES = {
    "light": {"background": "#f4f4f4", "ink": "#1e1e1e", "gray": "#999999"},
    "dark": {"background": "#1e1e1e", "ink": "#f4f4f4", "gray": "#595959"},
}


def width(glyph):
    return glyph.get("width", CONFIG["default_width"])


def element(parent, name, **attributes):
    return ET.SubElement(parent, f"{{{NS}}}{name}", {k: str(v) for k, v in attributes.items()})


def validate_config():
    assert BODY == 5 and CONFIG["default_width"] == 4
    assert 0 < GRAY_ROWS <= BODY
    for letter in WORD:
        glyph = GLYPHS[letter]
        assert len(glyph["body"]) == BODY, letter
        for row in glyph.get("above", []) + glyph["body"] + glyph.get("below", []):
            assert len(row) == width(glyph) and set(row) <= {"0", "1"}, (letter, row)


validate_config()
ASCENT = max(len(GLYPHS[c].get("above", [])) for c in WORD)
DESCENT = max(len(GLYPHS[c].get("below", [])) for c in WORD)
WORD_WIDTH = sum(width(GLYPHS[c]) for c in WORD) + GAP * (len(WORD) - 1)
PANEL_WIDTH = (WORD_WIDTH + 8) * CELL
PANEL_HEIGHT = (ASCENT + BODY + DESCENT + 8) * CELL


def make_svg(columns=1, rows=1):
    root = ET.Element(f"{{{NS}}}svg", {
        "width": str(PANEL_WIDTH * columns), "height": str(PANEL_HEIGHT * rows),
        "viewBox": f"0 0 {PANEL_WIDTH * columns} {PANEL_HEIGHT * rows}",
        "shape-rendering": "crispEdges", "role": "img", "aria-label": WORD,
    })
    element(root, "title").text = "droidworks — pixel wordmark"
    element(root, "desc").text = (
        "Five-row letter bodies with a default width of four columns, per-letter width overrides, and optional ascenders and descenders. "
        "Gray fills all unoccupied cells in the bottom three body rows."
    )
    return root


def panel(root, theme, accented, offset_x=0, offset_y=0, transparent=False):
    palette = PALETTES[theme]
    outer = element(root, "g", transform=f"translate({offset_x} {offset_y})")
    if not transparent:
        element(outer, "rect", width=PANEL_WIDTH, height=PANEL_HEIGHT, fill=palette["background"])
    word = element(outer, "g", transform=f"translate({4 * CELL} {(4 + ASCENT) * CELL})")
    x_offset = 0
    for index, letter in enumerate(WORD):
        glyph = GLYPHS[letter]
        group = element(word, "g", transform=f"translate({x_offset * CELL} 0)",
                        **{"data-letter": letter, "data-index": index})
        ink = "#14813d" if accented and letter == CONFIG["accent_letter"] else palette["ink"]
        above = glyph.get("above", [])
        rows = above + glyph["body"] + glyph.get("below", [])
        for row_index, row in enumerate(rows):
            y = row_index - len(above)
            for x, occupied in enumerate(row):
                is_gray = occupied == "0" and BODY - GRAY_ROWS <= y < BODY
                if occupied == "1" or is_gray:
                    element(group, "rect", x=x * CELL, y=y * CELL, width=CELL, height=CELL,
                            fill=palette["gray"] if is_gray else ink,
                            **{"data-cell": f"{x},{y}", "data-layer": "gray" if is_gray else "ink"})
        x_offset += width(glyph) + GAP


def verify_svg(root):
    """Check actual output cells against glyph masks and the gray-fill rule."""
    groups = [node for node in root.iter() if "data-letter" in node.attrib]
    assert len(groups) % len(WORD) == 0
    assert "".join(g.attrib["data-letter"] for g in groups) == WORD * (len(groups) // len(WORD))
    for group in groups:
        glyph = GLYPHS[group.attrib["data-letter"]]
        cells = {tuple(map(int, r.attrib["data-cell"].split(","))): r.attrib["data-layer"] for r in group}
        assert len(cells) == len(group), "Overlapping cells"
        above = glyph.get("above", [])
        for row_index, row in enumerate(above + glyph["body"] + glyph.get("below", [])):
            y = row_index - len(above)
            for x, occupied in enumerate(row):
                expected = "ink" if occupied == "1" else "gray" if BODY - GRAY_ROWS <= y < BODY else None
                assert cells.get((x, y)) == expected, (group.attrib["data-letter"], x, y)


def save(root, filename):
    verify_svg(root)
    ET.indent(root, space="  ")
    path = HERE / filename
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    verify_svg(ET.parse(path).getroot())
    print(f"Verified {path.name}")


def main():
    for theme in ("light", "dark"):
        root = make_svg()
        # Start at the first letter; keep one cell of padding on the other sides.
        margin = 3 * CELL
        left = 4 * CELL
        root.set("viewBox", f"{left} {margin} {PANEL_WIDTH - left - margin} {PANEL_HEIGHT - 2 * margin}")
        root.set("width", str(PANEL_WIDTH - left - margin))
        root.set("height", str(PANEL_HEIGHT - 2 * margin))
        panel(root, theme, accented=False, transparent=True)
        save(root, f"droidworks-{theme}.svg")


if __name__ == "__main__":
    main()
