# Artifact preview panel: implementation document

Status: initial image-preview pipeline and production panel implemented.
The complete roadmap below also includes follow-up producer-state and release
validation work; unchecked items are not claims of delivered functionality.

### Implementation progress

- Added `apps/cli/src/terminal-graphics.ts`: capability-query commands,
  pixel-aware aspect-fit geometry, bounded Kitty transfer chunks, placement
  reuse on resize, and cleanup restricted to the owned image ID.
- Added fragmented graphics/cell-size reply decoding in `TerminalInputDecoder`.
  The workbench consumes these separately from typing and paste.
- Added regression tests for every reply split boundary, split terminators,
  placement reuse, no-op redraws, and cleanup.
- Connected capability negotiation and graphics placement to the production
  workbench. `bun run ui:image` exercises the image panel without a model.
- Added Sharp-backed static PNG/JPEG/WebP ingestion, immutable original files,
  PNG derivatives, SQLite artifact descriptors, idempotent creation events,
  authenticated metadata/content routes, and typed binary client retrieval.
- MCP tools preserve structured image content through the optional
  `executeWithArtifacts` method; existing string-only `execute` callers retain
  their contract. Binary content stays out of stored model messages and event payloads.
- Added first-class image generation and browser screenshot inspection. Opt-in
  provider vision resolves persisted artifact IDs into image inputs only at the
  provider boundary, retaining the latest two images with a visual token reserve.
  `view_image` imports workspace screenshots returned as file paths.
- Live acceptance: OpenAI generated a 1024×1024 image through the agent tool loop.
  Playwright captured a 1280×720 browser screenshot; local Qwen with its projector
  correctly identified a purple circle and green rectangle from its pixels.
  Screenshot artifacts were saved with the browser tool as their source.
- Added Preview (Alt+V), automatic wide-screen opening, manual/pinned/follow
  selection, history, expand, original-file opening, and client-local preferences.
- The compiled daemon ships with `dist/node_modules` for native image codecs.
  `scripts/check-image-runtime.ts` verifies decode/persist/retrieve from a compiled
  executable outside the repository working directory.
- `scripts/check-image-pty.py` verifies protocol negotiation, placements,
  mixed-axis momentum, closing/reopening, and terminal cleanup. This is a PTY
  protocol check, not a claim of visual validation in Ghostty.
- Remaining roadmap work: explicit producer-operation lifecycle events and their
  generating/failure UI, response-local image links, reverted-turn filtering,
  on-demand history pagination, orphan-file retention cleanup, and an
  actual Ghostty visual acceptance run. Generic image-returning
  tools currently expose artifacts on completion, without invented progress.

Product requirements: [structure and product plan](artifact-preview-plan.md).

## 1. Current architecture and integration points

| Existing code | Current responsibility | Planned integration |
| --- | --- | --- |
| `packages/protocol/src/index.ts` | Event envelopes, session state, transport types | Artifact and image-operation descriptors, typed payloads, list responses |
| `packages/storage/src/index.ts` | SQLite state, migrations, durable ordered events | Artifact metadata, operation state, transactional event publication |
| `apps/daemon/src/tools.ts` | `AgentTool.execute()` returns `Promise<string>` | Backward-compatible structured results alongside text tools |
| `apps/daemon/src/mcp.ts` | `flattenToolResult()` retains text blocks only | Preserve image content and producer attribution |
| `apps/daemon/src/engine.ts` | Execute tools, persist results, build model messages | Normalize results, register artifacts, keep binary data out of model text |
| `apps/daemon/src/app.ts` | Session routes and authenticated daemon API | Paginated artifact metadata and content retrieval |
| `packages/client/src/index.ts` | Typed JSON API and resumable event consumption | Artifact listing plus binary retrieval with existing auth/error behavior |
| `apps/cli/src/main.ts` | Live-event routing, session hydration | Load/project artifacts and image-operation state |
| `apps/cli/src/workbench/history.ts` | Bounded replay of stored turns and events | Resolve original artifact links without downloading every image |
| `apps/cli/src/workbench/session.ts` | Panel selection, focus, scroll regions | Preview surface routing and independent preview state |
| `apps/cli/src/workbench/controller.ts` | Frame composition, coalesced writes, lifecycle | Coordinate graphics operations with text output |
| `apps/cli/src/workbench/terminal-input.ts` | Fragment-safe terminal input decoding | Consume graphics replies and terminal geometry reports separately from keystrokes |
| `apps/cli/src/workbench/layout.ts` | Docked/overlay cell geometry | Explicit preview viewport and expanded geometry |
| `apps/cli/src/workbench/entries.ts` | Text/tool/notice entry union | Typed artifact references associated with the original run |

