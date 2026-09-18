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
