# Artifact preview panel: structure and product plan

Status: planned; implementation has not started.

Decision date: 2026-09-23.

Companion documents:

- [Implementation plan](artifact-preview-implementation.md)
- [Current terminal design contract](terminal-design.md)

## 1. Purpose

Make the right-hand panel a primary place to inspect the things Demesne produces.
The first delivery is a durable image preview: a generated image appears beside
the conversation, can be inspected or pinned, and remains available when the
session is resumed.

The user should be able to see an image, continue typing feedback, and compare
subsequent revisions without losing their draft or conversation reading position.

The agreed priority is useful artifacts first. The arcade/companion idea is
deferred for a later discussion. Screenshots, diagrams, and visual comparisons
are future consumers of this foundation.

## 2. First-delivery scope

1. Display real image bytes inside supported terminals, with Ghostty as the
   initial validation target using the Kitty graphics protocol.
2. Accept structured image outputs from an image-producing tool; retain their
   original bytes and attribution as session artifacts.
3. Follow newly available images automatically when the user has enabled
   following and is not inspecting another panel surface.
4. Let the user select, pin, unpin, expand, and open an image externally.
5. Browse images and explicitly linked revisions from the current session.
6. Restore artifact history and the client's selected/pinned preview on resume.
7. Provide a useful metadata-and-open view when inline graphics are unavailable.
8. Preserve the current Changes, Verification, Context, and Execution log surfaces.

The preview consumes image outputs. Adding image generation to a text-only model
is a separate capability; the initial producer will be an image-returning MCP
tool. Its result handling must preserve image blocks that are currently discarded.

## 3. Panel structure

The panel stays within the current square-cornered, blue-black/cyan visual system.
No image animation, visible scrollbar, or new bottom-footer telemetry is needed.

```text
┌ PREVIEW                         Pin  × ┐
│ image-02.png                 2 of 4    │
│                                       │
│                                       │
│       aspect-fitted image area         │
│                                       │
│                                       │
├───────────────────────────────────────┤
│ 1536 × 1024 · PNG                      │
│ Source: image-tool · Model: recorded ID │
│ Turn 12 · Revision 2                   │
│ ‹ Previous   Next ›   History          │
│ Expand              Open original      │
└───────────────────────────────────────┘
```

This is a structural sketch, not a new Figma specification. Exact cell spacing
will be checked against the existing production panel at implementation time.

### Regions

| Region | Responsibility |
| --- | --- |
| Header | Current surface, pinned/following state, close action |
| Selection line | Filename and position in the artifact list |
| Preview viewport | Aspect-fitted image or the current empty/loading/error state |
| Metadata | Dimensions, format, source, recorded generating model and turn |
| Controls | Previous/next, history, pin/follow latest, expand, open original |

Keep filenames and metadata cell-safe and wrap or truncate them using the existing
text utilities. Unknown source-model information is shown as unavailable; the
currently selected coding model is not a substitute for the image's original model.

### Responsive layout

- Use the current docked panel at widths of at least 100 columns.
- Use the existing conversation overlay below that width; retain the composer.
- Expand into the available conversation area, preserving the previous panel
  selection and geometry for return. The composer stays usable.
- At 40×10, prioritize the filename/state and reachable controls; inline pixels
  may give way to metadata if there is insufficient room for a useful preview.
- Fit the entire image by default. Inspect native resolution with Open original.
- Resize the placement inside its allocated region without introducing transcript
  rows, changing the draft, or moving a paused reading anchor.

## 4. Selection and attention rules

The panel distinguishes explicit user selection from automatic following.

| Situation | Behavior |
| --- | --- |
| User opens an image from a response or history | Select it and enter manual selection mode |
| User pins the selected image | Persist that selection until explicitly unpinned/replaced |
| User chooses Follow latest | Select the newest available image and follow subsequent outputs |
| Image arrives while Preview is following | Update the selected preview without taking keyboard focus |
| Image arrives while an image is pinned/manually selected | Keep the selection; show a new-artifact count |
| Image arrives while Changes, Context, output, or another inspection is open | Preserve that inspection; indicate that a preview is available |
| First image arrives with the panel initially collapsed | Auto-open only in the wide docked layout; on narrow screens indicate availability in the rail |
| User explicitly closes Preview | Keep it closed for the session until explicitly reopened; new images remain in history |
| User opens a different session | Restore that session's preview state, without carrying over an image from the previous session |
| Selected artifact cannot be loaded | Preserve its identity and show unavailable/retry controls; do not silently substitute a newer image |

