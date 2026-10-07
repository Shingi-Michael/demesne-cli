# Changelog

Current release status is **0.1.0 plus unreleased development on main**. The entries below summarize delivered code as of 2026-10-05; they do not claim a new published release. See the [documentation index](docs/README.md) for current setup and commands.

## [Unreleased]

### Added

- Model scoreboard: the model picker shows how each model has done on your own work over the last 30 days (turns finished, tool calls without errors, speed, checks passing, Drive runs kept), and `demesne models scoreboard` prints it as a table, marking local models.
- Drive learns its own accuracy: every proposal you Run records whether it landed and how long it took, and Next ranks with this project's landing rate per confidence level and scales time estimates by how far off they have been. The Next heading shows the hit rate.
- Drive mission receipts: the review card shows how many tasks the recorded checks verify, and Copy receipt / Open PR carry a Markdown receipt that separates verified work from claims.
- `/drive` missions work in their own git worktree and session, then commit the result for Apply / Open PR / Discard and return you to your session. `--here` keeps a mission in the current session.
- Drive Next's **Run** works in its own git worktree and branch, with the breakage-fix card's Apply / Open PR / Discard. Your checkout is untouched until you apply it; outside git it falls back to a bounded mission.

- `/themefy` adaptive composer interviews, instant validated palettes, saved custom themes and persistent theme undo in the shared desktop/Ghostty interface. Theme interviews have a restricted tool scope and stay out of coding context.

- Default Ghostty graphics UI using offscreen Electron/Chromium and Kitty image tiles, with browser typography, Markdown, syntax highlighting, math, themes and responsive scaling.
- Files/source navigation, recorded and workspace diffs, verification freshness and reruns, command inspection/stop, image zoom/pan/reference comparison, history and context panels.
- Durable image artifacts from tools, MCP and a separately configured image backend; authenticated content routes and optional model vision hydration.
- ChatGPT account sign-in with private OAuth storage/refresh, account model discovery, a Responses adapter and supported reasoning choices; OpenRouter and OpenAI-compatible providers remain available.
- Direct GPT-6.1 Sol selection through ChatGPT sign-in, with an account access check when the catalog omits it and complete tool calls handled by Demesne.
- Read-only subagents with independent model selection and per-provider inference queues/slot limits, allowing supported servers to service concurrent tasks without loading a model per agent.
- Drive task criteria, completion evidence, persistent project memory, bounded/continuous modes, checkpoint-based live reviews and direct daemon control.
- Drive NEXT: collected workspace/repository signals, evidence-linked model proposals, Run/Plan first/Not now/Never actions, start-screen suggestions and rail counts.
- Validated manual compaction with durable checkpoints, replay, cancellation and retained original history.

### Changed

- Normal interactive `demesne` launches the graphics UI; non-interactive use retains the streaming CLI. The former text workbench and its `ui:*` preview scripts are removed.
- Graphics delivery uses GPU rasterization, parallel compressed RGBA tile encoding, local file transfer when supported, backpressure and incremental state updates.
- Plain `/drive MISSION` is continuous by default. Explicit `--bounded` and NEXT’s Run action stop after the bounded mission is verified.
- Documentation now separates current behavior, configuration, auth, concurrency, previews, operations and historical notes, with linked source references and flow diagrams.
- Removed the separate Codex runtime provider, CLI auth commands and executable dependency. Legacy `auth = "codex"` sections are retired during config loading; remaining providers and saved sessions are preserved, and the next config write backs up the original.

### Removed

- The Ghostty terminal interface is removed, along with its Electron renderer and Kitty image transport. The desktop window is now the interface. `demesne` in a terminal opens it on the current folder, and `demesne prompt` remains for scripts.

### Fixed

- Linux graphics startup now installs a missing source runtime, verifies sandboxed rendering, preserves desktop authentication variables, and diagnoses sandbox/display/library failures. Explicit helper repair uses a protected, verified copy; workspace permission errors name the folder and a non-recursive remedy. Linux graphics CI covers Ubuntu 20.04/24.04 userlands and packaged startup.

- Responses streams with completed output items but empty terminal output no longer lose their tool calls. Truly incomplete or malformed tool calls are still rejected before execution.
- Per-provider capacity no longer requires all configured backends to share one global inference allowance.
- Drive reviews acquire a provider slot before reading fresh worker evidence and reject stale corrections; completed tasks require explicit or evidence-backed reopening.
- The NEXT/composer pixel mismatch uses a stable compositor layer without hiding pixels or increasing capture tolerance.
- Renderer output-pipe closure, asynchronous `EPIPE` and startup/shutdown races now terminate cleanly instead of displaying an uncaught Electron main-process exception. Packaging includes the pipe lifecycle helper.

Earlier intermediate UI changes are retained in [historical development notes](docs/history/pre-graphics-evolution.md). Their commands and defaults may be obsolete.

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
