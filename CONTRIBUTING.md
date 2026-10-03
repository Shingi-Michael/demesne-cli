# Contributing to Demesne

[Documentation index](docs/README.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

## Development setup

Use the Bun version pinned in [package.json](package.json):

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Run the daemon and graphics client in separate terminals:

```sh
bun run daemon
```

```sh
bun run graphics:setup
bun run demesne
```

Run the interactive UI directly in Ghostty. Without provider configuration the daemon uses a deterministic placeholder processor. Unit tests and graphics fixtures use deterministic/fake providers; normal verification does not need paid inference or a second local model process.

For distributable binaries, build both components:

```sh
bun run build
bun run build:graphics
```

Keep `dist/graphics` and the daemon’s native image dependencies with the CLI. Rebuilding does not replace an already-running daemon or Electron process. See [rebuilds and running processes](docs/troubleshooting.md#rebuilds-and-running-processes).

## Repository map

| Location | Responsibility |
| --- | --- |
| `apps/daemon/` | HTTP API, coding turns, tools, approvals, scheduling, reviews, proposals and artifact ingestion |
| `apps/cli/` | Commands, headless client, setup and reusable Drive controller |
| `apps/graphics/` | Browser UI, authenticated host, terminal input/tile bridge and visual fixtures |
| `packages/protocol/` | API/event types, validation and Drive/panel contracts |
| `packages/client/` | Typed authenticated HTTP/SSE client |
| `packages/config/` | TOML/environment loading, defaults and private config writes |
| `packages/providers/` | Chat Completions and ChatGPT Responses adapters |
| `packages/chatgpt-auth/` | Registration, OAuth callback, token verification, storage and refresh |
| `packages/storage/` | SQLite sessions, journal, checkpoints, artifacts and command records |
| `packages/brand/` | Themes, slash-command grammar and plain terminal formatting |
| `scripts/` | Build, setup and deterministic provider utilities |

## Implementation conventions

- Keep protocol changes additive where possible. Bump `PROTOCOL_VERSION` for breaking changes, and update client/runtime validation together.
- Keep credentials, filesystem and authenticated daemon requests in the host/daemon. The sandboxed browser receives public snapshots through its narrow preload bridge.
- Prefer pure reducers/formatters and dependency injection for fetch, process spawning and clocks. Test boundaries rather than duplicating implementation details.
- Keep rendering tied to recorded facts. A proposal, successful tool result, historical check and fresh verification are different states.
- Do not silently broaden permissions, expose secrets, or treat host commands/MCP servers as sandboxed.
- Explain the user-visible effect and relevant tradeoffs. Add dependencies only when they solve a concrete need.
- Update the linked guide when changing commands, config, API contracts, UI behavior or operational limits. Label experiments and measured profiles with their scope and date.

## Verification

All code PRs run `bun run typecheck` and `bun test`. [CI](.github/workflows/ci.yml) installs with the frozen lockfile and runs tests under a temporary home on Linux. Native Electron/Ghostty checks are separate; they are not covered by a green Linux unit-test job.

| Change | Additional relevant checks |
| --- | --- |
| Graphics behavior/layout | `bun run graphics:check`; focused panel/file/scale fixtures |
| Drive | Controller/unit tests, `check-drive-tasks.ts`, `check-drive-next.ts` |
| Renderer lifecycle | `check-disconnect.ts`, `check-subagent-shutdown.ts` |
| Streaming/render cost | `check-streaming.ts`; benchmark only when performance changes |
| Packaging | Both builds and relevant checks against packaged assets |
| Provider/auth/tool execution | Adapter, auth, engine and approval fixtures; never real credentials in test fixtures |
| Documentation only | Validate relative links/anchors, source names, script commands and config examples; preview diagrams |

Graphics check commands, output locations and Retina options are documented in the [graphics README](apps/graphics/README.md#verification). Benchmarks report their measurement boundary; input-to-decoded-pixels measurements do not include Ghostty presentation/display latency.

## Pull requests

Keep changes scoped. Lead the description with the concrete problem and resulting behavior, then list the checks actually run and any relevant limits. Do not claim a source-only check validated the installed build. Preserve unrelated local work, and do not stop a user’s active daemon just to run an isolated fixture.
