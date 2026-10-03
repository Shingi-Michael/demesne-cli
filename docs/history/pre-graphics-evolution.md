# Historical development notes

These notes preserve the earlier changelog’s unreleased development record as it stood before the 2026-10-03 documentation audit. They include superseded ANSI workbench layouts, old commands, planned features and intermediate defaults. **They are historical evidence, not current usage instructions.** Consult the [documentation index](../README.md) and [current changelog](../../CHANGELOG.md) for the delivered system.


### Fixed

- Streaming responses now scroll through burst output one row per redraw instead
  of jumping a screenful when several lines arrive together. Catch-up continues
  through completion and stops immediately for manual reading; Live navigation,
  resizing, and reduced-motion mode resolve directly to their target.
- Model output-limit stops and reasoning-only/empty replies now fail explicitly
  instead of silently completing. Provider finish reasons are retained in SQLite
  and replayable events, including usage received after a finish reason. Truncated
  tool calls are rejected before execution; partial answer text remains visible.
  The thinking-Qwen configuration example now uses an 8192-token output budget.

### Added

- Manual `/compact [instructions]` and `demesne compact <session-id>` commands:
  model-generated, validated checkpoints with the latest two conversation turns
  retained in full, estimated before/after context receipts, restart persistence,
  and complete History. Compaction supports cancellation and rolling summaries;
  failure leaves the prior context active, and undo invalidates stale summaries.
- Figma Version 20 composer/footer: square-cornered rectangular Send control,
  prompt and input aligned with its label, compact shortcuts and draft-count row,
  and a separated status strip without standalone scrollback/navigation labels.
- Figma Version 19 session header: cyan top accent, session date, live clock,
  elapsed time since opening, subdued path prefix, and bracketed History hover.
  Start and conversation screens share responsive header geometry.
- Figma Version 17 expanded panels: compact Preview header, centered dark image
  well, single metadata line and quiet inline actions; Files shows real sizes
  and Git status; Diff presents colored hunks without tool-debug chrome.
- Native macOS `capture_window` screenshots for terminal apps such as Demesne
  inside Ghostty, including window selection and actionable Screen Recording
  permission errors. The workbench sets/restores its terminal title for discovery.
- Screenshot-to-Preview integration through image-returning browser MCP tools
  and workspace `view_image` imports. Opt-in provider vision attaches the latest
  two retained images to model requests, with artifact-ID persistence/replay,
  bounded inputs, and text-only fallback. Added a local vision-server launcher.
- First-class `generate_image` agent tool with a separately configured OpenAI
  Images-compatible backend, session-scoped reference edits, cancellation,
  bounded responses, and automatic delivery to the image artifact Preview.
- Figma Version 16 closed sidebar: green/amber status pip, Files/Diff/Preview
  controls with cyan angular hover treatment, centered vertical PANEL label,
  and a bottom bracket marker. The same rail renders on start and conversation
  screens; Files uses the workspace listing and Diff opens recorded changes.
- Initial image-artifact pipeline and Preview panel: structured MCP image outputs,
  persistent original/PNG preview content, authenticated retrieval, Alt+V preview,
  pin/follow/history controls, expanded view, and external original-file opening.
  Kitty graphics and geometry replies are decoded independently of typed input.
  The compiled daemon now packages its native image codec runtime beside the
  executable. Model-free image and PTY fixtures exercise the production path.
- Artifact-preview structure and implementation documents covering image-first
  panel behavior, pinning/history, durable artifact storage, MCP image outputs,
  Kitty graphics, replay, delivery milestones, and acceptance checks. Arcade
  work is deferred; the preview feature is planned rather than implemented.
- Quieter bottom status strip without running/thinking indicators, elapsed time,
  or token speed. Conversation and inspection scrollbars are hidden; streaming
  advances only by newly overflowing rows rather than viewport-sized blocks.
- Fixed trackpad bottom-edge jitter: horizontal wheel events are decoded as
  left/right and ignored by vertical panes, rather than being mistaken for
  up/down. Regression coverage exercises split raw mixed-axis input on a
  completed transcript.
- Version 14 Thinking consistency: one shared amber pulsing-dot renderer for
  live Thinking, RUNNING status, and the running Send control; live cards use
  an amber `[` with the same agent label and timestamp layout as settled cards.
