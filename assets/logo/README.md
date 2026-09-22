# Droidworks wordmark

The README uses transparent SVGs selected by GitHub's light/dark theme. File names refer to the page theme: `droidworks-light.svg` uses charcoal letters; `droidworks-dark.svg` uses off-white letters. Both use monochrome letters with gray fill. The initial `d` starts at the left image edge; the other sides retain one cell of transparent padding.

Edit `glyphs.json`, then regenerate from the repository root with Python 3 (standard library only):

```sh
python3 assets/logo/generate.py
```

Bodies default to 5 rows × 4 columns. `i` is 3 columns wide with a left shoulder and full-width base; `w` is 5 columns wide with a solid bottom row. Both `r` positions use the block uppercase `R`. The `k` uses the approved heavier avatar glyph with thicker arms and center. `above` and `below` support extra rows. Gray fills every empty cell in the bottom three body rows; letter pixels take priority. Keep this fill rule when editing glyphs.

The generator validates dimensions, letter order, and cell coverage in each saved SVG. All pixels are SVG rectangles; no fonts or external resources are required.
