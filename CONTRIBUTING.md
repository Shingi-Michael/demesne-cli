# Contributing to Demesne

## Development Setup

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Run the daemon and client from source:

```sh
bun run daemon
bun run demesne
```

Without model configuration the daemon uses a deterministic placeholder
processor, which is enough for most development and every test.

## Repository Layout

```text
apps/daemon/       HTTP daemon, agent turn loop, tools, permissions, benchmarks
apps/cli/          Streaming command-line client
packages/protocol/ Shared API and event contracts
packages/providers/OpenAI-compatible provider adapters
packages/storage/  SQLite state and event journal
packages/brand/    Palette, slash-command grammar, terminal text formatting
```

## Conventions

- Keep protocol changes additive. Add optional fields; bump
  `PROTOCOL_VERSION` only for breaking changes.
- Terminal behavior should live in pure reducers or formatters with unit tests,
  the way `interrupt-key.ts`, `approval-selection.ts`, and the `brand` package
  are structured. Keep I/O at the edges.
- Prefer dependency injection over module mocking for `fetch`, spawning, and
  clocks.
- Comments explain why a behavior exists, not what a line does. Match the
  surrounding density.
- New user-visible behavior needs tests in the owning package's `test/`
  directory.
- No new runtime dependencies without a strong reason. `brand`, `protocol`,
  and `config` are intentionally dependency-free.

## Pull Requests

- Run `bun run typecheck` and `bun test` before opening a PR.
- Keep changes scoped; separate behavior changes from refactors.
- Describe the user-visible effect and the tests that cover it.
