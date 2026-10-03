# Commands and keyboard

[Documentation index](README.md) · [Configuration](configuration.md) · [Graphics guide](../apps/graphics/README.md)

## Executable commands

Run `demesne --help` for the installed build's grammar. [Source](../apps/cli/src/main.ts).

| Command | Purpose |
| --- | --- |
| `demesne` | Open the graphics UI in an interactive terminal |
| `demesne chat "message"` | Open the UI and submit the opening message; headless without a TTY |
| `demesne --session ID` | Resume a session in the UI |
| `demesne --workspace PATH --model ID` | Open a workspace and select a configured model |
| `demesne graphics` / `demesne --graphics` | Explicit graphics entry point |
| `demesne --setup` | Open graphics setup |
| `demesne setup` | Terminal provider/model/review wizard |
| `demesne auth login chatgpt` | Continue with ChatGPT |
| `demesne auth accounts\|status\|use\|logout chatgpt` | Manage ChatGPT registrations |
| `demesne auth login openrouter` | Connect OpenRouter |
| `demesne daemon start\|stop\|status\|logs` | Manage the daemon |
| `demesne doctor [--json]` | Inspect configuration and connectivity |
| `demesne ps [--watch] [--json]` | Active turns, queues, and provider slot capacities |
| `demesne models` | List provider model IDs |
| `demesne session list` | List sessions |
| `demesne session create [--workspace PATH] [title]` | Create a workspace-bound session |
| `demesne session show ID` | Print a session as JSON |
| `demesne compact ID [instructions]` | Summarize older context |
| `demesne cancel TURN_ID` | Cancel a turn |
| `demesne events SESSION_ID [--after EVENT_ID]` | Stream journal events |
| `demesne --version` | Show version; interactive use also checks for updates (`--no-check` disables it) |

`--server URL` selects the daemon. Graphics supports `--scale auto` or `--scale 0.5` through `3`; auto follows terminal cell size. Use the explicit `graphics` entry point for graphics diagnostic flags described in the [graphics guide](../apps/graphics/README.md).

The former `--no-tui` full-screen/text-workbench switch is not an interactive mode in the current entry point. Use `prompt` for text output.

## Headless output

```sh
demesne prompt --output text "Explain the source layout"
demesne prompt --output json --plan "Plan a parser change"
echo "Summarize this failure" | demesne prompt --output stream-json
demesne prompt --session SESSION_ID "Continue the investigation"
```

`--output` accepts `text`, `json`, or `stream-json`. JSON contains the final status, response, usage, changes, validation results, and timing. Stream JSON emits events followed by a final result. Exit codes are 0 for completion, 1 for failure/interruption, and 130 for cancellation.

`--permission ask|deny` chooses the turn's permission mode. Without an interactive approval channel, requested approvals are denied rather than left waiting. Saved grants and workspace permissions remain subject to daemon policy; `ask` is not unattended blanket authorization.

## Slash commands

These commands are handled by the graphics host. The canonical grammar is in [the brand package](../packages/brand/src/index.ts), with dispatch in [host.ts](../apps/graphics/host.ts).

| Command | Action |
| --- | --- |
| `/new [title]` | Create a session |
| `/sessions [filter]` | Browse/search sessions |
| `/resume ID` (`/switch`) | Select a session |
| `/rename TITLE` | Rename the current session |
| `/delete` (`/archive`) | Archive, not erase, the session |
| `/model [ID]` | Select a model or open the picker |
| `/subagent [MODEL]` | Choose the subagent default; `same` uses the main model |
| `/theme [NAME]` | Change the interface theme |
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

| Input | Current graphics behavior |
| --- | --- |
| Enter / Shift+Enter | Send / newline; Enter does not resubmit a running turn |
| Tab with an empty composer / Ctrl+K | Settings |
| Esc | Close the current popup/panel first; otherwise arm turn cancellation |
| Esc twice within 1.5 seconds | Cancel an active turn when no panel/popup consumes Escape |
| Ctrl+C / Ctrl+Q | Interrupt work or exit when idle / close UI |
| Ctrl+B / Ctrl+G | Execution log / follow live |
| Alt+D / Alt+O / Alt+T | Changes / Files / Verification |
| Alt+C / Alt+V / Alt+J / Alt+H | Context / Preview / Drive / History |
| Alt+Enter | Expand/restore an open panel |
| Ctrl+Y | Copy the browser selection |
| `y`, `n`, `a`, `s` outside a text field | Allow once, deny, session grant, saved grant for an approval |
| `p`, `s` with Drive panel focused | Pause/resume or stop Drive |
| `[` / `]` in Changes | Previous/next diff hunk |
| Ctrl+F / Ctrl+L in the file viewer | Find text / go to line |

Mouse selection, wheel input, paste and resize are forwarded to the hidden browser. In text fields, ordinary browser editing applies. The old ANSI workbench's readline shortcuts and Session/Activity/Transcript view cycling are not a graphics keyboard reference. See [input dispatch](../apps/graphics/live.ts) and [terminal decoding](../apps/graphics/terminal.ts).

## Custom commands and mentions

Markdown files in `~/.demesne/commands/` and `<workspace>/.demesne/commands/` become slash commands. Project commands override user commands; built-ins cannot be replaced.

```markdown
---
description: Review a path
---
Review $ARGUMENTS and report concrete findings with file references.
```

Type `@` to select workspace files. File-viewer **Attach lines** inserts the loaded text and its path/range into the draft. Fenced code remains literal, including `@` characters. Mentions and file tools use the [sensitive-path policy](../SECURITY.md).
