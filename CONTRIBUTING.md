# Contributing to Demesne

[Documentation index](docs/README.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

## Development setup

Use the Bun version pinned in [package.json](package.json):

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Run the daemon and the desktop window in separate terminals:

```sh
bun run daemon
```

```sh
bun run desktop
```

The desktop window needs [Rust and the platform dependencies](docs/desktop.md#prerequisites). `bun run demesne` in a terminal opens the same window on the current folder. Without provider configuration the daemon uses a deterministic placeholder processor. Unit tests and desktop checks use deterministic/fake providers; normal verification does not need paid inference or a second local model process.

For distributable binaries, build the CLI and daemon, then the desktop app:

```sh
bun run build
bun run build:desktop
```

Keep the daemon’s native image dependencies in `dist/node_modules` with the CLI. Rebuilding does not replace an already-running daemon or desktop window. See [rebuilds and running processes](docs/troubleshooting.md#rebuilds-and-running-processes).

## Desktop development

The desktop window shows the shared UI from `apps/graphics` directly in a Tauri system webview.

Keep the authenticated daemon client and credentials in the backend. Native dialogs, clipboard operations, and external opening must pass through validated desktop commands. See the [desktop implementation guide](apps/desktop/README.md) for the process boundary and test commands.

## Repository map

| Location | Responsibility |
| --- | --- |
| `apps/daemon/` | HTTP API, coding turns, tools, approvals, scheduling, reviews, proposals and artifact ingestion |
| `apps/cli/` | Commands, headless client, setup and reusable Drive controller |
| `apps/desktop/` | Tauri window, restricted native bridge, Bun host sidecar, desktop integration checks |
| `apps/graphics/` | Shared interface code shown by the desktop window: browser UI, authenticated host, state wire and Markdown |
| `packages/protocol/` | API/event types, validation and Drive/panel contracts |
| `packages/client/` | Typed authenticated HTTP/SSE client |
| `packages/config/` | TOML/environment loading, defaults and private config writes |
| `packages/providers/` | Chat Completions and ChatGPT Responses adapters |
| `packages/chatgpt-auth/` | Registration, OAuth callback, token verification, storage and refresh |
| `packages/storage/` | SQLite sessions, journal, checkpoints, artifacts and command records |
| `packages/brand/` | Themes, slash-command grammar and plain terminal formatting |
| `scripts/` | Build, install, desktop launch and checks, and deterministic provider utilities |

## Implementation conventions

- Keep protocol changes additive where possible. Bump `PROTOCOL_VERSION` for breaking changes, and update client/runtime validation together.
- Keep credentials, filesystem and authenticated daemon requests in the host/daemon. The webview receives public snapshots and sends named actions through the restricted desktop bridge.
- Prefer pure reducers/formatters and dependency injection for fetch, process spawning and clocks. Test boundaries rather than duplicating implementation details.
- Keep rendering tied to recorded facts. A proposal, successful tool result, historical check and fresh verification are different states.
- Do not silently broaden permissions, expose secrets, or treat host commands/MCP servers as sandboxed.
- Explain the user-visible effect and relevant tradeoffs. Add dependencies only when they solve a concrete need.
- Update the linked guide when changing commands, config, API contracts, UI behavior or operational limits. Label experiments and measured profiles with their scope and date.

## Verification

All code PRs run `bun run typecheck` and `bun test`. [CI](.github/workflows/ci.yml) installs with the frozen lockfile and runs tests under a temporary home on Linux. The [desktop workflow](.github/workflows/desktop.yml) builds the app and runs the Linux WebDriver check under Xvfb. That is not a GPU or Wayland test. Native macOS checks remain separate.

| Change | Additional relevant checks |
| --- | --- |
| Desktop UI/bridge/lifecycle | `bun run desktop:check`; Rust tests and desktop bundle build |
| Shared UI behavior/layout | `bun test apps/graphics/test`; `bun run desktop:check` |
| Drive | Controller/unit tests; `bun run desktop:check` when the panel changes |
| Packaging | Both builds and relevant checks against packaged assets |
| Provider/auth/tool execution | Adapter, auth, engine and approval fixtures; never real credentials in test fixtures |
| Documentation only | Validate relative links/anchors, source names, script commands and config examples; preview diagrams |

Desktop check commands and output locations are documented in the [desktop implementation guide](apps/desktop/README.md#verification).

## Pull requests

Keep changes scoped. Lead the description with the concrete problem and resulting behavior, then list the checks actually run and any relevant limits. Do not claim a source-only check validated the installed build. Preserve unrelated local work, and do not stop a user’s active daemon just to run an isolated fixture.