- Version 13 Figma fidelity pass: exact dark canvas/surface/raised tokens, a
  single `[` card marker, red failed-card borders, one agent/timestamp header
  above the complete response stream, compact cyan tool rows, and `▸/▾` Thinking
  disclosures with dim timing. Error output uses a tinted left-rule block.
  Footers keep a bracket-free hairline context meter inline, elapsed seconds,
  lowercase hover-only `copy`, and the status badge at the right edge. The
  composer matches the reference's bottom-aligned glyph, subdued cyan Send,
  running dots, and shortcut accents; the rail uses its compact panel glyph.
  The reference and terminal-cell mapping are documented in `docs/terminal-design.md`.
- Version 11 inference cards and conversation composer: green COMPLETE/red
  FAILED/neutral STOPPED badges, context meters with green/amber/red thresholds,
  and run-local receipts for failures and interruptions without final answers.
  Thinking uses pulsing dots and a live cursor, folding as each round finishes;
  failed tools and turn errors use red-bordered output blocks. The status strip
  follows READY/RUNNING/FAILED and the latest run's recorded context. The composer
  starts with two rows, a cyan focus rule, stateful prompt glyph, filled Send,
  inline token estimate, and a compact shortcut strip, with editable queues and
  Stop/Clear controls. Reduced motion settles all pulses and cursor animation.
  `ui:session --state=round-limit` previews a failed multi-round run.
- Version 9 empty-session start screen: centered input-first composer, animated
  cyan brackets, active model/context, and responsive Explore/Debug/Build/Learn
  cards that fill an undoable draft without sending it. Recent sessions show
  real saved titles, update times, and recorded context; resume and History use
  the existing session commands while preserving drafts. Keyboard navigation,
  hover/focus treatment, reduced motion, and `ui:session --state=start` preview.
- Official Futuristic Terminal Harness Design implemented in the terminal:
  fixed `// demesne` session/project header, cyan request bands, bordered assistant
  cards with cyan corners, amber Thinking, and a ruled composer with Send/Stop.
  Blue-black/cyan/amber/green design tokens, a matching light theme,
  cyan Markdown headings, and a fixed execution/context/navigation strip.
  The collapsed action rail expands into real diffs, tool output, and Context;
  it docks on wide terminals and overlays the conversation on compact screens.
  Session, Activity, Transcript, Settings, and Theme replace
  the older interface terminology throughout the CLI, code, and previews.
- Cyan input-focus outline, live draft-token estimates, a ticking session clock,
  and immutable assistant timestamps restored from recorded events. Copy fades
  in on hover or keyboard selection; response metadata and request edges brighten
  on hover. Thinking uses rotating cell chevrons. A labelled PANEL rail, closer
  request/reply pairing, and more distinct assistant surfaces refine the layout.
  Reduced motion settles transitions immediately while keeping the clock live.
- Thinking, tools, and responses share one chronological reading surface at every
  width. Consecutive confirmed inspections fold into one summary; changes keep
  their paths and commands keep their outcomes. Pending work, approvals,
  failures, and unknown command results stay visible. Thinking, output, diffs,
  and arguments expand in place. Reading anchors survive streaming and queued
  turns. Thinking's live indicator lives beside its inline heading, including before
  the first model text, and stays visible when a long trace fills the viewport.
  Quiet prompt-side timing, measured tok/s, context budget,
  project path, and original response model attribution.
  Execution state remains visible in the fixed bottom strip.
- A footer after each completed model response with labelled elapsed, speed, and
  context measurements, retaining its original mode/model, turn duration, and measured throughput across
  provider rounds. Historical responses restore their own recorded metrics;
  narrow terminals wrap the footer and missing measurements stay explicit.
- Response-start navigation via **Response ↑** or Alt+R, tighter compact footer
  spacing, explicit queued-input handoff labels, contextual focus hints, and
  temporary Copy feedback for mouse, shortcut, and keyboard-selection actions.
- Stable scroll boundaries and response-follow windows: incoming prose grows
  with room below it and advances in overlapping blocks. Scrolling back to the
  bottom resumes following. Input bursts coalesce into synchronized, padded
  terminal frames, avoiding blank-row flashes and idle cursor rewrites.
- Distinct awaiting-approval, running, denied, stopped, and failed tool states
  across live views and replay; interrupted commands no longer count as failed
  checks, and resolved approvals no longer remain marked as waiting in history.
- Changes and Verification open the right action panel with record navigation,
  including historical evidence while the active session continues. Dismissed utility
  output stays in the execution log. Full Changes/Verification review with recorded diffs, command output,
  exit status, and expandable arguments. Verification and failure actions open
  the relevant record directly; missing exit status cannot claim a passing check.
  The full execution log opens on demand with Ctrl+B.
