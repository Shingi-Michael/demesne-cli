# Changelog

All notable changes to Demesne are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT license, security policy, and contribution guide.
- Continuous integration and multi-architecture release workflows.
- Install script for macOS release artifacts.
- User and project TOML configuration with strict key validation and
  environment-variable precedence.
- `demesne setup` provider wizard and `demesne doctor` diagnostics with
  `--json` output.
- Daemon auto-start policy plus `demesne daemon start|stop|status|logs`.
- Workspace instructions from `DEMESNE.md` or `AGENTS.md`, read per turn and
  capped at 32 KiB.
- Product version in `/healthz`, single-sourced from the root package manifest.
- Prompt editor with history, readline keybindings, kill ring, undo, reverse
  search, word motion, and `$EDITOR` composition. History persists privately in
  the data directory and is tagged by workspace.
- Syntax highlighting for fenced code blocks, real unified diffs for edit
  previews and scrollback, visible failure messages for tools, and optional
  OSC 8 hyperlinks for file paths.
- Workspace git branch in session state and the footer, a five-cell context
  meter, and desktop notifications for long completions and pending approvals.
- Type-ahead queue: text typed while a turn streams appears in the footer and
  submits automatically when the turn finishes.
- `@` file mentions with a ranked completion menu backed by a workspace file
  listing endpoint that applies the sensitive-path policy.
- Persistent approval allowlists: a fourth approval option saves scoped rules
  to `[permissions] allow`, the daemon re-reads them on change, and host
  commands persist exact argv while bare `run_command` rules are rejected.
- Session management: rename, archive, title and transcript search (FTS5 with
  a LIKE fallback), and Markdown or JSON transcript export, backed by a storage
  schema migration that backfills the search index.
- `/model` picker with exact-id or unique-prefix switching, a per-session
  preferred-model hint on resume, and a storage column to record it.
- Change review and scoped undo: `GET /v1/sessions/:id/changes` returns
  per-file additions, modifications, deletions, and plain diffs, `/diff`
  renders them, and `/undo <path>` reverts a single file while the remaining
  files stay undoable (schema v4 tracks per-file revert state).
- Plan mode: `/plan <prompt>` and `--plan` submit a read-only turn that offers
  only inspection tools and denies write or execution calls even if the model
  requests them (schema v5 stores the flag).
- Custom slash commands from Markdown files in `~/.demesne/commands/` and
  `<workspace>/.demesne/commands/`, with optional frontmatter descriptions,
  `$ARGUMENTS` substitution, project-over-user precedence, and built-in names
  protected from shadowing.

## [0.1.0] - 2026-09-18

### Added

- Durable local daemon owning model requests, workspace tools, approvals, SQLite
  state, and resumable SSE event streams.
- Streaming terminal client with a fixed footer, phase-aware beacon, ANSI- and
  grapheme-safe response pacing, and a shared slash-command grammar.
- Bounded coding tools: listing, paged reads, batch reads, ripgrep search,
  create/append/batch edits, atomic writes, git status/diff, move, delete, and
  approved host commands with background handles.
- Per-call approval broker with session-scoped write grants and conflict-checked
  turn undo.
- Deterministic context planning with schema-3 reduction, cache-aware
  delayed-hard planning for strict llama.cpp profiles, and provider-reported
  usage inspection.
- Runtime profile verification for strict Ollama and llama.cpp deployments.
- Measurement harnesses for provider throughput, long context, retrieval,
  scheduling, context reduction, and staged memory.
