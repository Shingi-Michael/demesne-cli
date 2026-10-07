# Repository visuals

[Documentation index](../README.md) · [Project README](../../README.md)

`hero.svg` is an editable vector banner using Demesne’s dark palette and layered-sheet motif. It has no external fonts, scripts, remote resources, or embedded raster images.

The three `demesne-*.png` images show the desktop interface running a scripted demo. `bun scripts/shoot-desktop.ts --readme` retakes them: it runs the real desktop host against an isolated daemon, a deterministic model and real workspace tools (an edit, an approval and a passing check), and draws the page in Chromium rather than the native webview. The screenshots are demo scenarios, not claims about a hosted/local model's output quality or speed. All paths and files belong to a disposable demo workspace in the temp folder; no personal sessions or credentials are used. Run the script without `--readme` to capture every view into a scratch folder.

Before publishing new images, visually check the full frames for readability and accidental private content. Keep the PNGs at their native capture size, and update the README alt text when the scene changes.