- Tool activity has its own cool-toned surface and a brighter active band. Cyan
  file operations and amber commands/checks distinguish operations
  in the default themes; green success and red attention distinguish outcomes.
  Inline evidence, Review, and the execution log share these semantic roles,
  with matching dark/light palettes and explicit labels when color is disabled.
- Turn-local history, selection, independent scrolling, and live follow, with
  restored evidence on session resume. Keyboard/mouse navigation preserves drafts;
  the prompt supports multiline paste, caret editing, completions, file references,
  queued follow-ups, approvals, Send/Stop, and searchable settings.
- Responsive layouts from 40×10, with at least three reading rows during ordinary
  editing. Markdown wraps visible text without leaking formatting delimiters.
- `bun run ui:session` previews the production renderer without a model. States
  include thinking, working, tools, approval, completion, failures, and long content;
  `--inspect=changes|verification|failure`, `--view=review|log`, `--trace`,
  `--long-draft`, and `--snapshot=80x24` exercise
  inspection and responsive layouts. `ui:workbench` forwards to this preview.
- Optional grouped Activity and chronological Transcript views; the Activity
  preview is `bun run scripts/activity-preview.ts`.

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
- Headless output for scripting: `--output json` and `--output stream-json`,
  stdin prompt piping, automatic non-interactive permission denial, and
  status-based exit codes.
- New `@demesne/client` package: typed REST methods for every route plus a
  resumable SSE event stream with backoff and replay, now used by the CLI.
- `GET /v1/status` plus `demesne ps [--watch] [--json]` for active sessions and
  inference counts, and a cached daily update check with an opt-out.
- MCP client support: config-declared stdio servers are spawned and
  handshaken, tools are bridged as `mcp__<server>__<tool>` with per-call
  approval and bare-rule allowlisting, and crashed servers restart lazily.
- Full-screen workbench for interactive terminals: header, scrollable
  conversation with inline diffs, live telemetry sidebar, list dialogs,
  in-frame approvals, and the unchanged fixed footer. `--no-tui` and
  `DEMESNE_NO_TUI=1` retain the streaming scrollback renderer.
- Agent presence: state-driven animated glyphs, narrative footer labels,
  a shimmering assistant rail, self-typing output, a collapsible thought
  stream, ghost tools that solidify, and a resume greeting. `demesne
  --session <id>` now starts chat directly.
- Workbench chrome: a raised header bar, a boxed composer, right-aligned user
  turns, turn rules, approval-pending ghosts, a soft-limit heads-up, and live
  swap pressure in the sidebar. The sidebar now appears from 84 columns (72 in
  wide mode).
- The clean redesign: all chrome except the wordmark, the core, and the
  footer is gone. The composer is a plain prompt line, and custom commands in
  the workbench follow per-turn input.
- The neon identity: a deep-space palette with cyan/violet/mint/amber accents,
  a glass-panel header with a gradient wordmark, a glass sidebar column, a
  gradient-bordered composer that turns amber on approval, and a glowing core
  avatar whose color tracks the agent's state. Only the workbench uses it —
  scripted output keeps the canonical palette.
- Mouse support in the workbench: SGR wheel scrolling for the transcript and
  click targets on dialog rows, approval choices, and slash/mention menu
  entries. Raw chunks are decoded before the keypress emitter, which splits
  mouse sequences, and the affected keypresses are suppressed.
- Selection surfaces: menus, dialogs, and approval choices draw the selected
  row as a filled background span (`Painter.wash`) in the row's own semantic
  color instead of colored text alone, with a theme-safe foreground.
- Type-to-filter in workbench dialogs (`/theme`, `/model`, `/sessions`):
  printing characters narrow the list by subsequence with substring matches
  ranked first, backspace edits the query, and digits jump rows only while
  the query is empty.
- Throughput sparkline in the telemetry sidebar: provider rounds pair their
  usage and metrics events by call id and the last twelve effective rates render
  as a one-row bar with the newest rate labeled.

### Changed

- Replaced the decorated workbench with the Demesne harness: one clean column
  on a strict alignment grid (`HARNESS`), monochrome text with a single accent,
  and color reserved for status that always means the same thing. Removed the
  neon palette, glass panels, gradient wordmark, and gradient composer border.
- Tool rows are structural (`✓ edit  src/lexer.ts  8ms`) instead of narrated
  sentences, which collided with the verb column; the agent's voice stays in
  its prose.
