# Documentation

These guides describe the current implementation. They were last audited on **2026-10-25**, when the terminal app was removed and the desktop app became the only interface. Example model IDs, paths, and provider URLs must be replaced with values from your installation. A model's advertised capability or a measured local profile is not a universal default.

## Use Demesne

| Guide | Contents |
| --- | --- |
| [Getting started](../README.md) | Build, connect a provider, launch, approvals, recovery |
| [Commands and keyboard](commands.md) | Slash commands, shortcuts, custom commands and workflows |
| [Configuration](configuration.md) | File precedence, providers, limits, environment variables |
| [Authentication](authentication.md) | Codex plan, ChatGPT accounts, OpenRouter, API keys, credential ownership |
| [Desktop app](desktop.md) | The Electron window: layout, development, bundles, lifecycle |
| [Subagents and concurrency](subagents.md) | Routing, read-only tools, provider slots, Qwen sizing |
| [Agent Drive](agent-drive.md) | NEXT, missions, project memory, check-ins, loop protection |
| [Questions and interviews](questions.md) | Typed composer answers, adaptive follow-ups, saved drafts, pause and recovery |
| [Themefy and themes](themes.md) | LLM color interviews, instant palettes, saved themes, contrast validation and undo |
| [Images](images.md) | What the daemon stores from tools, model vision, routes and limits |
| [The always-on assistant](assistant.md) | Running the model and daemon at login on Windows; the personal-assistant build steps |
| [Heartbeat](heartbeat.md) | Messages between agents on this and paired machines: addresses, mail as turns, the tool |
| [Troubleshooting](troubleshooting.md) | Startup, old builds, opening the app, sign-in, stalled work |

## Build and maintain

- [Architecture and API map](architecture.md)
- [Interface design](interface-design.md)
- [Desktop workspace code](../apps/desktop/workspace/README.md): host, state wire, Markdown, Drive
- [Contribution and verification workflow](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

## Source of truth

When behavior is unclear, follow the linked implementation and tests:

- Entry points: [desktop](../apps/desktop/README.md), [daemon](../apps/daemon/src/main.ts).
- Configuration and defaults: [config package](../packages/config/src/index.ts).
- Routes and shared types: [daemon API](../apps/daemon/src/app.ts), [protocol](../packages/protocol/src/index.ts), [typed client](../packages/client/src/index.ts).
- Agent execution: [engine](../apps/daemon/src/engine.ts), [subagents](../apps/daemon/src/subagent.ts), [Drive controller](../packages/drive/src/agent-drive.ts).
- Shared code: [Drive](../packages/drive/src), [conversation workbench](../packages/workbench/src), [setup and config](../packages/setup/src).
- Current scripts: [package.json](../package.json), [desktop checks](../apps/desktop/README.md#verification).

Mermaid diagrams in these guides render on GitHub. Their text remains readable in Markdown viewers without diagram support.
