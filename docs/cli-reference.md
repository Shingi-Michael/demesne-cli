# Commands and keyboard

[Documentation index](README.md) · [Configuration](configuration.md) · [Desktop app](desktop.md)

## Executable commands

Run `demesne --help` for the installed build's grammar. [Source](../apps/cli/src/main.ts).

| Command | Purpose |
| --- | --- |
| `demesne` | Open the desktop window on the current folder from an interactive terminal |
| `demesne chat "message"` | Open the window and submit the opening message; headless without a TTY |
| `demesne --session ID` | Resume a session in the window |
| `demesne --workspace PATH --model ID` | Open a workspace and select a configured model |
| `demesne --setup` | Open setup in the window |
| `demesne setup` | Terminal provider/model/review wizard |
| `demesne auth login chatgpt` | Continue with ChatGPT |
| `demesne auth login chatgpt --model gpt-6.1-sol` | Connect directly to Sol; verify account access when it is absent from the catalog |
| `demesne auth accounts\|status\|use\|logout chatgpt` | Manage ChatGPT registrations |
| `demesne auth login openrouter` | Connect OpenRouter |
| `demesne daemon start\|stop\|status\|logs` | Manage the daemon |
| `demesne doctor [--json]` | Inspect configuration and connectivity |
| `demesne ps [--watch] [--json]` | Active turns, queues, and provider slot capacities |
| `demesne models` | List provider model IDs |
| `demesne models scoreboard [--days N] [--here]` | How each model has done on your own recorded work: turns finished, tool calls without errors, speed, checks, Drive runs kept |
| `demesne session list` | List sessions |
| `demesne session create [--workspace PATH] [title]` | Create a workspace-bound session (asks to trust a new folder) |
| `demesne session auto-approve SESSION_ID on\|off\|status` | Enable, disable or inspect automatic approval for that session |
| `demesne session show ID` | Print a session as JSON |
| `demesne drive [--pr N] [--here] MISSION` | Run a Drive mission with no window, print its receipt, and post it to PR N; exits 0 only when every task is verified. See [Drive in CI](agent-drive.md#drive-in-ci) |
| `demesne compact ID [instructions]` | Summarize older context |
| `demesne cancel TURN_ID` | Cancel a turn |
| `demesne events SESSION_ID [--after EVENT_ID]` | Stream journal events |
| `demesne --version` | Show version; interactive use also checks for updates (`--no-check` disables it) |

`--server URL` selects the daemon. The window opens on the current folder unless `--workspace` names another. To find the app, `demesne` checks `DEMESNE_DESKTOP_BIN`, then `Demesne.app` in `/Applications` or `~/Applications` on macOS, then `demesne-desktop` on PATH, then a build in this checkout under `apps/desktop/src-tauri/target`. From a checkout with Cargo it falls back to `bun run desktop`. If none of these is found, it says to build with `bun run build:desktop` or use `demesne prompt`. See the [desktop guide](desktop.md). The old `demesne graphics` command still works and opens the window too.

ChatGPT uses the public Responses API directly. [Authentication](authentication.md#continue-with-chatgpt) explains account selection, Sol verification and plan usage.

The former `--no-tui` full-screen/text-workbench switch is not an interactive mode in the current entry point. Use `prompt` for text output.

## Headless output

```sh
demesne prompt --output text "Explain the source layout"
demesne prompt --output json --plan "Plan a parser change"
echo "Summarize this failure" | demesne prompt --output stream-json
demesne prompt --session SESSION_ID "Continue the investigation"
```

`--output` accepts `text`, `json`, or `stream-json`. JSON contains the final status, response, usage, changes, validation results, and timing. Stream JSON emits events followed by a final result. Exit codes are 0 for completion, 1 for failure/interruption, and 130 for cancellation.

A new session in a folder you haven't trusted yet asks "Do you trust the files in this folder?" on a terminal. Without one, the command fails; pass `--trust-workspace` to confirm trust for a scripted run. See [workspace trust](../SECURITY.md#workspace-trust).

`--permission ask|deny` chooses the turn's permission mode. Without an interactive approval channel, requested approvals are denied rather than left waiting. Saved grants and workspace permissions remain subject to daemon policy; `ask` is not unattended blanket authorization.

**Settings › Approvals › Auto-approve all** enables automatic approval for the current session. The approval card offers the same option. Edits, commands, deletions and publishing run without asking, including any action already waiting for approval. The setting persists for that session across reopening and daemon restarts; new sessions start with **Ask first**. Turn it off to resume approval prompts for later actions. Plan mode still exposes inspection tools only.

## Slash commands

These commands are handled by the interface host. The canonical grammar is in [the brand package](../packages/brand/src/index.ts), with dispatch in [host.ts](../apps/graphics/host.ts).

| Command | Action |
| --- | --- |
| `/new [title]` | Create a session |
| `/sessions [filter]` | Browse/search sessions |
| `/resume ID` (`/switch`) | Select a session |
| `/rename TITLE` | Rename the current session |
| `/delete` (`/archive`) | Archive, not erase, the session |
| `/cleanup` | Delete sessions for good: lists empty ones, quick questions that changed nothing, ones that never finished, archived ones, ones whose folder is gone, and ones unused for 30+ days, each with its reason. Sessions with no real work come ticked; Delete asks twice. The open session and running ones are never listed. Also in Settings and the Session panel. |
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
| Tab with an empty composer / Ctrl+K | Settings |
| Esc | Close the current popup/panel first; otherwise arm turn cancellation |
| Esc twice within 1.5 seconds | Cancel an active turn when no panel/popup consumes Escape |
| Ctrl+Q (⌘Q on macOS) | Close the window; daemon work continues |
| Ctrl+O (⌘O on macOS) | Open another project |
| Ctrl+B / Ctrl+G | Execution log / follow live |
| Alt+D / Alt+O / Alt+T | Changes / Files / Verification |
| Alt+C / Alt+V / Alt+J / Alt+H | Context / Preview / Drive / History |
| Alt+Enter | Expand/restore an open panel |
| `y`, `n`, `a`, `s` outside a text field | Allow once, deny, session grant, saved grant for an approval |
| `p`, `s` with Drive panel focused | Pause/resume or stop Drive |
| `[` / `]` in Changes | Previous/next diff hunk |
| Ctrl+F / Ctrl+L in the file viewer | Find text / go to line |

In text fields, ordinary browser editing applies. The old ANSI workbench's readline shortcuts and Session/Activity/Transcript view cycling no longer apply. See [input dispatch](../apps/graphics/live.ts).

## Custom commands and mentions

Markdown files in `~/.demesne/commands/` and `<workspace>/.demesne/commands/` become slash commands. Project commands override user commands; built-ins cannot be replaced.

```markdown
---
description: Review a path
---
Review $ARGUMENTS and report concrete findings with file references.
```

Type `@` to select workspace files. File-viewer **Attach lines** inserts the loaded text and its path/range into the draft. Fenced code remains literal, including `@` characters. Mentions and file tools use the [sensitive-path policy](../SECURITY.md).