- Assistant prose now closes per model round and the pacer drains before tool
  and permission events, fixing a split-sentence defect where paced text
  flushed after the block had closed.
- Motion is bound to meaning: only the active turn animates, and the sidebar is
  hidden by default.
- The footer carries live state only. The model and the runtime verification
  moved to the header, which now drops whole items as it narrows (runtime, then
  branch, then model, with the workspace anchoring the row) instead of being cut
  mid-token. The footer's right side is the context window and nothing else:
  `est ~3k/100k · ▰▰▱▱▱ 3%`.
- The footer's right side composes to the space it actually gets. It was built
  as one string and then truncated from the right, so the context meter — the
  last item and the one worth glancing at — was the first thing lost on a
  narrow terminal or with a long model id. It now drops the least important
  part first (absolute counts, then runtime, then model), so the meter always
  survives: `✓ ngram-mod · qwen3.8-q4_0-100k-b256 · ▰▰▱▱▱ 3%`.
- The footer no longer repeats the workspace branch, which the header already
  carries beside the workspace.
- Each surface has its own mark. The composer and the footer were both drawing
  the turn's state glyph, which put two diamonds on adjacent lines:
  `◇ ask anything · / for commands` directly above `◇ ready`. The header is the
  brand's `◈`, the composer is a `❯` prompt (signal-colored when it wants a
  decision), and the footer is the only place the state animates. Transcript
  marks are static and outside the animated vocabulary: a waiting row is `!` and
  a denied row is `⊘`, so no flickering shape is ever drawn twice.
- Themes. Every drawing call names a semantic role and never a color, so a
  theme swap re-themes the whole interface, including the intro art. Ships
  demesne (dark and light), dracula, tokyo-night, tokyo-night-storm, nord,
  gruvbox-dark, catppuccin-mocha, catppuccin-latte, and github-light, selected
  with `theme` in the config or `DEMESNE_THEME`. `/theme` switches live: the
  painter is shared, so one call re-themes on the next frame. The spinner is
  uncolored now — it is on screen the longest, and an accent there competes
  with the turn's status.
- The composer clears when a prompt is submitted and then shows what is being
  queued for the next turn. It previously kept the submitted text on screen,
  which read as though the prompt had not been sent, and type-ahead was visible
  only as a truncated footer note. The footer no longer repeats it.
- Esc Esc now interrupts. A terminal delivers two quick presses as one
  keypress event with `meta: true` and a two-byte escape sequence, and the
  reducer discarded anything carrying `meta`, so the second press was invisible
  and the turn ran to completion. Escape presses are now counted from the
  sequence bytes, which handles both coalesced and separate delivery.
- The animated marks pulse between two palette colors instead of holding one
  flat tone, and `working` no longer uses filled half-circles (`◐ ◓ ◑ ◒`),
  whose weight clashed with every other state.
- The stopped-turn closer no longer said `I kept N findings`, and the local
  copy of `sentence` is gone in favour of the voice module's.
- The model's reply carries no mark. It was a `◆`, and while the model streamed
  it was the same animated glyph the footer showed, so one glyph appeared twice
  on screen at once. Prose is now plain text on the content column, which also
  fixed wrapped replies: their continuation lines sat two columns left of the
  first line.
- Status, not narration: the harness's own text names the state (`thinking`,
  `writing`, `checking`, `needs approval`, `done`) instead of narrating it.
  Nothing in the interface speaks in the first person — the footer, the approval
  line, and the turn closer are status lines, and the only voice in the
  transcript is the model's own prose.
- Inspection collapses: three or more contiguous reads or searches in one round
  render as `✓ read src/lexer.ts +5` with the total time. The run must be
  contiguous, so narration between calls ends it and the agent never appears to
  have said less than it did. Changes and verification are never collapsed.
- Added `bun run fake:provider` with `edit`, `trace`, `fail`, and `sweep`
  scenarios, so the harness can be exercised against a real turn without a
  model.
- Added harness structure and color: a turn rail binds each turn between a
  `┌ you ───` opener and a `└─ ✓` closer, static rules frame the transcript
  between header and composer, and tool verbs are colored by phase (inspect,
  change, verify).
- Removed the animated pulse hairline, which read as an endless moving line
  during inference and carried no information; static structure replaces it.
- The model name no longer appears twice: the header shows workspace and
  branch, and the footer alone carries the model with runtime state.

