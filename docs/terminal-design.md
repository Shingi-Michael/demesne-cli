# Terminal design contract

The visual source of truth is **Version 14** of [Futuristic Terminal Harness Design](https://www.figma.com/make/szdinDI8QBdI1jBtvCDLei/Futuristic-Terminal-Harness-Design), inspected on 2026-09-23. Version 14 standardizes live Thinking indicators and the live assistant card. The native renderer expresses its geometry in terminal cells.

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
- **Header:** `// demesne`, session title and clock on the left; workspace and History on the right. Compact layouts reduce optional title space first.
- **Request:** cyan `▶`, cyan left edge, tinted band. Expanded requests expose original attribution.
- **Assistant card:** rectangular quiet border, one cyan `[` at the upper-left. FAILED uses a red marker and subdued red border. There is one `demesne` / right-aligned timestamp row before the entire chronological stream, including failed runs without prose.
- **Thinking:** amber mark and label; dim duration and `▸/▾` controls for recorded traces. Finished traces start closed. Live traces have three amber dots and a blinking cursor. Trace details use an amber left rule and tinted background.
- **Tool:** one compact line containing status, cyan tool name, secondary target, dim timing and disclosure. Failure changes the mark/name to red. Output and arguments expand underneath, with an inset left rule. Approval, interruption and unknown exit status retain explicit production labels.
- **Error:** red text and an error mark on a subtly red-tinted block with one red left rule.
- **Footer:** `Build/Plan/Compact · model · elapsed N.Ns · speed N.N tok/s · ctx used/total ────── N%`, followed by lowercase `copy` and a right-aligned bracketed status. Copy appears on hover or keyboard selection only when text exists. Its feedback is `copied`. Context fill is green, amber above 50%, red above 80%; safe context values are secondary and safe percentages dim.
- **Composer:** two default text rows, cyan focus rule, bottom-aligned state glyph, cyan-wash Send, and a token estimate below the control. Running uses `◎`, `Agent is running...`, and `[  ···  ]`. Native queued editing, interruption, and Clear queue retain their established routing. The bottom hints emphasize `/` and `@` in cyan.
- **Action rail (Figma Version 16 / Version 15 sidebar):** retain the 48px-equivalent six-cell rail on normal terminals. A small square pip is green at idle and amber during execution, followed by a short divider and Files, Diff, Preview buttons. Terminal-cell equivalents for the source's outline SVGs are `≡`, `╪`, and `▣`; hover adds cyan emphasis, a cyan-tinted fill, and angular brackets. A dim vertical `PANEL` label centers in the remaining space, with `[ ]` at the bottom. Compact terminals use three cells and omit the label when it cannot fit. Files loads the workspace listing, Diff opens recorded changes, and Preview opens image artifacts. The panel docks on wide screens and overlays the conversation on narrow ones. Settings is available through Tab / Ctrl+K; Execution log remains Ctrl+B.

## Data and motion

Cards project actual `UserEntry`, `ReasoningEntry`, `AssistantEntry`, `ToolEntry`, and turn-closing `NoticeEntry` records. `ResponseReceipt` owns the original mode, model, duration, throughput and context. Unknown values remain explicit. Card timestamps use the first activity's recorded time; the clock is separate live telemetry.

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