The current text canvas cannot own image placements by itself. Keep pure layout
and state projection separate from asynchronous retrieval and terminal I/O.

## 2. Proposed module structure

New filenames below are planned; use the surrounding conventions when implementing.

```text
apps/daemon/src/
  artifacts.ts                  ingest, original/derivative files, retrieval
  tool-result.ts                normalize string or structured tool results

apps/cli/src/
  artifact-cache.ts             bounded content cache, async loading, cancellation
  preview-preferences.ts        client-local per-session selection/pin persistence
  terminal-graphics.ts          capability probe, Kitty encoding, placement lifecycle
  workbench/
    preview-state.ts            pure reducer: selection, pinning, operations, history
    preview-panel.ts            pure cell layout, controls, graphics placement intent

packages/protocol/src/index.ts  shared artifact/operation/API contracts
packages/storage/src/index.ts   additive schema and transactional store operations

apps/cli/test/                  state, layout, raw input, graphics and interaction tests
apps/daemon/test/               producer normalization, ingestion, routes and recovery
packages/storage/test/          migrations, persistence and event idempotency
packages/client/test/           binary transport, errors, auth and reconnect
scripts/                       production preview fixtures and fake image producer
```

Use the existing packages first. An image-decoding dependency must be demonstrated
to work with both Bun development execution and compiled binaries in milestone A.

## 3. Data contracts

### Immutable image artifacts

Proposed protocol shape:

```ts
interface ImageArtifact {
  id: string;
  kind: "image";
  sessionId: string;
  turnId: string;
  toolCallId: string | null;
  operationId: string | null;
  createdAt: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  source: {
    kind: "mcp" | "tool" | "provider";
    name: string;
    modelId: string | null;
  };
  revisionOf: string | null;
}
```

Keep storage paths internal to the daemon. API consumers address bytes by artifact
ID. The image-generating model is distinct from the coding model that called the
tool. Unknown values stay null. A new revision has a new immutable artifact ID.

### Operation state

Track image-producing operations separately from their outputs. One operation may
produce zero, one, or multiple images, and may fail after producing usable output.

An `ImageOperation` records its ID, session/turn/tool-call IDs, source, start/end
times, artifact IDs, and a status of `running`, `completed`, `failed`, `cancelled`,
or `interrupted`, with a recorded error where applicable.

Only an explicitly image-capable adapter starts an image operation before results
arrive. Generic MCP tools can register artifacts on completion without first
claiming generation activity. Preview decode/download failures are client state,
not changes to the producer's successful operation or immutable artifact record.

### Tool result evolution

Allow `AgentTool.execute()` to return a string or a structured result containing
`text` and a list of image outputs. Normalize the union at one engine boundary so
existing built-in tools retain their current behavior.

Image outputs contain bytes (or an explicitly supported source resolved by the
adapter), MIME information, a stable output index/source key, and optional
provenance/revision linkage. They are ephemeral ingestion inputs, not event payloads.

Continue returning bounded text to `ModelMessage`. Add concise artifact references
to that text when useful. Do not serialize base64 images into reasoning, tool logs,
SSE payloads, or the existing text-only model conversation.

### Events and replay

Propose additive event types:

- `image.operation_started`
- `image.operation_completed`
- `image.operation_failed`
- `image.operation_cancelled`
- `image.operation_interrupted`
- `artifact.created`

Define payload interfaces and validate them at ingress. `artifact.created` carries
the immutable descriptor, not the bytes. Use the existing event ID as the replay
cursor. Confirm older clients ignore unknown additive events safely before deciding
whether a protocol-version change is necessary.

## 4. Storage and content lifecycle

- Add artifact metadata and image-operation tables through the existing additive
  migration mechanism. Index artifacts by session and stable creation order, and
  link them to their original turn/tool call.
- Write original bytes under `<data-dir>/artifacts/`, using generated storage keys
  and atomic temporary-file rename. Store a content hash and decoded dimensions.
- Preserve original bytes; generate a separate bounded PNG preview derivative
  for terminal transfer. Keep original and preview content types distinct.
- Commit artifact metadata and its event together after the content is durable.
  Publish live notifications after the transaction commits.
- Use a producer-call/output-index key to prevent duplicate artifacts on retries.
  Equal image hashes may share a blob while retaining distinct provenance records.
- On startup, settle abandoned running operations as interrupted and clean up
  unreferenced temporary files. A crash between blob rename and DB commit must
  leave a recoverable orphan, not a broken ready artifact.
- Preserve artifacts for archived sessions and reverted turns as historical
  evidence; hide reverted-turn artifacts from automatic latest selection. Tie
  eventual deletion to an explicit session/artifact retention policy.
