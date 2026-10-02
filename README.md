# Demesne CLI

Demesne is a terminal coding agent that works with the model you choose, local or hosted. A small background daemon owns model requests, workspace tools, approvals and session history. The CLI can close and reopen without losing a turn.

## Install

Demesne needs [Bun](https://bun.sh) 1.4. [ripgrep](https://github.com/BurntSushi/ripgrep) is optional; code search uses it when it is installed.

```sh
git clone https://github.com/Shingi-Michael/demesne-cli
cd demesne-cli
bun install --frozen-lockfile
bun run build
```

This builds two executables into `dist/`: `demesne` (the CLI) and `demesned` (the daemon). Keep them in the same folder. `dist/node_modules` holds the daemon's image codecs, so keep that beside them too. To run `demesne` from anywhere, link both onto your PATH:

```sh
ln -sf "$PWD/dist/demesne" "$PWD/dist/demesned" /usr/local/bin/
```

You can also run from source without building: `bun run demesne`.

## Quick start

```sh
demesne setup    # connect a model
demesne          # open the workbench in the current folder
```

`demesne setup` looks for local model servers (Ollama, LM Studio and llama.cpp), lets you pick a model, and writes `~/.demesne/config.toml`. Choose **Continue with ChatGPT** to use an eligible ChatGPT plan, or sign in from the CLI:

```sh
demesne auth login chatgpt
```

To use OpenRouter instead:

```sh
demesne auth login openrouter
```

`demesne doctor` checks the config, daemon, provider, workspace and memory, and says what to fix.

`demesne` starts the daemon when it needs one. The first time, it asks; answer yes once and it will start the daemon automatically from then on. Manage the daemon directly with `demesne daemon start | stop | status | logs`.

Demesne works in the folder you start it from. Each session is bound to that workspace, and the agent's tools cannot reach outside it.

## Web-rendered UI inside Ghostty

The Figma-based interface can run as pixels inside Ghostty, connected to the same daemon:

```sh
bun run graphics:setup  # install the optional Chromium runtime once
bun run graphics
```

Use `bun run demesne graphics --session <id>` to resume a session, or add `--setup` for provider setup. For the compiled CLI, run `bun run build:graphics` after the normal build, then `dist/demesne graphics`. Ctrl+Q exits; Esc twice stops a turn. See [the graphics UI guide](apps/graphics/README.md) for controls, packaging, and measured performance.

## The workbench

**Start screen.** A new session opens on "What are we working on?", with the composer, your model and context size, and **Start from** cards: Explore, Debug, Build and Learn. Clicking a card fills in an editable prompt; Enter sends it. **Recent** lists your last three sessions that have turns; click one to resume it.

**Header and status bar.** The header shows the session title and workspace path on the left. On the right are the git branch, the session status, the clock, and **history**. The status bar at the bottom shows the session state (`● ready`, `● approval`, `● failed` or `● stopped`; it stays quiet while a turn is working), the model, and a context meter that turns amber above 50% and red above 80%.

**Conversation.** Your request sits above the assistant's reply. The reply has a left rail colored by state: amber while working, blue when done, red on failure.
- **Thinking** streams live as `◇ Thinking ···`. It folds into `▸ ◇ Thought 1.2s` once text or tools arrive; click it or press Ctrl+X to reopen it.
- **Tools** are one line each, with a status mark, name, target and timing. Consecutive reads and searches group into `▸ Explored · N reads`.
- **Receipts** under a finished turn show the files changed and the checks that ran, and link to the diff and command output. A failed or stopped turn is marked `× failed` or `■ stopped`.

**Approvals.** File edits and commands ask first:

```
! Allow this command?
  bun test
  runs on your machine · not sandboxed
  [ y  Allow once ]  [ n  Deny ]   a this session · s always
```

`y` allows once, `n` denies, `a` allows for the rest of the session, and `s` saves a rule to your config so it is never asked again. Commands default to Deny.

**Composer.** Enter sends; Shift+Enter adds a line. Type `/` for commands or `@` to mention a file. While a turn is running you can keep typing: the text is queued and sent when the turn finishes. If the turn fails or you stop it, the queued text comes back to the composer unsent, marked **Restored**, so you can edit or clear it. Esc Esc or Ctrl+C stops a running turn.

**Following.** The view follows new output. Scroll up to read and it stays put; press Ctrl+G, or scroll back to the bottom, to follow live again.

**Panels.** On terminals 100 columns or wider, panels dock beside the conversation. On narrower ones they open over it.

| Panel | Open with | Shows |
| --- | --- | --- |
| Diff | Alt+D | Edits as they stream, per file, with syntax highlighting; `v` shows the whole file with this session's changes marked (`n`/`p` step through them, `/` searches) |
| Files | Alt+O, or ≡ in the rail | What the agent edited and read this session, git changes, then every file; type to filter, Enter opens a file, `@` adds it to your message |
| Execution log | Ctrl+B | Every request, thought, tool call and result, in order |
| Context | Alt+C, or click `ctx` | Context budget, token usage and timing |
| Workspace | Alt+P, or click the path | Full path and branch |
| Preview | Alt+V | Screenshots and generated images |
| Agent Drive | Alt+J | Progress of a `/drive` mission |
| History | Alt+H | Sessions and earlier turns |

### Keyboard

| Keys | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| Esc Esc, Ctrl+C | Stop the running turn |
| Tab or Ctrl+K (empty prompt) | Settings: Build/Plan mode and model |
| Ctrl+T | Move focus between the conversation and the prompt |
| Tab / Shift+Tab (conversation focused) | Next/previous control |
| ↑/↓, PgUp/PgDn, mouse wheel | Scroll |
| Ctrl+G | Follow live output again |
| Ctrl+X | Open/close the latest thinking |
| Alt+↑/↓ | Previous/next turn |
| Alt+R | Jump to the start of the answer |
| Alt+←/→ | Switch between the answer and its review |
| Ctrl+Y (empty prompt) | Copy the answer |
| Ctrl+L | Cycle Session → Activity → Transcript views |
| Alt+Enter (Diff open) | Expand/restore the Diff panel |

## Commands

| Command | Action |
| --- | --- |
| `/new [title]` | Start a new session |
| `/sessions [filter]` | Browse or search sessions |
| `/resume <id>` | Switch to a session |
| `/rename <title>` | Rename this session |
| `/delete` | Archive this session |
| `/model [id]` | Switch model |
| `/plan <prompt>` | Plan with read-only tools before changing anything |
| `/diff` | Review the last turn's changes |
| `/undo [path]` | Revert the last turn's changes, or one file |
| `/compact [instructions]` | Summarize older context to free space |
| `/context` | Context plan and token usage |
| `/status` | Session, model and workspace |
| `/drive [mission\|pause\|resume\|stop]` | Run or control Agent Drive |
| `/theme [name]` | Switch theme |
| `/export [md\|json]` | Save the transcript to the current folder |
| `/clear` | Clear the screen |
| `/help` | Command and key reference |
| `/exit` | Quit |

### Custom commands

Markdown files in `~/.demesne/commands/` or `<workspace>/.demesne/commands/` become slash commands named after the file, so `review.md` becomes `/review`. Optional frontmatter sets the description, and `$ARGUMENTS` is replaced with what you type after the command:

```markdown
---
description: Review a path with fresh eyes
---
Review $ARGUMENTS carefully and list concrete findings.
```

Project commands override user commands with the same name. Built-in commands cannot be overridden.

### Prompt editing

The prompt has readline-style editing:
- ↑/↓ or Ctrl+P/Ctrl+N walk history, and Ctrl+R searches it.
- Ctrl+A/Ctrl+E jump to the start/end of the line; Alt+B/Alt+F move by word.
- Ctrl+U/Ctrl+K/Ctrl+W cut text, Ctrl+Y pastes it back, and Ctrl+_ undoes.
- Ctrl+O opens the prompt in `$VISUAL`/`$EDITOR`.

History is kept privately in `~/.demesne/history.jsonl` (the last 500 entries).

### Compaction

`/compact` summarizes older turns into a checkpoint when a session gets long. It keeps the two most recent turns in full. Optional instructions steer the summary:

```text
/compact preserve the parser decisions and unfinished work
```

The originals stay in History and exports.

### Agent Drive

`/drive <mission>` lets Demesne direct the work through the same composer you use: it finishes and verifies each task, decides for itself what is worth doing next within your mission, and goes idle when nothing worthwhile is left. Completed tasks keep their evidence and cannot silently restart. Use `/drive --bounded <mission>` to stop after one verified task, or `/drive reopen <task-id> <reason>` to revisit completed work. Alt+J opens its panel: a card shows what Drive decided (keep working, redirected, next task, blocked…), and with the panel focused and an empty draft, P pauses or resumes and S stops. See [Agent Drive](docs/agent-drive.md).

## Themes

```toml
# ~/.demesne/config.toml
theme = "tokyo-night"
```

Available themes: `demesne` (the default), `demesne-light`, `dracula`, `tokyo-night`, `tokyo-night-storm`, `nord`, `gruvbox-dark`, `catppuccin-mocha`, `catppuccin-latte` and `github-light`. Use `auto` to follow your terminal's background.

`/theme` switches the theme live. `DEMESNE_THEME` overrides the config file, `NO_COLOR=1` turns color off, and `DEMESNE_REDUCED_MOTION=1` stops the animations.

## Scripting

`demesne prompt` runs one turn without the workbench:

```sh
demesne prompt "Summarize the test suite"
demesne prompt --output json "List the TODOs"
echo "Explain this failure" | demesne prompt --output stream-json
```

- **Output:** `--output json` prints one result object with the answer, usage, changes and checks. `--output stream-json` prints every event, then a final result line.
- **Approvals:** in scripts, permission requests are denied, with a note on stderr. Use `--permission ask` or `--permission deny` to choose explicitly.
- **Exit codes:** 0 for a completed turn, 1 for a failure, 130 for a cancelled one.

Other commands:

```sh
demesne models                  # models your providers offer
demesne session list
demesne session create --workspace /path/to/project "Title"
demesne compact <session-id> "What to keep"
demesne ps --watch              # sessions with queued or running turns
demesne doctor --json
demesne --version               # also checks for a newer release once a day
```

## Coding tools and permissions

| Tool | What it does | Asks first |
| --- | --- | --- |
| `list_files`, `read_file`, `read_files`, `search_files` | Browse, read and search the workspace | No |
| `git_status`, `git_diff` | Read-only git state | No |
| `edit_file`, `write_file`, `move_path`, `delete_path` | Change files | Yes |
| `run_command` | Run a command (optionally in the background) | Yes |
| `command_logs`, `command_stop` | Read or stop a background command | No |
| `subagent` | Hand a read-only investigation to a sub-agent with its own context; only its report comes back | No |

- **Sub-agents read, never write.** A sub-agent gets a fresh context and the read-only tools above, so it needs no approvals and several can run at once (on a single model slot their model calls take turns). Its card shows its task and current step; its tool calls stay out of the main conversation, which receives only the report.
- **Sub-agents can use a different model.** Set `subagent_model` under `[agent]` to any configured model, for example a local Qwen while the main conversation uses ChatGPT, so reading and searching don't spend your plan. Each provider has its own model slots, so the local model never waits behind the cloud one. Cards and reports name the sub-agent's model.
- **Commands aren't sandboxed.** `run_command` runs on your machine as your user. It starts in the workspace with a filtered environment and process limits.
- **Secrets stay out of reach.** Sensitive files are never read or searched automatically, including `.env`, `.git`, `.ssh`, `.aws`, credential files and private keys.
- **Saved approvals.** They live in `[permissions] allow`, for example `"edit_file:src"` or `"run_command:git status"`. A saved command rule matches that exact command only; end it with ` *` (`"run_command:git status *"`) to also allow further arguments.

## Configuration

Demesne merges `~/.demesne/config.toml` (user) with `<workspace>/.demesne/config.toml` (project). Environment variables override both. Unknown keys are rejected, so a typo can't silently disable a setting. Provider, MCP and image settings are read from the user file only, so a project cannot change them.

```toml
theme = "auto"

[daemon]
auto_start = "prompt"   # prompt, always or never
port = 7337

[provider]
url = "http://127.0.0.1:11434/v1"   # any OpenAI-compatible endpoint
id = "ollama"
model = "qwen3-coder"
context_window = 32768              # what the server actually loaded
max_output_tokens = 4096

[agent]
max_model_rounds = 64
max_tool_calls = 256
# subagent_model = "qwen3.8-27b"    # run sub-agents on another configured model

[permissions]
allow = []

[notifications]
enabled = true
minimum_duration_ms = 30000

[ui]
hyperlinks = true
```

Restart the daemon after changing provider settings: `demesne daemon stop`, then `demesne daemon start`.

`demesne setup --yes --provider-url … --model … --context-window … --max-output-tokens …` writes the same settings non-interactively. It backs up the existing file first.

**Providers.**
- **Any endpoint.** Demesne talks to any OpenAI-compatible API. Set `api_key` (or `DEMESNE_API_KEY`) when the endpoint needs one.
- **HTTPS rule.** Plain HTTP is allowed only on your own machine. A remote endpoint must use HTTPS, except a single Tailscale address you opt into with `allow_http_endpoint`.
- **More than one provider.** Add endpoints under `[additional_providers.<name>]`, then use `/model` to switch between every model they offer.

**Per-turn limits.** Each request gets 64 model rounds and 256 tool calls by default. When a limit is reached, the model reports what it finished and what is left, and the turn is marked interrupted rather than complete.

**Project instructions.** Put guidance for the agent in `DEMESNE.md` at the workspace root. `AGENTS.md` works too. It is read on every turn.

**Notifications.** Interactive terminals get a desktop notification when a long turn finishes or an approval is waiting. Set `DEMESNE_NO_NOTIFICATIONS=1` to turn them off.

### ChatGPT sign-in

`demesne auth login chatgpt` opens **Continue with ChatGPT** in your browser, verifies the returned identity, and lists models available to that account. Review the first-use plan notice, then select a model with `--model <slug>` or use the setup model picker. Existing local providers are kept; the CLI adds ChatGPT as an additional provider. Restart the daemon when sessions are idle, then select its model with `/model`.

```sh
demesne auth accounts chatgpt
demesne auth login chatgpt --new-account
demesne auth use chatgpt --account <id> --model <slug>
demesne auth login chatgpt --account <id> --consent
demesne auth logout chatgpt --account <id>
```

Setup also lets you select a saved account, add another account or workspace, and sign out. Each registration keeps its own issued client ID and validated identity. Tokens live in `<data_dir>/auth/chatgpt.json` (owner-only, atomic writes); the config contains only a profile reference. Refresh is serialized across Demesne processes. Demesne does not read another app’s credentials. Sign-out revokes the refresh token and clears local tokens while retaining the registration for later sign-in.

This uses OpenAI’s [locally run app sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and the public Responses API. Requests use `store: false` and `stream: true`; full conversation context and encrypted reasoning items are retained locally for tool continuity. Incomplete streams never execute pending tools. Eligible requests count toward the ChatGPT plan and available credits; [Manage usage](https://chatgpt.com/settings/usage). Usage-limit errors stop the turn without switching to API-key billing.

The preview route does not accept an output-token cap, so `max_output_tokens` is only Demesne’s context-planning reserve for this provider. Reasoning summaries follow the UI’s thinking visibility; Demesne does not force a reasoning effort unsupported by the chosen model. If the account catalog omits context capacity, setup starts with a conservative 32,768-token budget, editable in Review or with `--context-window`. For browserless terminals use `--no-browser`; the callback must reach the same machine’s `127.0.0.1`. Non-interactive scripts can acknowledge the displayed usage notice with `--accept-plan-usage`.

### OpenRouter

`demesne auth login openrouter` signs in through your browser and saves the key to your user config, which is private to you. Add `--model <id>` to pick a model. If `OPENROUTER_API_KEY` is set, that key is used instead. Existing local providers are kept. Restart the daemon, then choose an OpenRouter model with `/model`.

### MCP servers

```toml
[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
timeout_ms = 15000
```

MCP tools appear as `mcp__<server>__<tool>` and ask for approval on each call. A server that fails to start is skipped.

### Images

- **Screenshots.** Image-returning tools, such as a browser MCP server or macOS window capture, save their screenshots to the Preview panel (Alt+V).
- **Vision.** For a model that can read images, set `vision = true` under `[provider]` so it sees the latest screenshots.
- **Generating images.** Add an `[images]` section with the `url` and `model` of an OpenAI Images-compatible service, and the agent gains a `generate_image` tool. Put the key in `DEMESNE_IMAGE_API_KEY`.

## Daemon, data and security

The daemon listens on `127.0.0.1:7337` and keeps sessions in `~/.demesne/demesne.sqlite`. Change these with `DEMESNE_PORT` and `DEMESNE_DATA_DIR`. On first start it creates a private token in `~/.demesne/daemon.token`, and the CLI uses it for every request. The daemon only accepts connections from your own machine.

Everything is saved as it happens: sessions, transcripts, tool calls and results, approvals, and undo snapshots. If the daemon crashes, running work is marked interrupted and is never replayed on its own.

## Development

```sh
bun run typecheck
bun test
bun run ui:session                 # preview the workbench with demo data
bun run ui:session --state=approval
```

```text
apps/cli/           The workbench and command-line client
apps/daemon/        The daemon: turns, tools, approvals
packages/client/    Typed REST and event-stream client
packages/protocol/  Shared API and event types
packages/providers/ OpenAI-compatible provider adapters
packages/storage/   SQLite state and event journal
packages/config/    Config loading
packages/brand/     Themes, commands and terminal rendering
```

The design rules for the workbench are in [docs/terminal-design.md](docs/terminal-design.md).
