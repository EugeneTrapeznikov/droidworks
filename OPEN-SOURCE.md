# Open source

I start with software I actually use.

When I encounter friction, I first make the smallest local change that improves my workflow. The change gets tests, version guards, and a reproducible installer so I can keep using it safely across updates.

If the improvement generalizes beyond my setup, I contribute it upstream. Droidworks keeps the change useful while that conversation happens.

## Pi: selection that follows the theme

Pi's fullscreen selection used terminal reverse video regardless of the active theme. I added a selection styling interface, connected it to Pi's semantic theme colors, and preserved reverse video as the default for other consumers.

The installed-package patch is version- and source-shape-guarded. It fails closed after unsupported upgrades instead of silently rewriting unknown code.

[Implementation](pi/) · [Upstream proposal](https://github.com/earendil-works/pi/issues/9715)

## TokenJuice + RTK: one optimizer per command

RTK and TokenJuice both reduce verbose command output. Running both naively can process the same result twice.

The integration lets RTK own supported commands while TokenJuice remains the fallback for everything else. The generated extension patch is guarded by version, source shape, and behavioral tests.

[Implementation](tokenjuice-rtk/) · [Upstream work](https://github.com/vincentkoc/tokenjuice/pull/235)

Temporary contribution forks live under [droidworks-oss](https://github.com/droidworks-oss).