- Missing content is reported as unavailable while retaining its metadata. An
  expired URL or later workspace edit must not invalidate a saved original.

Initial supported formats: static PNG, JPEG, and WebP, decoded to a PNG preview.
Animated images and SVG rendering are later extensions. Proposed starting budgets
are 20 MiB encoded and 40 megapixels decoded per image, with a 64 MiB CLI preview
cache; measure and adjust these during the feasibility pass. Apply independent
image budgets rather than raising all existing text-output limits.

## 5. API and client hydration

Proposed routes:

```text
GET /v1/sessions/:sessionId/artifacts?after=:cursor&limit=:n
GET /v1/sessions/:sessionId/image-operations
GET /v1/sessions/:sessionId/artifacts/:artifactId
GET /v1/sessions/:sessionId/artifacts/:artifactId/content?variant=original|preview
```

The list response includes a stable continuation cursor and the event watermark
used for hydration. Reconcile live events by event ID and artifact ID so results
arriving during initial listing are neither missed nor duplicated. Resolve a saved
selection by ID even if it is outside the initial list page. Bound operation listing
to active/recent records and paginate historical operations if exposed.

Use the daemon's existing authentication and verify that the artifact belongs to
the requested session on every artifact route. The content route resolves a
registered artifact, never an arbitrary path.
Send the appropriate content type, length, and hash-based ETag. Add a binary fetch
method to `DemesneClient`; its existing JSON helper cannot retrieve image bytes.

Cache preview bytes by content hash. Session switch, selection change, or close
cancels obsolete loads. Guard completions with a session/selection generation so
an older asynchronous request cannot replace the current image. Download only the
selected preview; fetch the original on Open original.

## 6. Preview state and persistence

Implement a pure state reducer, owned alongside the current panel state:

```ts
interface PreviewState {
  selectedArtifactId: string | null;
  selectionMode: "follow" | "manual" | "pinned";
  userDismissed: boolean;
  expanded: boolean;
  unseenArtifactCount: number;
}
```

Keep loading/error state and in-flight requests in the artifact cache/controller,
keyed by the selected artifact. Derive generating/failed operation displays from
stored operation records. The reducer follows the priority table in the product
plan and emits selection changes without side effects.

Persist selection mode, selected ID, and explicit dismissal in a versioned
client-local preference file keyed by daemon identity and session ID. Restore
expanded geometry only when it fits the current terminal. Malformed or stale
preferences fall back to normal following without preventing session load.

Preview mode must share the existing panel routing rather than overloading the
current `artifact` property, which presently refers to change/verification evidence.
Review the panel's existing boolean flags as part of this integration and centralize
surface transitions sufficiently to prevent two surfaces owning the panel at once.

## 7. Terminal graphics architecture

### Capability and input handling

Probe Kitty graphics support once per terminal attachment with a bounded timeout.
Use terminal identity only as a hint, not proof of support. Query cell/pixel geometry
when available to calculate an accurate aspect fit. If reliable graphics/geometry
support is unavailable, retain the metadata/Open original view.

Extend `TerminalInputDecoder` to consume fragmented APC graphics replies and the
specific CSI geometry replies before ordinary keyboard dispatch. Replies may share
chunks with mouse events, paste, or typing; preserve their order and ensure they
never become draft text or trigger Escape interruption. Probe failure is a fallback
condition and must not block startup or the event stream.

### Pure frame intent and a single output owner

The preview renderer returns text rows, hit targets, and an optional image placement
intent: content hash, image ID, and a bounded cell rectangle. It does not fetch,
decode, write escape sequences, or change conversation scroll state.

`controller.ts` remains the output owner. Integrate graphics into frame change
detection so a new image with unchanged text still renders. Coordinate removal of
obsolete placements, changed text rows, and new placements in the synchronized
frame. Serialize chunked uploads with other writes; never interleave graphics
payload fragments with OSC clipboard or ordinary output. Track image/placement
IDs owned by this workbench and delete only those IDs.

Large transfers should be prepared asynchronously and written in bounded chunks
without holding synchronized-update mode across network waits. Upload before
placement where possible, then atomically replace the visible placement. A late
upload is discarded if its session/selection generation is no longer current.

### Redraw and cleanup invariants

- Same hash and placement rectangle: no image retransmission or placement churn.
- Resize: recompute fit and update placement; reuse uploaded content where supported.
- Close, overlay change, session switch, external editor, suspend, or exit: remove
  placements before the covered text/terminal mode is restored.
- Resume: renegotiate if necessary and reconstruct the selected preview.
- A stationary image causes no animation timer. Hover and clock updates affect
  only their text cells.
- Generation/loading indicators stay inside the panel and respect reduced motion.
- Graphics are never emitted in piped output, plain snapshots, or unsupported
  terminal mode. These paths emit artifact metadata and a usable reference.

