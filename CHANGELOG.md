# Changelog

Current release status is **0.1.0 plus unreleased development on main**. The entries below summarize delivered code as of 2026-10-05; they do not claim a new published release. See the [documentation index](docs/README.md) for current setup and commands.

## [Unreleased]

### Removed

- Proof marks: answers no longer carry underlined claims, the "N proved · M not checked" line, Prove it, or the extra model call after each answer that made them. The daemon's proof pass and `/proofs` route, the `turn.proofs` events, the Settings › Models switch and `[agent] proof_marks` are gone (a config that still names the key loads and ignores it).
- Self-build (Try it here, Your look · Keep · Go back): the window no longer rebuilds its own page from the open project or swaps the installed app, and chats in the Demesne checkout are no longer told to leave building and launching to the app. An agent in that project builds and relaunches Demesne like any other command.
- The terminal app: the `demesne` command (terminal chat, `setup`, `doctor`, `auth`, `prompt`, `drive`, `daemon`), `install.sh` and the CLI release tarballs. Demesne is now only the desktop app, which carries its own daemon. Sign-in and setup live in the app under Settings › Providers.

### Changed

- Foundry shows what it made the way Claude shows an artifact: a chip in the conversation (kind, title, version) and the page itself in a pane beside the chat, edge to edge, with one line of controls above it (title, version arrows, Preview · Code, phone width, close) and one below (version note, Copy, Export, Revise, Open in Foundry, Make this the latest). A new artifact opens the pane by itself, a new version moves it on, Esc closes it, and each chat remembers whether it was open. The boxed 480px card that sat in the conversation under each save is gone.

### Added

- Foundry revises like a file: `foundry_edit` applies exact find-and-replace edits to the version the model read, and `foundry_save` takes the same `base_version`, so a version you changed by hand (Edit source) or in another chat is never overwritten; the model is told to read the latest version and carry its change onto it. Artifact frames may now load pinned libraries from cdnjs, jsdelivr and unpkg and Google Fonts, so charts, React and real typefaces work; everything else stays blocked. The tools carry a design brief (custom-property colours with a dark set, hairlines over outlines, phone width, no stock AI looks, Demesne's tokens for Demesne UI).
- Drive's word in the title bar: while Drive makes a branch elsewhere the chat's title bar ends in a breathing dot and the mission, green "Ready · mission" once the branch is ready; click opens Drive's chat. The strip that sat on the panel's right edge is gone, so the chat keeps its full width.
- Codex provider: sign in to your Codex plan under Settings › Providers and Demesne talks to Codex's backend directly, with Codex's own OAuth (`localhost:1455`, PKCE) and no Codex app or CLI. Models are `codex/<slug>` from the plan's live catalog, usage counts against the plan's 5-hour and weekly windows rather than credits, and the plan's state shows in the model picker. A sign-in left by the earlier managed Codex home carries over once. The ChatGPT provider stays as the credit-metered route.
- Workflows: a markdown file in `.demesne/workflows/` (or `~/.demesne/workflows/`) lists steps, and `/<name> <goal>` runs them in order as one Drive mission in its own worktree. A step's `check:` command is run by Drive itself and must pass (or fail, with `expect: fail`) before the next step starts. The live block shows each step's check, and the receipt counts steps.

- Releases include the desktop app: `demesne-desktop-darwin-arm64.zip` for Apple silicon Macs and `demesne-desktop-linux-amd64.deb` for Ubuntu 22.04/24.04, so installing demesne no longer needs Bun or Rust.
- Label a GitHub issue `drive` to queue it for Drive: open ones become Next proposals, and the PR Drive opens for one says `Closes #n`.
- Away mode: **Run top 3 away** (a link in the Next heading) has the daemon work through Drive's top proposals one after another, each in its own worktree. Finished branches fold into one "While you were away" card, a line each; click one to open its Apply / Open PR / Discard.
- Drive keeps working when you close the window: a running mission is handed to a background process with no window, which carries it to the end and commits a worktree mission for review. Opening the project again takes it back and resumes it in the window.
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

- A sub-agent is one step on the guide: "Agent · task" with "N steps" on the right while it works and "✓ N steps · time" when done; click it and its own steps unfold one level in, drawn like the turn's (reads fold as Explored), ending in what it found. The "Sub-agent trace" box, its arrow lines and thinking are gone; the saying that cycles after the task while the agent works stays. Sub-agents run with thinking off, whatever the chat chose.
- Normal interactive `demesne` launches the graphics UI; non-interactive use retains the streaming CLI. The former text workbench and its `ui:*` preview scripts are removed.
- Graphics delivery uses GPU rasterization, parallel compressed RGBA tile encoding, local file transfer when supported, backpressure and incremental state updates.
- Plain `/drive MISSION` is continuous by default. Explicit `--bounded` and NEXT’s Run action stop after the bounded mission is verified.
- Documentation now separates current behavior, configuration, auth, concurrency, previews, operations and historical notes, with linked source references and flow diagrams.
- Removed the separate Codex runtime provider, CLI auth commands and executable dependency. Legacy `auth = "codex"` sections are retired during config loading; remaining providers and saved sessions are preserved, and the next config write backs up the original.

### Removed

- The Ghostty terminal interface is removed, along with its Electron renderer and Kitty image transport. The desktop window is now the interface. `demesne` in a terminal opens it on the current folder, and `demesne prompt` remains for scripts.

### Fixed

- A `/drive` mission in its own worktree no longer stops at its first decision with "Drive observations must belong to the mission's workspace": Drive now observes the worktree session at the worktree's root.
- Custom commands in `.demesne/commands/` show in the desktop app's slash list and send their prompt; the desktop app didn't load them before.
- Linux graphics startup now installs a missing source runtime, verifies sandboxed rendering, preserves desktop authentication variables, and diagnoses sandbox/display/library failures. Explicit helper repair uses a protected, verified copy; workspace permission errors name the folder and a non-recursive remedy. Linux graphics CI covers Ubuntu 20.04/24.04 userlands and packaged startup.

- Responses streams with completed output items but empty terminal output no longer lose their tool calls. Truly incomplete or malformed tool calls are still rejected before execution.
- Per-provider capacity no longer requires all configured backends to share one global inference allowance.
- Drive reviews acquire a provider slot before reading fresh worker evidence and reject stale corrections; completed tasks require explicit or evidence-backed reopening.
- The NEXT/composer pixel mismatch uses a stable compositor layer without hiding pixels or increasing capture tolerance.
- Renderer output-pipe closure, asynchronous `EPIPE` and startup/shutdown races now terminate cleanly instead of displaying an uncaught Electron main-process exception. Packaging includes the pipe lifecycle helper.


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
