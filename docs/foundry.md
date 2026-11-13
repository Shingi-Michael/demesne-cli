# Foundry

[Documentation index](README.md) · [Desktop guide](desktop.md)

Foundry is where the model shows you something: a mockup, a prototype, a chart, a deck, a document. You look; what to change goes to the chat.

## The design guide

Every page the model designs follows a design guide. It has three layers, and a later one wins over an earlier one:

1. **Demesne's rules.** Sixteen numbered rules ([design-guide.ts](../apps/daemon/src/design-guide.ts)): a direction first, one focal point, type and space from the kit's scales, a small palette, an even layout, rows with hairlines, real content, a mockup that works at real size, two or three options with a pick, quiet motion, no stock AI looks, every state designed, and plain words (a button starts with a verb, an error says what happened, why and how to fix it). Plus how Demesne itself looks, for a mockup of Demesne.
2. **Your guide for every chat**: `~/.demesne/design.md`.
3. **The project's guide**: `.demesne/design.md` in the project (a `DESIGN.md` at its root is read when that file is missing).

Your files are plain Markdown, up to 8 KB each. Write them however you like; short rules work best:

```markdown
# Design guide

## It starts from what you have

A mockup of something that exists (your app, your site, Demesne itself) is drawn from the real thing, not from memory.

- Before the first save, the model looks: it captures the window, reads the project's real stylesheet and that screen's markup, opens the page in its browser, or uses a picture you attached.
- Every new mockup says what it started from (`why.starts_from`): the thing it looked at, or "new" when nothing like it exists yet. A page that draws Demesne can never call itself new.
- When it names something real and the chat has not looked at it, the save is refused once with how to look. If it truly cannot look (no window, no files), it says "could not look" and tells you so in its answer.
- The page shows your screen as it is today first ("Today"), then the change, so the change is the only difference. Today is the comparison and does not count as one of the three options.

What counts as looking is kept per chat (`apps/daemon/src/foundry-seen.ts`); the check is `checkStart` in `apps/daemon/src/foundry.ts`.

## Rules

- Blue stays the accent. Pink only marks where you are.
- A list always has hairline dividers in one rounded box.
- No menus and no side panels.
```

**Say a rule once and it is kept.** Tell a chat "never use purple" or "lists always get dividers" as a standing preference and the model saves it with the `remember` tool (`design: true`). It lands under `## Rules` in the project's guide, or in `~/.demesne/design.md` when the chat is outside a project, and holds from the next mockup on. It asks before writing, like any file change. A one-off ask about the page in front of you is not saved.

The guide reaches the model as its own numbered block in its instructions, from the moment the chat has Foundry's tools, with your rules marked as winning. It used to be one long paragraph inside the `foundry_save` tool's description, with nowhere for your rules to go. The tool's description now only says how the tool is called.

The ready kinds (deck, doc, dashboard) are drawn by Demesne from content, so the guide applies to pages the model designs itself: `html` and `svg`.

## It remembers the course

A page's source leaves the chat once its turn is over, so a later ask used to start from a title alone. Now reading a mockup (`foundry_read`) hands back its brief with the source: for each ask so far, what you asked, the direction taken, what leads, what was dropped and what it started from. The first ask and the newest five are kept. The model is told to answer the newest ask, keep every earlier decision you did not change, and never bring back what was dropped unless you ask. (`briefOf` in `apps/daemon/src/foundry.ts`.)

## Every mockup says why

Each version of a page the model designs (`html` or `svg`) carries a short **why**, written when it is saved:

- **Direction**: who it is for and the mood it went for.
- **Look at**: what leads, and so what to look at first.
- **Dropped**: what it tried or considered and left out. Left empty when nothing was.

On the Foundry page the why sits under the description as three quiet lines, one per version, so the history reads as a line of decisions. The model's answer in the chat says the same thing in plain words, so you never have to open Foundry to learn it.

`foundry_save` and `foundry_edit` take it as `why: {direction, look_at, dropped}`. A save that makes a new page version without it is turned back with a hint. The model fixing its own page in the same ask (after a look or a try) keeps the why it already gave. A later ask is a new version, so it says what changed and why. `foundry_edit` with only `id` and `why` sets the why of the latest version without making a new one. Versions saved before this, and the ready kinds, have none. It is stored per version in the `why` column of `foundry_versions`.

## A critic before you see it

After a page is saved, Foundry renders it off screen at 1280 and 390 pixels wide and the model gets the pictures back ([foundry-look.ts](../apps/daemon/src/foundry-look.ts)). Besides layout faults, the look now carries the page's **design numbers** against targets, each tied to the design guide rule it checks:

| Number | Target | Rule |
| --- | --- | --- |
| Text sizes | 3 to 6 | 3, type from the scale |
| Lead | biggest text 2.8× the body or more | 2, one focal point |
| Rhythm | 90% of spacing from six steps | 4, space from the scale |
| Aligned | 85% of text blocks share a left edge | 6, an even layout |
| Colours | 3 to 8 | 5, a small palette |
| Surface | a third of the first screen is more than blank paper | 8, depth where it earns it |

These are the same numbers the quality eval scores (`scripts/foundry-quality.ts`); until now only the eval saw them. They judge pages the model designs (`html`); the ready kinds are drawn by Demesne.

When the look finds a fault or a number off target, the fix has to say what it is fixing first. `foundry_edit` takes a `critique`: the rules the page breaks, by number, and what will change. A fix without one is turned back, and a whole new source through `foundry_save` is pointed to `foundry_edit`. A number can stay off target on purpose, with the reason in the critique. The critique is the model's own working: it is not kept and never shown to you. One fix per ask, as before.

The critique runs in a fixed order, so nothing is skipped: first impression (what the eye lands on in two seconds), usability, hierarchy, consistency with the guide and the numbers, then accessibility. Each problem is marked critical, moderate or minor, the fix goes to the first two, and one thing that works is named so the fix doesn't undo it.

The look also holds pages to the accessibility standard (WCAG 2.1 AA): text needs 4.5:1 contrast against what is behind it, or 3:1 from 24px up (18.66px when bold), and at phone width anything to tap must be at least 44 by 44 pixels. A link inside a sentence, a tick box with its label, a switched-off control and a desktop app drawn inside a frame are exempt. The kit's own muted text, status colours and phone-width buttons were adjusted to meet the same numbers.

The order of the critique, the states rule and the wording rules come from the checklists in Anthropic's design plugin for Claude ([knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)).

## A mockup you can trace

Each version keeps the trail back to why it exists and forward to what came of it:

- **The ask that made it.** The message you sent is kept with the version and quoted under the name ("You asked …"), cut to a line, in full on hover. It is a copy, so it stays after the chat is deleted.
- **Based on.** When the model read another mockup in the same ask before making a new one, the new one is based on it, even if the model didn't say so. Naming `based_on` still wins.
- **Built in #N.** When the chat that made a mockup opened a pull request that has merged, the newest version of each mockup it made before opening that pull request says "built in #N", a link to the pull request on GitHub.
- **A name that says what it is.** `foundry_save` and `foundry_edit` turn back names like "Mockup", "Option B", "New design" or "v2", and names over six words. Options keep their letter in the version's note.
- **Search.** `foundry_read` with `query` lists the mockups whose name, description, version names, whys or asks hold every word, not only the newest fifty.
