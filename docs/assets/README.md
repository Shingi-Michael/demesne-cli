# Repository visuals

[Documentation index](../README.md) · [Project README](../../README.md)

`hero.svg` is an editable vector banner using Demesne’s dark palette and layered-sheet motif. It has no external fonts, scripts, remote resources, or embedded raster images.

The three `demesne-*.png` images show the actual graphics application, captured from decoded Kitty terminal tiles. The capture fixture runs a real isolated daemon, a deterministic model, real workspace tools, approvals, and four Bun tests. The screenshots are demo scenarios, not claims about a hosted/local model’s output quality or speed. All paths and files belong to a disposable demo workspace; no personal sessions or credentials are used.

Regenerate from the repository root after installing dependencies and the graphics runtime:

```sh
bun run graphics:setup
bun scripts/capture-readme.ts
```

An optional output directory is accepted as the first argument. The script compares the terminal pixels with the Chromium capture before saving and cleans up its daemon, UI, and temporary home. Time, temporary paths and tool durations may differ between captures.

Before publishing new images, visually check the full frames for readability and accidental private content. Keep the PNGs at their native capture size, and update the README alt text when the scene changes.