Open original retrieves/caches the original file locally and invokes the platform
opener with an argument array. Surface opener errors in the panel without changing
the draft or the recorded generation result.

## 8. Implementation sequence and exit checks

### A — Graphics feasibility and renderer contract

- [ ] Choose and verify a PNG/JPEG/WebP decoder under Bun and compiled binaries.
- [ ] Build capability/reply handling and a fixture-only Kitty transfer/placement path.
- [ ] Extend frame output with graphics intents, diffing and owned-ID cleanup.
- [ ] Verify an aspect-fitted fixture in Ghostty, resize, expand/close, session exit,
  terminal re-entry, and unsupported-terminal fallback.

Exit: no image ghosts, input leakage, redraw loops, or transcript movement from a
static image. Record the tested Ghostty version and platform.

### B — Durable artifact pipeline

- [ ] Add protocol descriptors, store migrations, ingestion and artifact routes.
- [ ] Normalize structured tool outputs while keeping string tools compatible.
- [ ] Preserve MCP image content blocks and their ordering/provenance.
- [ ] Audit MCP framing limits: the current 256 KiB text-oriented limits must not
  discard valid image responses, including a complete oversized JSON-RPC line.
  Enforce explicit encoded/decoded bounds for image results.
- [ ] Add binary client retrieval and metadata/event reconciliation.

Exit: a fake producer's images survive daemon restart and SSE reconnect exactly
once, with original bytes and source attribution intact.

### C — Panel state, controls, and session restoration

- [ ] Add Preview routing, state reducer, client preferences and image history.
- [ ] Implement all product states and pin/manual/follow priority rules.
- [ ] Link artifacts from their original response and expose a rail availability cue.
- [ ] Add docked, narrow overlay and expanded layouts with accessible controls.
- [ ] Implement cancellable loading, cache eviction and Open original.

Exit: asynchronous images cannot steal focus, displace a pinned selection, reopen
a dismissed panel, change the draft, or move a paused reading anchor.

### D — End-to-end image producer

- [ ] Configure one real image-returning MCP tool and record its supported outputs.
- [ ] Explicitly classify it if it can truthfully expose generation-in-progress state.
- [ ] Exercise multi-image results, generation failure, cancellation, and retries.
- [ ] Resume the session and reopen original images without contacting the producer.
- [ ] Document connector setup and any unreported model attribution.

Exit: the full tool → daemon → durable artifact → client → Ghostty path works with
a real output, not just a renderer fixture. Provider selection/credentials remain
an implementation prerequisite; none are assumed to exist today.

### E — Verification and documentation

- [ ] Add production preview fixtures for empty, generating, loading, ready,
  failed, unavailable, pinned-with-new-image, and unsupported-graphics states.
- [ ] Validate dark/light, reduced motion, and 40×10, 80×24, 120×36 layouts.
- [ ] Run the complete automated suite, typecheck, and CLI/daemon builds.
- [ ] Run an actual Ghostty session for graphics, focus, trackpad and lifecycle checks.
- [ ] Update README and terminal design documentation from planned to implemented.

## 9. Regression matrix

| Area | Essential cases |
| --- | --- |
| Persistence | Old DB migration; multiple outputs; duplicate delivery; overwritten workspace file; crash before/after metadata commit; missing original |
| Transport | Mixed text/image MCP results; size bounds; wrong MIME/corrupt bytes; authenticated binary fetch; paginated list/SSE race |
| State | Pinned image plus new output; manual history selection; follow latest; explicit close; another inspection open; session switch during load |
| Replay | Original model/turn attribution; reverted turn; selected item outside first page; restarted daemon; interrupted producer |
| Graphics | Capability timeout; split APC/CSI reply; resize; overlay removal; expand/restore; owned-ID cleanup; external editor and exit |
| Interaction | Composer remains editable; queue/approval controls; keyboard focus; genuine upward scroll; repeated down plus horizontal trackpad events at a finished bottom edge |
| Performance | No idle transfers; no clock-triggered image uploads; bounded cache; cancelled stale loads; no independent image write loop |

Use fake producers and a recording graphics transport for deterministic tests.
PTY tests cover raw input and terminal restoration, but an actual graphics-capable
terminal is required to validate pixels, clipping and placement cleanup.

## 10. References and later extensions

- [Ghostty graphics support](https://ghostty.org/docs/features)
- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [Current terminal design](terminal-design.md)

Later work can add screenshot/diagram producers, visual comparisons, richer
multimodal inputs, and other terminal graphics backends. Arcade behavior has no
tasks or runtime dependency in this delivery; revisit it after artifact previews
are useful and stable.
