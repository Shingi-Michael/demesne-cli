# Commands and keyboard

[Documentation index](README.md) · [Configuration](configuration.md) · [Desktop app](desktop.md)

## Slash commands

These commands are handled by the interface host. The canonical grammar is in [the brand package](../packages/brand/src/index.ts), with dispatch in [host.ts](../apps/desktop/workspace/host.ts).

| Command | Action |
| --- | --- |
| `/new [title]` | Create a session |
| `/sessions [filter]` | Browse/search sessions |
| `/resume ID` (`/switch`) | Select a session |
| `/rename TITLE` | Rename the current session |
| `/delete` (`/archive`) | Archive, not erase, the session |
| `/cleanup` | Delete sessions for good: lists empty ones, quick questions that changed nothing, ones that never finished, archived ones, ones whose folder is gone, and ones unused for 30+ days, each with its reason. Sessions with no real work come ticked; Delete asks twice. The open session and running ones are never listed. Also in Settings › Conversations. |
| `/model [ID]` | Select a model or open the picker |
| `/subagent [MODEL]` | Choose the subagent default; `same` uses the main model |
| `/theme [NAME]` | Change the interface theme |
| `/themefy [PREFERENCES]` | Design and apply a saved palette through an adaptive interview; `/themefy undo` restores the previous palette ([guide](themes.md)) |
| `/status`, `/context` | Session/model status and context budget |
| `/export [md|json]` | Export the transcript |
| `/diff`, `/undo [PATH]` | Review or revert recorded changes |
| `/plan PROMPT` | Submit a read-only planning turn |
| `/compact [instructions]` | Summarize older context, retaining two recent turns |
| `/drive [mission]` | Open Drive or begin a continuous mission |
| `/drive --bounded MISSION` | Finish after one verified task |
| `/drive --continuous MISSION` | Explicit continuous mode |
| `/drive pause|resume|stop|status` | Mission controls |
| `/drive reopen TASK_ID REASON` | Explicitly revisit a completed task |
| `/drive remember TEXT`, `/drive forget MEMORY_ID` | Project memory controls |
| `/clear`, `/help` | Refresh the view or open help |
| `/exit` (`/quit`, `/leave`) | Close the interface |

There is no separate `/thinking` command. Settings and the model picker expose supported reasoning choices; left/right changes the highlighted model's level when the model filter is empty.

## Keyboard and focus

| Input | Current behavior |
| --- | --- |
| Enter / Shift+Enter | Send / newline; Enter does not resubmit a running turn |
| ⌘, (Ctrl+, elsewhere), Ctrl+K, or Tab on an empty composer | Settings |
| ⌘N | New chat |
| Esc | Close the current popup first; deny a waiting approval; otherwise arm turn cancellation |
| Esc twice within 1.5 seconds | Cancel an active turn when no popup consumes Escape |
| Ctrl+Q (⌘Q on macOS) | Close the window; daemon work continues |
| Ctrl+O (⌘O on macOS) | Open another project |
| Ctrl+G | Follow live output |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous chat in the sidebar |
| ↑ ↓ Home End, Delete | Move through the sidebar's chats, delete the focused one |
| ⌘Z outside a text field | Bring back the chat you just deleted |
| ⌘= / ⌘- / ⌘0 | Zoom in, out, actual size |
| Alt+J | Show or fold what Drive is doing, or its ideas |
| ⋯ in the top bar | This conversation: rename, compact, new chat, settings |
| `y`, `n`, `a`, `s` outside a text field | Allow once, deny, session grant, saved grant for an approval |

In text fields, ordinary editing applies. On Linux and Windows, ⌘ is Ctrl. See [input dispatch](../apps/desktop/workspace/live.ts).

## Custom commands and mentions

Markdown files in `~/.demesne/commands/` and `<workspace>/.demesne/commands/` become slash commands that send their text as a prompt. Project commands override user commands; built-ins cannot be replaced.

```markdown
---
description: Review a path
---
Review $ARGUMENTS and report concrete findings with file references.
```

### Workflows

A workflow is a fixed sequence of steps that runs as one Drive mission. Markdown files in `~/.demesne/workflows/` and `<workspace>/.demesne/workflows/` become slash commands tagged "workflow" (project files win). Each `##` heading is a step, and the text under it is what the coder is asked to do. A `check:` line is a command Drive runs itself in the mission's worktree before the step counts as done; add `expect: fail` when the step must prove something is broken.

```markdown
---
description: Reproduce a bug with a test, fix it, prove it
---
## Reproduce
Write a test that fails because of: $ARGUMENTS
check: bun test   expect: fail

## Fix
Make the smallest change that makes the new test pass.
check: bun test

## Review
Read your own diff as a reviewer and list anything risky.
```

`/bugfix greeting ignores GREETING when it is empty` starts the mission. See [Agent Drive](agent-drive.md#workflows) for how steps and checks run.

Type `@` to select workspace files. File-viewer **Attach lines** inserts the loaded text and its path/range into the draft. Fenced code remains literal, including `@` characters. Mentions and file tools use the [sensitive-path policy](../SECURITY.md).
