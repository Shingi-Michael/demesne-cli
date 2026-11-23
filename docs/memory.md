# Memory

[Documentation index](README.md)

Demesne keeps what the model learns from you, so you don't have to say it again. There is one memory, in two halves:

| Half | File | What goes in it |
| --- | --- | --- |
| **About you** | `~/.demesne/memory/MEMORY.md` | How you like to work: "skip the summary at the end", "ask before pushing". It goes with you to every project. |
| **This project** | `.demesne/memory/MEMORY.md` in the project | Facts about the project the code doesn't already show: "uses bun, not npm", "releases build only on the Mac". |

Both are plain Markdown, one line per thing, with the day it was learned. Edit or delete lines freely. Each half keeps its newest 60 lines. A chat outside a project keeps everything in About you.

## How a line gets there

When you correct the model or show a lasting preference, it calls `remember` with `learned: "you"` or `learned: "project"` in the same round as its other work. It doesn't ask first. Instead, when the turn ends, a small silver pill above the composer says **Demesne will remember 3 things**:

- A silver light runs around its edge for as long as it is up.
- It leaves by itself after six seconds. Resting on it, or opening its list, keeps it there.
- Click it to see what was kept. **×** drops one line, **Undo all** drops them all.
- The chat also keeps a **Remembered** step for each line.

A rule you say in words ("always…", "never…", "from now on…") still goes to `DEMESNE.md`, which is shared with anyone on the repo, and still asks like an edit. Design taste still goes to the design guide ([Foundry](foundry.md)). The pill only shows for what the model learned on its own.

## How a chat reads it

Both halves are read once, when a chat's first request goes out, and the chat keeps that copy until it ends. Something learned mid-chat is already known to the chat that learned it, and the next chat starts with it. Reading once keeps the start of a running chat the same on every request, so its prompt cache keeps holding ([caching](caching.md)).

## Still to come

- **A nightly dream:** once a night, one short model call per project you used tidies both halves. It merges repeats, turns "tomorrow" into a date, and drops what the code now contradicts, keeping last night's version so a bad night can be put back. It will reuse the shape of the social agents' sleep (`sleep.ts`).
- **Settings › Memory:** both halves on one page, each line saying where it came from.

## Read more

- [How Claude remembers your project](https://code.claude.com/docs/en/memory): Claude Code's CLAUDE.md files and auto memory, the same two-level idea.
- [Components of agent memory](https://www.anthropic.com/research/components-of-agent-memory): Anthropic on the layers of agent memory, why the part every session sees stays small, and dreaming.
- [Dreams, Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/dreams): what a dream reads and writes.
- [Bringing memory to Claude](https://claude.com/blog/memory): project-scoped memory with a summary you can edit.
- [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): why the pill says *that* it remembered, and shows *what* only when you click.
- [Timing adjustable, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html): why a pop-up that leaves by itself stops while you rest on it.

Code: [memory.ts](../apps/daemon/src/memory.ts) · [remember.ts](../apps/daemon/src/remember.ts) · [memory-pill.ts](../apps/desktop/workspace/memory-pill.ts) · tests: [memory](../apps/daemon/test/memory.test.ts), [pill](../apps/desktop/workspace/test/memory-pill.test.ts)
