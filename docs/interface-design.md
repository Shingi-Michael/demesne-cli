# Interface design

[Documentation index](README.md) · [Desktop workspace code](../apps/desktop/workspace/README.md) · [Keyboard reference](commands.md#keyboard-and-focus)

This document is the contract for the desktop interface as built. What each screen looks like is described in the [desktop guide](desktop.md#workspace-layout); this page covers the rules changes must keep.

## Rendering

The interface is HTML/CSS/TypeScript shown in the [desktop app](desktop.md)'s bundled Chromium (Electron) on macOS, Linux and Windows.

- [index.html](../apps/desktop/index.html) defines the application structure; [live.ts](../apps/desktop/workspace/live.ts) projects recorded daemon state and handles interaction.
- [ui.css](../apps/desktop/workspace/ui.css), [live.css](../apps/desktop/workspace/live.css) and the desktop's own stylesheets define geometry and responsive behavior.
- [theme.ts](../packages/brand/src/theme.ts) supplies shared semantic colors. The interface maps them into CSS variables.

Check layout changes in the real desktop window, not only in unit tests.

## Layout rules

- **No side panels.** Everything lives in the sidebar, the conversation column and the composer. A turn's edits, commands and checks unfold in place under their steps; Drive's missions are turns and its ideas unfold from a line at the end of the conversation; Drive has no page.
- **No menus where a direct action fits.** Act on the row itself (the sidebar's Pin and Archive, double-click to rename). The top bar's **⋯** is the one small menu.
- **One line per row.** Sidebar rows have the same height and carry an icon and a word, not sentences. State is a single mark (amber ring, working cube, blue dot, red cross), with words in the tooltip.
- **Work in progress is the cube.** Wherever something is working overall (thinking, the line under the conversation, a working chat or Drive), a 12px cube of eight cubelets parts, turns a quarter on a random axis and closes every 1.4s, and the live words carry a silver shine sweeping back and forth. The cube is one small SVG of lit faces that one frame loop redraws only while it moves (`working-cube.ts`), so streaming text never stutters behind it. All cubes turn together; under reduced motion they hold still and the shine stops. A running tool step is not a cube: it keeps its own icon (terminal, file, search) and plain words.
- **The working line says what the model is doing.** Under a live turn, one line carries the cube and a few silver words that take turns: the heading of the model's latest thought ("Checking where a chat is first named"), the step running now ("Reading live.ts"), steps faster than a phrase can stay counted ("Reading 5 files"), and between steps what it has read so far. Every phrase is true; waiting on you or writing a command is said at once and alone. It is built to never stutter (`working-line.ts`): one element kept outside the turn's repaints, a fixed height, at least 2.4s per phrase, phrases that glide by transform and opacity, and a shimmer that is a bright copy of the words seen through a soft sliding window, so the words never repaint while it sweeps.
- **Add as little surface as possible.** Fold new facts into existing rows, chips and tooltips before adding anything new.

## Semantic colors and content

Use theme roles such as `paper`, `secondary`, `muted`, `rule`, `electric`, `thinking`, `citron` and `signal`. Blue identifies primary interaction and new replies, amber needs-you and ongoing reasoning, green successful evidence and red failure. Keep a shape or label beside every color so color is never the only signal. Source syntax colors stay distinct from added/removed diff markings.

The main thinking trace stays collapsed by default, including while working. Only the "Thinking" label (the working line below the turn carries the cube) and the duration appear until the reader expands it with a click, Enter or Space. Streaming updates and completion preserve the reader's choice. Reasoning text and headings stay in the trace body.

Markdown is sanitized; code fences use syntax highlighting and math uses KaTeX. In-progress Markdown is reparsed for correctness while unchanged rendered blocks keep their nodes. Recorded file changes use immutable before/after evidence.

A check's success is separate from its freshness. Outdated, stopped, unverified and incomplete evidence is labeled as such rather than shown as a current green result.

## Interaction, follow and motion

Keyboard, mouse, wheel, paste, selection and resize are handled by the renderer. Manual conversation reading pauses follow; Ctrl+G returns to live. Popups consume Escape before the two-press turn cancellation gesture.

CSS uses `prefers-reduced-motion`. Avoid motion that obscures recorded state or moves a reader's selected content unexpectedly.

Drive works through daemon APIs and recorded evidence, never by reading or driving the screen. See [Agent Drive](agent-drive.md).

## Session compaction

Use **Compact** in the top bar's **⋯**, **Compact now** under the context ring, or `/compact [instructions]` in the composer. Compaction waits for the current turn to finish, keeps the full transcript, and keeps the latest two conversation turns in model context.

The agent can call `compact_session` with optional preservation instructions (up to 4000 characters). The tool schedules one compaction after its calling turn completes successfully, rather than rewriting context mid-turn. Cancellation or failure of the calling turn discards the request. Compaction itself is cancellable, and a failed or non-shrinking summary leaves the previous context active.

## Visual acceptance

```sh
bun test apps/desktop/workspace/test
bun scripts/prepare-desktop.ts && dbus-run-session -- xvfb-run -a bun run desktop:check
```

The unit tests cover shared state and Markdown. The desktop check drives the real Electron window with a deterministic model and saves screenshots under `test-results/desktop/`. It verifies behavior; design review is separate. See [desktop verification](../apps/desktop/README.md#verification).
