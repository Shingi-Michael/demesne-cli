# Documentation

These guides describe the current implementation. They were last audited on **2026-10-20**, after the side panels and Drive's screen-control mode were removed and the desktop code moved into `apps/desktop`. Example model IDs, paths, and provider URLs must be replaced with values from your installation. A model's advertised capability or a measured local profile is not a universal default.

## Use Demesne

| Guide | Contents |
| --- | --- |
| [Getting started](../README.md) | Build, connect a provider, launch, approvals, recovery |
| [Commands and keyboard](cli-reference.md) | CLI, slash commands, headless output, current shortcuts |
| [Configuration](configuration.md) | File precedence, providers, limits, environment variables |
| [Authentication](authentication.md) | ChatGPT accounts, OpenRouter, API keys, credential ownership |
| [Desktop app](desktop.md) | The Electron window: layout, opening from the terminal, development, bundles, lifecycle |
| [Subagents and concurrency](subagents.md) | Routing, read-only tools, provider slots, Qwen sizing |
| [Agent Drive](agent-drive.md) | NEXT, missions, project memory, check-ins, loop protection |
| [Questions and interviews](questions.md) | Typed composer answers, adaptive follow-ups, saved drafts, pause and recovery |
| [Themefy and themes](themes.md) | LLM color interviews, instant palettes, saved themes, contrast validation and undo |
| [Images](images.md) | What the daemon stores from tools, model vision, routes and limits |
| [Heartbeat](heartbeat.md) | Messages between agents on this and paired machines: addresses, mail as turns, the tool |
| [Troubleshooting](troubleshooting.md) | Startup, old builds, opening the desktop window, sign-in, stalled work |

## Build and maintain

- [Architecture and API map](architecture.md)
- [Interface design](interface-design.md)
- [Desktop workspace code](../apps/desktop/workspace/README.md): host, state wire, Markdown, Drive
- [Contribution and verification workflow](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

Historical release notes and [the pre-desktop history](history/pre-graphics-evolution.md) are identified as historical, and are not setup instructions.

## Source of truth

When behavior is unclear, follow the linked implementation and tests:

- Entry points: [desktop](../apps/desktop/README.md), [CLI](../apps/cli/src/main.ts), [desktop launcher](../apps/cli/src/desktop-launcher.ts), [daemon](../apps/daemon/src/main.ts).
- Configuration and defaults: [config package](../packages/config/src/index.ts).
- Routes and shared types: [daemon API](../apps/daemon/src/app.ts), [protocol](../packages/protocol/src/index.ts), [typed client](../packages/client/src/index.ts).
- Agent execution: [engine](../apps/daemon/src/engine.ts), [subagents](../apps/daemon/src/subagent.ts), [Drive controller](../packages/drive/src/agent-drive.ts).
- Shared code: [Drive](../packages/drive/src), [conversation workbench](../packages/workbench/src), [setup and config](../packages/setup/src).
- Current scripts: [package.json](../package.json), [desktop checks](../apps/desktop/README.md#verification).

Mermaid diagrams in these guides render on GitHub. Their text remains readable in Markdown viewers without diagram support.
