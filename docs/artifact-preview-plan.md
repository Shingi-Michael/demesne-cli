# Image preview: user guide

[Documentation index](README.md) · [Pipeline implementation](artifact-preview-implementation.md) · [Review panels](../apps/graphics/README.md#review-panel-upgrades)

**Implemented.** This file retains its original name for existing links. It describes the shipped image feature, not a pending delivery plan.

## Supported images and producers

The daemon ingests static PNG, JPEG and WebP images. Files are limited to 20 MiB and 40 million decoded pixels; multi-frame images and MIME/format mismatches are rejected. Original bytes are retained, and a normalized PNG preview fits within 1600 × 1600 without upscaling.

| Producer | What is available |
| --- | --- |
| MCP tools returning image content blocks | Structured ingestion with source/tool attribution |
| `view_image` | Import an image from the permitted workspace |
| `capture_window` | macOS window capture when the tool is registered and OS permission is available |
| `generate_image` | Generate or edit using a separately configured Images-compatible backend |
| Preview reference import | Import a workspace image, optionally with viewport metadata |

Image-producing tools must be configured/available. Enabling `vision`, image generation, or MCP servers registers the image-viewing path; `capture_window` is macOS-specific. Generation credentials are separate from ChatGPT sign-in. See [configuration](configuration.md#images-and-mcp).

## Use Preview

Open **Alt+V** or Preview in the rail. The panel offers artifact history, **Pin**, **Follow latest**, **Open original**, fit/100% zoom, and drag-to-pan. Manual selection/pinning takes precedence over newly arriving artifacts; Follow latest opts back into automatic selection. New images do not automatically reopen a dismissed panel or change the draft.

Choose an existing image as a reference or import a PNG/JPEG/WebP workspace export. **Compare** overlays images with an opacity control. Unequal dimensions are labeled and aligned at the top left without stretching.

An import requires a workspace-bound session with at least one conversation turn. Imported references remain session artifacts; missing viewport metadata is shown as unknown rather than inferred. Closing/reopening the client retains the daemon's artifacts, but current pin, zoom, comparison and selection are local UI state—not a promise that every viewing preference survives process restart.

## What an artifact records

Each immutable image has an ID, session/turn/tool association, creation time, filename, verified MIME type, dimensions, byte count, hash and source. Model attribution is present only if the producer supplies it. A revision link is recorded only when explicitly provided and valid for the session; similar filenames do not establish a revision history.

Original and preview files remain available even if the workspace copy is overwritten. History can load them without rerunning the producer. Missing content produces an unavailable response instead of regenerated evidence.

## Preview and model vision are separate

Displaying an image does not automatically give its pixels to the language model. With the daemon's vision path enabled, the latest two retained tool-image IDs in model context are resolved into image inputs at the provider boundary. Older images keep metadata; missing cached bytes fall back to text. The selected provider/model must support those inputs.

The chat model's identity, the image-generation model's identity, and the tool that captured a screenshot can all differ. Keep those labels distinct when describing a result.

## Current boundaries

- This is an image-artifact viewer, not arbitrary HTML/app execution, video playback, an arcade, or an interactive website preview.
- There is no universal durable image-operation lifecycle declaring every producer to be “generating.” Tool progress and completed artifacts supply the available evidence.
- View/compare controls do not perform image editing. Reference-based generation is a separate approved tool call.
- The interactive UI is the [desktop window](desktop.md); headless commands remain available separately.
- OS screenshot permission is still required for native capture. A denied permission is not bypassed by another capture path.

[Verification commands](artifact-preview-implementation.md#verification) exercise persistence, HTTP retrieval, image inputs, and the panel API.
