# Foundry

[Documentation index](README.md) · [Desktop guide](desktop.md)

Foundry is where the model shows you something: a mockup, a prototype, a chart, a deck, a document. You look; what to change goes to the chat.

## The design guide

Every page the model designs follows a design guide. It has three layers, and a later one wins over an earlier one:

1. **Demesne's rules.** Fourteen numbered rules ([design-guide.ts](../apps/daemon/src/design-guide.ts)): a direction first, one focal point, type and space from the kit's scales, a small palette, an even layout, rows with hairlines, real content, a mockup that works at real size, two or three options with a pick, quiet motion, no stock AI looks. Plus how Demesne itself looks, for a mockup of Demesne.
2. **Your guide for every chat**: `~/.demesne/design.md`.
3. **The project's guide**: `.demesne/design.md` in the project (a `DESIGN.md` at its root is read when that file is missing).

Your files are plain Markdown, up to 8 KB each. Write them however you like; short rules work best:

```markdown
# Design guide

## Rules

- Blue stays the accent. Pink only marks where you are.
- A list always has hairline dividers in one rounded box.
- No menus and no side panels.
```

**Say a rule once and it is kept.** Tell a chat "never use purple" or "lists always get dividers" as a standing preference and the model saves it with the `remember` tool (`design: true`). It lands under `## Rules` in the project's guide, or in `~/.demesne/design.md` when the chat is outside a project, and holds from the next mockup on. It asks before writing, like any file change. A one-off ask about the page in front of you is not saved.

The guide reaches the model as its own numbered block in its instructions, from the moment the chat has Foundry's tools, with your rules marked as winning. It used to be one long paragraph inside the `foundry_save` tool's description, with nowhere for your rules to go. The tool's description now only says how the tool is called.

The ready kinds (deck, doc, dashboard) are drawn by Demesne from content, so the guide applies to pages the model designs itself: `html` and `svg`.

## Every mockup says why

Each version of a page the model designs (`html` or `svg`) carries a short **why**, written when it is saved:

- **Direction**: who it is for and the mood it went for.
- **Look at**: what leads, and so what to look at first.
- **Dropped**: what it tried or considered and left out. Left empty when nothing was.

On the Foundry page the why sits under the description as three quiet lines, one per version, so the history reads as a line of decisions. The model's answer in the chat says the same thing in plain words, so you never have to open Foundry to learn it.

`foundry_save` and `foundry_edit` take it as `why: {direction, look_at, dropped}`. A save that makes a new page version without it is turned back with a hint. The model fixing its own page in the same ask (after a look or a try) keeps the why it already gave. A later ask is a new version, so it says what changed and why. `foundry_edit` with only `id` and `why` sets the why of the latest version without making a new one. Versions saved before this, and the ready kinds, have none. It is stored per version in the `why` column of `foundry_versions`.
