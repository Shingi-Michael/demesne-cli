# Terminal design contract

The visual source of truth is **Version 14** of [Futuristic Terminal Harness Design](https://www.figma.com/make/szdinDI8QBdI1jBtvCDLei/Futuristic-Terminal-Harness-Design), inspected on 2026-09-23. Version 14 standardizes live Thinking indicators and the live assistant card. The native renderer expresses its geometry in terminal cells.

Later component references supersede their earlier geometry: **Version 19** for the header, **Version 20** for the composer/footer, and **Version 21** for the slash menu (inspected 2026-09-26).

Live Thinking and the running Send control use the same shared `thinkingDots` renderer, including spacing, amber color and pulse timing. Per the subsequent user refinement, the bottom footer omits running/thinking labels, pulsing dots, elapsed time and token speed, retaining context and navigation. Live cards use an amber `[` and the same agent-label/timestamp header and geometry as settled cards; successful settlement restores cyan and failure uses red.

## Palette

| Reference token | Native role | Dark value |
| --- | --- | --- |
| `--bg` | `ink` | `#050A0E` |
| `--bg-2` | `surface`, `toolSurface` | `#090F14` |
| `--bg-3` | `raised`, `toolActive` | `#0D1720` |
| `--border` | `rule` | `#1A2D3D` |
| `--border-bright` | `borderBright` | `#1E3A4F` |
| `--cyan` | `electric` | `#00D4FF` |
| `--amber` | `thinking` | `#FFB700` |
| `--green` | `citron` | `#00E676` |
| `--red` | `signal` | `#FF4C4C` |
| `--text-primary` | `paper` | `#C8DAE8` |
| `--text-secondary` | `secondary` | `#7A9FB8` |
| `--text-dim` | `muted` | `#536E82` |
| 8% cyan over `--bg-2` | `menuSelection` | `#081F27` |
| `syntax/keyword` | `syntaxKeyword` | `#C49CE6` |
| `syntax/string` | `syntaxString` | `#9CCF8D` |
| `syntax/number` | `syntaxNumber` | `#E5A93C` |
| `syntax/comment` | `syntaxComment` | `#5F7280` |
| `syntax/type` | `syntaxType` | `#6FC2D6` |
| `syntax/function` | `syntaxFunction` | `#5AA9E6` |

Syntax roles come from the redesign's Foundations page. Demesne Light uses
darker values with at least 4.5:1 contrast (comments excepted, which recede by
design); named themes derive them from their own accents. Diff `+`/`−` markers
keep `citron`/`signal`, since they mean added/removed rather than syntax.

Translucent cyan, amber, and red surfaces are composited into theme tokens for terminal backgrounds. Failed card borders blend red at 35% over the card surface. Named and light themes use the same semantic roles. Status glyphs and labels carry meaning in plain output.

## Layout and components

- **Start screen:** the centered input-first Version 9 composition, constrained hero composer, cyan brackets, model/context watermark, operation cards, and saved Recent strip. Operation cards fill an undoable draft; Enter sends it.
- **Header (redesign):** `demesne` (bold accent) · session title · workspace path on the left; `⎇ branch`, a status pill, the clock with session elapsed time, and `history` on the right. The pill appears only while something needs attention: green `running`, amber `approval`, red `failed`, neutral `stopped`. Narrow terminals drop the branch, then the clock, then the title; the path (a click target for the project folder), brand, status and history stay.
- **Status bar (redesign):** a colored `●` with a lowercase state (`ready`, `approval`, `failed`, `stopped`; no running label), then context usage with its hairline meter when it fits, and `Ctrl+G live`.
- **Request:** cyan `▶`, cyan left edge, tinted band. Expanded requests expose original attribution.
- **Assistant card:** rectangular quiet border, one cyan `[` at the upper-left. FAILED uses a red marker and subdued red border. There is one `demesne` / right-aligned timestamp row before the entire chronological stream, including failed runs without prose.
- **Thinking:** amber mark and label; dim duration and `▸/▾` controls for recorded traces. Finished traces start closed. Live traces have three amber dots and a blinking cursor. Trace details use an amber left rule and tinted background.
- **Tool:** one compact line containing status, cyan tool name, secondary target, dim timing and disclosure. Failure changes the mark/name to red. Output and arguments expand underneath, with an inset left rule. Approval, interruption and unknown exit status retain explicit production labels.
- **Error:** red text and an error mark on a subtly red-tinted block with one red left rule.
- **Footer:** `Build/Plan/Compact · model · elapsed N.Ns · speed N.N tok/s · ctx used/total ────── N%`, followed by lowercase `copy` and a right-aligned bracketed status. Copy appears on hover or keyboard selection only when text exists. Its feedback is `copied`. Context fill is green, amber above 50%, red above 80%; safe context values are secondary and safe percentages dim.
- **Composer:** two default text rows, cyan focus rule, bottom-aligned state glyph, cyan-wash Send, and a token estimate below the control. Running uses `◎`, `Agent is running...`, and `[  ···  ]`. Native queued editing, interruption, and Clear queue retain their established routing. The bottom hints emphasize `/` and `@` in cyan.
- **Action rail (redesign):** the six-cell rail keeps the state pip (green idle, amber running), a short divider, Files `≡`, Diff `╪`, Preview `▣` and Drive `▷`, and `[ ]` at the bottom. The vertical `PANEL` label is gone. Hover lifts the cell onto the raised surface and brightens the icon; active Drive work stays amber. Files loads the workspace listing, Diff opens recorded changes, and Preview opens image artifacts; an open panel docks in the rail's place. Compact terminals use three cells. Settings is available through Tab / Ctrl+K; Execution log remains Ctrl+B.
- **Setup wizard (redesign):** `demesne setup` in a terminal runs a full-screen three-step wizard — Provider (local servers found first, unreachable ones dimmed, `r` rescans, Custom URL with the HTTPS rule), Model (largest context recommended, or a typed id when none are listed), Review (detected values; `e` edits context/output, cycles theme) — then writes the config and shows where it went. Esc or Ctrl+C cancels without writing. `--provider-url`/`--model` with `--yes`, or no terminal, keeps the non-interactive path. Hosted OpenRouter sign-in remains `demesne auth login openrouter`.

## Data and motion

### Agent Drive

**Alt+J**, `/drive`, and the `▷` rail action open the mission panel. It follows the
existing dock/overlay geometry, uses the semantic palette and square controls,
and keeps Pause/Resume/Stop fixed above scrollable mission notes. Drive activity
stays in this panel and the rail; the bottom footer remains free of telemetry.
See [Agent Drive](agent-drive.md) for the visible UI loop and recovery behavior.

### Slash menu · Version 21

The menu overlays the transcript immediately above the composer, spanning its
width and stopping before the action rail or docked panel. Its square top and
side borders join the composer separator. Opening, filtering and dismissal keep
the composer and conversation reading anchor in place.

Dark section strips use small uppercase labels. Command names occupy a fixed
12-cell column (the reference uses 90px), followed by muted descriptions. The
selected row has an 8% accent wash, a narrow cyan left edge and cyan command
text. Selection remains identifiable without color. The popup is capped at
12 terminal rows, reduced to the space available above the composer, and scrolls
internally without a visible scrollbar.

`/` opens the menu; typing filters command names and aliases. Up/Down wrap the
selection, Page Up/Down move through the list, and the mouse wheel navigates
inside the popup. Hover selects and a single click accepts. Enter or Tab runs an
argument-free command or inserts an argument-taking command for completion.
Escape dismisses the menu while preserving the query and caret; editing opens it
again. Section strips and borders never activate the transcript underneath.

The groups use the available native commands: Session, Model, Context, Tools,
Control, and Custom. Custom commands remain reachable beyond the initial viewport.
Preview with `bun run ui:session --state=complete --commands=/`, or use
`--commands=/mo` for the filtered Model group.

### Live changes panel

The Diff rail action (or **Alt+D**) opens a turn's file changes. Selecting an edit
row in chat opens its recorded revision. Chat keeps a compact path, outcome and
`+added −removed` receipt; code lives in the panel. **Expand / Restore** or
**Alt+Enter** switches between the dock and a wide overlay, preserving the draft.

For native `write_file`, `edit_file`, `move_path` and `delete_path` operations,
`tool.call_draft` carries bounded argument fragments while the model generates
them. Partial JSON is decoded for display only. **Drafting**, **Pending** and
**Approval** are proposals; only a successful tool result becomes **Applied**.
Failed, denied and stopped proposals retain their outcome. Original arguments
and recorded results remain available in the execution log.

Successful operations record immutable before/after file evidence in the event
journal, including creations, deletions and both sides of moves. Contiguous
operations on a file accumulate within the selected turn. External changes
between operations are labelled as separate recorded segments. Historical
rendering never reads today's file from disk. Binary/oversized files explicitly
report unavailable text; textual previews are bounded to 1 MiB per side and
10,000 diff rows. Older journals fall back to labelled input fragments.

**Follow edits** tracks the latest file and turn. Selecting a file or scrolling
pauses it and keeps a labelled snapshot, even through settlement or new edits.
**Live / Ctrl+G** resumes following. **←/→** selects files; **↑/↓**, Page Up/Down,
Home/End and the wheel navigate code. The file-list height is reserved so new
files cannot shift the code viewport. Code uses filename-based syntax highlighting
for TypeScript/JavaScript, Python, Rust, Go, JSON, YAML and shell files. Keywords,
strings, numbers and comments retain their syntax colors on both sides; green/red
gutter markers and subtle themed row backgrounds identify additions/removals.
Old/new lexical state is independent and includes hidden hunk context. Wrapped
code stays aligned beneath its source line and carries a quiet `↪` continuation
marker. Line numbers remain muted, and no scrollbar is drawn.

Preview with `bun run ui:session --live-diff` (demonstration data), optionally
`--expand-diff` or `--snapshot=120x36 --plain`.

### Conversation rendering

Cards project actual `UserEntry`, `ReasoningEntry`, `AssistantEntry`, `ToolEntry`, and turn-closing `NoticeEntry` records. `ResponseReceipt` owns the original mode, model, duration, throughput and context. Unknown values remain explicit. Card timestamps use the first activity's recorded time; the clock is separate live telemetry.

Startup and session switching use local daemon metadata. Provider model discovery
is deferred until `/model`; workspace suggestions and artifact metadata load
independently of prompt readiness.

Saved history uses `/v1/sessions/:id/replay?after=N&through=M`, pinned to the
session snapshot's cursor. Pages scan at most 20,000 original events and coalesce
consecutive nonempty text deltas into merged chunks of at most 65,536 UTF-16 code units.
The first timestamp/ID, final cursor and delta count retain response timestamps,
reasoning durations and revisions; tool, permission and model-round boundaries
stay explicit. An LRU cache retains at most 128 serialized pages / 32 MiB, keyed
by session and snapshot. The durable journal and live SSE retain every original
event. Older daemons use the original SSE replay path.

`/compact [instructions]` uses the same cancellable turn and response card, with
**Compact** mode and a before/after context estimate. Its validated summary is
readable in the answer and the full original conversation remains in History.
The committed post-compaction estimate survives replay; summarizer token usage
stays available in `/context` as provider-reported request usage.

The source uses a 1.4s dot pulse with 180ms staggering, a 1.1s cursor blink, and approximately 150ms hover fades. Reduced motion settles animation while the clock continues to tick. Disclosures use the reference's fixed closed/open glyphs.

Live prose follows a response-relative reading window. When burst output exceeds
the viewport, automatic scrolling advances one terminal row per redraw (at least
16ms apart), including remaining catch-up after completion. Manual scrolling
pauses it immediately; Ctrl+G jumps directly to live. Resize, static snapshots,
and reduced-motion mode resolve the viewport directly without catch-up animation.

At narrow cell widths, whole footer fields wrap, optional spacing contracts, and the context meter can reduce to its percentage. Drafts, selected controls, original receipts, and reading anchors survive resizing. Keyboard and mouse hit targets are derived from the rendered geometry.

## Verification

Conversation and inspection panes have no visible scrollbar. Streaming follow
advances only by newly overflowing rows, rather than jumping by viewport-sized
blocks. Manual reading anchors and boundary clamping remain in effect.

Horizontal trackpad wheel events are decoded separately and ignored by vertical
panes. Mixed-axis gestures at the bottom of a finished transcript must not move it.

Use `bun run ui:session --state=round-limit` for a tool-only failed run, `--state=thinking-answer` for live reasoning, and `--state=start` for the start screen. Compare the rendered layout with the reference at normal and compact sizes. Check Copy, disclosure hit targets, draft caret positioning, queue interruption, and saved-session replay whenever geometry or record projection changes.

## Image preview panel

The [artifact preview plan](artifact-preview-plan.md) and its
[implementation document](artifact-preview-implementation.md) define the next
panel roadmap. The initial image pipeline, persistent artifacts, pinning/history,
expanded viewing and Kitty graphics placements are implemented. Alt+V opens
Preview; Changes, Verification, Context and Execution log retain their existing
entry points. See the implementation progress section for remaining acceptance work.
