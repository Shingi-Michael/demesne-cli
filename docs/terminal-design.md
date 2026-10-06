# Terminal design contract

[Documentation index](README.md) · [Graphics implementation](../apps/graphics/README.md) · [Keyboard reference](cli-reference.md#keyboard-and-focus)

The visual reference is [demesne UI redesign](https://www.figma.com/design/uR068XYXtxAz8gaNL2O9tr/demesne-UI-redesign). This document describes the **implemented graphics interface**, audited on 2026-10-03. It is not a new claim that every screen is pixel-identical to Figma. Earlier ANSI/cell-based adaptations and their `ui:session` preview commands have been removed.

## Rendering contract

The interface is HTML/CSS rendered offscreen by Electron/Chromium and transported into Ghostty as Kitty image tiles. Layout, typography, rounded corners, syntax highlighting, Markdown and math are browser pixels. The terminal forwards input; it does not approximate the UI using text-box characters.

- [live.html](../apps/graphics/live.html) defines the application structure; [live.ts](../apps/graphics/live.ts) projects recorded daemon state and handles interaction.
- [ui.css](../apps/graphics/ui.css) and [live.css](../apps/graphics/live.css) define geometry and responsive behavior.
- [theme.ts](../packages/brand/src/theme.ts) supplies shared semantic colors. The renderer maps them into CSS variables.
- [display-scale.ts](../apps/graphics/display-scale.ts) reconciles cell size, physical pixels and browser scale. Automatic scale follows terminal font changes and Retina density; `--scale 0.5-3` is an explicit override.

Do not apply old fixed-cell geometry or ANSI redraw rules to this renderer. Verify the live screen and the decoded tile output at both normal and Retina density when changing layout.

## Surfaces and behavior

| Surface | Current behavior |
| --- | --- |
| Start screen | Centered hero/composer, starter actions, recent sessions and top Drive proposals; action rail hidden while the session is empty |
| Conversation | User requests, reasoning, prose, tools, approvals and errors project real session events; unknown usage remains explicit |
| Composer | Multiline draft, command/file completion, send/stop actions and queued follow-ups; settings through empty Tab or Ctrl+K |
| Header/status | Workspace/session identity, state and context; detailed execution evidence belongs in the relevant panel |
| Rail/panels | Files, Changes, Preview, Drive, Verification, Context, History and Log have distinct navigation; panels can expand and resize |
| Settings/model picker | Theme, model and supported reasoning choices; metadata determines available reasoning levels |
| Setup | Provider, model and review steps, including ChatGPT and OpenRouter browser sign-in; see [credential persistence](authentication.md) |

Panels preserve navigation within a session; changing sessions clears session-specific selection. Panel width persists separately in private UI preferences. Responsive layouts reduce optional chrome and change panel geometry as space shrinks. User drafts and selected evidence must survive resize.

## Semantic colors and content

Use theme roles such as `paper`, `secondary`, `muted`, `rule`, `electric`, `thinking`, `citron` and `signal`. Blue identifies primary interaction, amber ongoing reasoning/attention, green successful evidence and red failure. Preserve text labels and icons so color is not the only signal. Source syntax colors remain distinct from added/removed diff markings.

The main thinking trace appears first, with the spinner, “Thinking” label and duration in a separate row underneath it. Like subagent traces, it opens while working, respects a reader's manual collapse during streaming, and folds when finished unless explicitly expanded. The bottom row toggles the trace with a click, Enter or Space. Reasoning text and headings stay in the trace body.

Markdown is sanitized; code fences use syntax highlighting and math uses KaTeX. In-progress Markdown is reparsed for correctness while unchanged rendered blocks retain their nodes. Code attached from Files remains literal, including `@` characters. Recorded file changes use immutable before/after evidence; the Files viewer explicitly shows current workspace contents.

A check’s success is separate from its freshness. Verification labels outdated, stopped, unverified and incomplete evidence rather than treating every historical green result as current. See [panel behavior](../apps/graphics/README.md#review-panel-upgrades).

## Interaction, follow and motion

Keyboard, mouse, wheel, paste, selection and resize travel through the terminal bridge. Browser selection can be copied with Ctrl+Y. Manual conversation reading pauses follow; Ctrl+G returns to live. Menus and panels consume Escape before the two-press turn cancellation gesture.

CSS uses `prefers-reduced-motion`. The plain-output `DEMESNE_REDUCED_MOTION` environment variable is not a general browser motion switch. Avoid introducing motion that obscures recorded state or moves a reader’s selected content unexpectedly.

Drive’s default control path uses daemon APIs. The displayed panel is a view of mission state, task criteria, evidence, proposals and controls; it is not the worker’s only means of observing progress. [Drive](agent-drive.md) documents continuous versus bounded missions and the optional DOM-control compatibility path.

## Visual acceptance

```sh
bun run graphics:check
bun apps/graphics/check-display-scale.ts
bun apps/graphics/check-panels.ts
bun apps/graphics/check-files.ts
bun apps/graphics/check-drive-tasks.ts
bun apps/graphics/check-drive-next.ts
bun apps/graphics/check-auth-scene.ts
```

These harnesses compare independently decoded terminal tiles with Chromium captures and exercise actual interactions. This verifies transport fidelity and application behavior; a comparison to Figma is a separate design review. Do not hide a compositor mismatch by masking content or relaxing tolerances. The NEXT/composer rounded-border mismatch was resolved with a stable compositor layer, without widening the pixel allowance.

For changes affecting shipping assets, repeat the relevant check with the packaged renderer, using the arguments documented by its check script. See [graphics verification](../apps/graphics/README.md#verification) and [contribution workflow](../CONTRIBUTING.md).
