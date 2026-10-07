# Documentation

These guides describe the current implementation, including direct ChatGPT inference and retirement of the separate Codex runtime provider. The provider guides were updated on **2026-10-05**; the broader documentation audit was on **2026-10-03**. Example model IDs, paths, and provider URLs must be replaced with values from your installation. A model's advertised capability or a measured local profile is not a universal default.

## Use Demesne

| Guide | Contents |
| --- | --- |
| [Getting started](../README.md) | Build, connect a provider, launch, approvals, recovery |
| [Commands and keyboard](cli-reference.md) | CLI, slash commands, headless output, current shortcuts |
| [Configuration](configuration.md) | File precedence, providers, limits, environment variables |
| [Authentication](authentication.md) | ChatGPT accounts, OpenRouter, API keys, credential ownership |
| [Desktop app](desktop.md) | The interface: Tauri window, opening from the terminal, native project picker, development, bundles, lifecycle |
| [Subagents and concurrency](subagents.md) | Routing, read-only tools, provider slots, Qwen sizing |
| [Agent Drive](agent-drive.md) | NEXT, missions, project memory, check-ins, loop protection |
| [Questions and interviews](questions.md) | Typed composer answers, adaptive follow-ups, saved drafts, pause and recovery |
| [Themefy and themes](themes.md) | LLM color interviews, instant palettes, saved themes, contrast validation and undo |
| [Image preview](artifact-preview-plan.md) | Supported producers, formats, controls, current limitations |
| [Troubleshooting](troubleshooting.md) | Startup, old builds, opening the desktop window, sign-in, stalled work |

## Build and maintain

- [Architecture and API map](architecture.md)
- [Artifact pipeline implementation](artifact-preview-implementation.md)
- [Interface design contract](terminal-design.md)
- [Shared interface code](../apps/graphics/README.md): panels, Review, Drive
- [Contribution and verification workflow](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

The two artifact-preview filenames are retained for existing links; they now document the delivered feature rather than an unchecked implementation plan. Historical release notes are identified as historical, and are not setup instructions.

## Source of truth

When behavior is unclear, follow the linked implementation and tests:

- Entry points: [desktop](../apps/desktop/README.md), [CLI](../apps/cli/src/main.ts), [desktop launcher](../apps/cli/src/desktop-launcher.ts), [daemon](../apps/daemon/src/main.ts).
- Configuration and defaults: [config package](../packages/config/src/index.ts).
- Routes and shared types: [daemon API](../apps/daemon/src/app.ts), [protocol](../packages/protocol/src/index.ts), [typed client](../packages/client/src/index.ts).
- Agent execution: [engine](../apps/daemon/src/engine.ts), [subagents](../apps/daemon/src/subagent.ts), [Drive controller](../apps/cli/src/agent-drive.ts).
- Current scripts: [package.json](../package.json), [desktop checks](../apps/desktop/README.md#verification).

Mermaid diagrams in these guides render on GitHub. Their text remains readable in Markdown viewers without diagram support.
