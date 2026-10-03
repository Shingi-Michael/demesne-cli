# Demesne CLI

Demesne is a terminal coding agent with a web-rendered interface inside Ghostty. A local daemon owns model requests, tools, approvals, session history, and artifacts. The interface can close while daemon-owned work continues.

Use local OpenAI-compatible servers, OpenRouter, or **Continue with ChatGPT**. Delegate independent investigations to read-only subagents, or give **Agent Drive** a mission to coordinate and verify work.

[Documentation](docs/README.md) · [Commands](docs/cli-reference.md) · [Configuration](docs/configuration.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Install and start

Build from source with [Bun](https://bun.sh) 1.4.0. Interactive use requires Ghostty/Kitty graphics support and the Electron runtime. [ripgrep](https://github.com/BurntSushi/ripgrep) is optional; workspace search has a fallback.

```sh
git clone https://github.com/Shingi-Michael/demesne-cli
cd demesne-cli
bun install --frozen-lockfile
bun run build
bun run build:graphics
./dist/demesne setup
./dist/demesne daemon start
./dist/demesne
```

Keep the whole release layout together:

```text
dist/
├── demesne       # command-line entry point
├── demesned      # local daemon
├── node_modules/ # native image codecs for the daemon
└── graphics/     # compiled UI host, Electron, renderer, fonts, assets
```

`bun run build` builds the CLI and daemon; **interactive use also needs `bun run build:graphics`**. The smaller build still supports headless commands. If desired, link both binaries into an existing directory on your PATH:

```sh
ln -sf "$PWD/dist/demesne" "$PWD/dist/demesned" /usr/local/bin/
```

From a checkout, `bun run graphics:setup` installs the graphics runtime and `bun run demesne` launches the application. See the [graphics guide](apps/graphics/README.md) for source and packaged launch options.

## Connect a model

```sh
demesne auth login chatgpt      # browser sign-in with an eligible ChatGPT account
demesne auth login openrouter   # browser sign-in or OPENROUTER_API_KEY
demesne setup                  # local server, hosted sign-in, or custom endpoint
```

Choose one of these routes. Setup lists models and saves the user configuration. Standalone hosted login preserves an existing local provider by adding another provider. Restart an idle daemon after changing provider configuration, then choose a model with `/model`.

ChatGPT credentials stay in Demesne's private credential store. Eligible requests use the ChatGPT plan; API-key billing is not substituted automatically. Read [authentication](docs/authentication.md) for account switching, logout, usage, and API differences.

## Work in a project

```sh
cd /path/to/project
demesne
demesne chat "Inspect the parser and explain its entry points"
demesne --session SESSION_ID
```

The interactive `demesne` command opens the graphics UI. `demesne graphics` and `demesne --graphics` are explicit alternatives. The old ANSI full-screen workbench and `ui:session`/`ui:image` preview scripts are no longer current entry points. For text output and automation, use `demesne prompt`.

The start screen has a composer, project/session history, starter prompts, and the top **Drive proposes** items. In a conversation, reasoning, tools, subagent cards, changes, and verification remain attached to the turn that produced them. Fenced code, Markdown tables, and mathematical notation render in the graphics interface.

| Task | Control |
| --- | --- |
| Send / insert a newline | Enter / Shift+Enter |
| Settings and model selection | Tab on an empty composer, or Ctrl+K |
| Stop a turn | Esc twice within 1.5 seconds after closing menus/panels, or Ctrl+C |
| Close the interface | Ctrl+Q; daemon work remains available |
| Follow live output | Ctrl+G |
| Changes / Files / Verification | Alt+D / Alt+O / Alt+T |
| Log / Context / Preview | Ctrl+B / Alt+C / Alt+V |
| Drive / History | Alt+J / Alt+H |

See the [command and keyboard reference](docs/cli-reference.md) and [panel guide](apps/graphics/README.md#review-panel-upgrades).

## Subagents and Drive

`/subagent` chooses the default model for delegated work; `/subagent same` returns to the main model. A subagent receives a separate context and read-only tools, then returns a report. Multiple agents can be active while model generation is queued or concurrent, depending on the provider's configured slots. [Subagents and concurrency](docs/subagents.md) explains the limits and the tested three-slot Qwen configuration.

Drive uses recorded daemon state and API actions by default. `/drive <mission>` starts continuous delegation; `/drive --bounded <mission>` finishes after one verified task. **Run** in the NEXT queue always starts a bounded mission. Drive cannot approve tools or answer human questions. Its ledger and project memory keep criteria, outcomes, vetoes, and evidence across runs. Read [Agent Drive](docs/agent-drive.md).

## Approvals and scripting

Reads and searches are automatic; file changes and host commands require approval unless a matching saved grant applies. Commands run as your OS user, **not in a sandbox**. Workspace path restrictions do not confine an approved command or external MCP server. See [security boundaries](SECURITY.md).

```sh
demesne prompt "Explain the test layout"
demesne prompt --output json "List the TODOs"
echo "Explain this failure" | demesne prompt --output stream-json
demesne ps --json
demesne doctor --json
```

Non-interactive execution denies approval requests rather than waiting for a person. [CLI reference](docs/cli-reference.md#headless-output) describes output modes and exit codes.

## Configuration and recovery

The user configuration is `~/.demesne/config.toml`; the default private data directory is `~/.demesne`. Environment variables override config files. The daemon ignores project config for machine-wide provider, MCP, image, and tool-execution settings. [Configuration](docs/configuration.md) documents the precise split and examples.

```sh
demesne daemon status
demesne daemon logs
demesne ps --json             # check for active work before stopping the daemon
demesne daemon stop
demesne daemon start
```

Rebuilding does not replace a running daemon or UI process. Reopen the graphics interface after frontend updates. A daemon restart marks unfinished work interrupted; it does not replay commands automatically. [Troubleshooting](docs/troubleshooting.md) covers stale binaries, authentication, terminal disconnects, and slow inference.

## Develop

```sh
bun run typecheck
bun test
bun run graphics:check
```

[Contributing](CONTRIBUTING.md) lists focused graphics checks, packaging checks, and the repository layout. [Changelog](CHANGELOG.md) records delivered changes; [design contract](docs/terminal-design.md) describes the current interface.