Unpinning returns to manual selection. Follow latest is the explicit action for
resuming automatic replacement. Choosing another image while pinned moves the
pin to the explicitly chosen image.

Auto-opening the docked panel preserves the conversation anchor through the
width change. Subsequent image updates keep panel geometry fixed.

## 5. User-visible states

Separate the image-producing operation from the act of displaying its result.

| State | Display and meaning |
| --- | --- |
| Empty | No image artifacts in this session; explain where previews will appear |
| Generating | An image-capable producer has actually started; show its recorded identity, without an invented percentage or ETA |
| Loading preview | The image exists; its bytes are being retrieved or prepared for display |
| Ready | Image, provenance, navigation, and inspection controls |
| Generation failed | Recorded operation error; previous successful images remain selectable |
| Cancelled/interrupted | Honest terminal operation state; no fabricated empty image or success |
| Preview unavailable | Missing/corrupt bytes, unsupported format, or rendering failure; metadata and recovery controls remain |
| Graphics unavailable | Normal fallback mode with metadata and Open original; this is not generation failure |

An ordinary model request or tool call is not evidence that an image is being
generated. Unclassified image-returning tools may first become visible when their
result arrives. A text-only answer promising an image never creates an artifact.

## 6. Interaction and persistence

- A compact image-artifact action in the relevant response opens that exact image.
- The rail opens Preview when selected; existing inspection entry points remain
  reachable through their current controls.
- Tab/Shift+Tab and Enter operate focused panel controls. Previous/next image
  controls use the panel's focus routing; typing continues to target the composer
  when the panel is unfocused.
- Escape returns from expanded view to docked/overlay view, then closes the panel
  following the existing inspection conventions.
- Horizontal trackpad events must not become vertical scrolling. Neither wheel
  axis changes the selected image implicitly.
- Artifact history uses a bounded list with stable cursor-based loading. Avoid a
  permanently visible thumbnail strip in the narrow panel for the first delivery.
- Store immutable image versions. Link revisions only when the producer records
  that relationship; filenames alone do not establish a revision chain.
- Save original bytes in the daemon's data directory so a workspace overwrite or
  expired provider URL does not erase session history.
- Store pin/selection preferences per client and session. A second client can
  inspect the same session independently.
- Loading a preview does not automatically add its bytes to the next model
  request. Multimodal model input is a separate capability.

## 7. Stability and performance contract

The panel must be quiet when nothing changes. Transfer and decode an image once
per content version, then reuse its terminal placement/cache. Do not resend image
bytes for clock ticks, hovering, transcript updates, or bottom-edge wheel events.

All terminal output stays coordinated by the workbench renderer. Image
transfers, placement updates, text frames, and cleanup must not compete through
independent writes. Closing a panel or switching sessions removes its placements.

The existing draft, queue, approvals, reading anchors, and replay behavior remain
part of acceptance testing. Reduced-motion behavior applies to loading indicators.

## 8. Delivery milestones

| Milestone | Demonstrable result |
| --- | --- |
| A — Graphics feasibility | One fixture image displays, resizes, and cleans up correctly in Ghostty using the production renderer |
| B — Durable artifacts | A structured image result persists with provenance and replays through the daemon/client API |
| C — Preview state and controls | Selection, pinning, following, history, and responsive layouts work with fixture records |
| D — End-to-end producer | An image-returning MCP tool produces a real preview that survives disconnect and session resume |
| E — Release verification | Terminal lifecycle, performance, fallback, and scroll/queue regressions pass |

Each milestone's implementation tasks and exit checks are defined in the
[implementation document](artifact-preview-implementation.md).

## 9. Definition of done

- A supported image-producing tool can produce one or several images and expose
  each as a correctly attributed preview.
- Pinning/manual inspection wins over incoming output; Follow latest restores
  automatic selection.
- History and explicit revisions survive daemon/client restart.
- Original bytes are accessible even when inline graphics are unavailable.
- Images fit, resize, expand, and disappear cleanly without covering the composer.
- No additional transcript jitter, draft changes, focus theft, or idle image traffic.
- Finished-response mixed-axis trackpad regression continues to pass.
- Production documentation names supported producers, formats, terminals, and
  fallback behavior accurately.
