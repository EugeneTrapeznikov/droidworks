<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/droidworks-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo/droidworks-light.svg">
  <img alt="Droidworks" src="assets/logo/droidworks-light.svg" width="600" height="96">
</picture>

# Droidworks

[![CI](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml/badge.svg)](https://github.com/EugeneTrapeznikov/droidworks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Built for coding agents](https://img.shields.io/badge/built%20for-coding%20agents-8A2BE2)
![Made by droids](https://img.shields.io/badge/made%20by-droids%20🤖-orange)

Public tools and extensions for agentic software development.

Focused on making coding agents better at real software work: sharper tools, less noise, and workflows that stay out of the way. Custom builds and integrations are shaped and tested in real agentic workflows.

## Projects

- [`pi`](pi/) - Local Pi customization with theme-aware fullscreen selection and version-guarded patching.
- [`pi-footer-nerdfonts`](pi-footer-nerdfonts/) - Replaces Pi footer emojis with consistent Nerd Font glyphs.
- [`pi-jev-triage`](pi-jev-triage/) - Tool-result triage for Pi: a Jev decision model hides the parts of big tool results the agent won't need, freeing up to 10% of context in long sessions with no drop in SWE-bench tasks solved.
- [`tokenjuice-rtk`](tokenjuice-rtk/) - Agent-harness integration that coordinates two token-saving tools, providing layered output optimization without double processing.

**Also**

- [Open-source contributions](OPEN-SOURCE.md) - The path from local workflow improvements to tested upstream contributions.
