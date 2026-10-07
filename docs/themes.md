# Themefy and saved themes

Type **`/themefy`** in the normal composer in the [desktop app](desktop.md). The selected model asks a short series of questions about the mood, appearance, accents and details you want. Type each answer in that same composer and press Enter. Follow-ups adapt to your answers, and refinements replace earlier preferences. Usually two to four questions are enough.

You can start with a direction, such as `/themefy warm forest colours`. That informs the interview; it does not skip the questions. [Pause, Resume and Cancel interview](questions.md#pause-resume-and-cancel) work normally. Closing the app leaves the daemon's interview alive. After a daemon restart, the saved question resumes only when you explicitly answer it, retaining its earlier preferences.

Once the model has enough information, Demesne validates and applies the palette to the running interface. Layout, typography and spacing stay the same. No rebuild or restart is needed for a makeover. Every generated theme is saved automatically on this machine.

| Command or control | Result |
| --- | --- |
| `/themefy` | Start an adaptive interview |
| `/themefy PREFERENCES` | Give an initial direction and start the interview |
| `/theme` | Open the theme picker; generated palettes appear under **Your themes** |
| `/theme NAME` | Select a built-in or saved theme by its registry name |
| `/themefy undo` | Restore the previous palette, keeping the generated theme saved |
| **Undo last theme change** in the picker | The same undo operation |

## Validation and persistence

The model supplies a short name, dark/light appearance and six-digit hex colors. The daemon derives the remaining semantic tokens and adjusts foreground tones towards white or black until they reach 4.5:1 contrast on the generated base, selection, status and diff surfaces. This uses the [W3C relative-luminance contrast calculation](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); it is a palette check, not a claim that the entire application has been audited for WCAG conformance. Error and success colors retain their semantic meanings. Incompatible surfaces and invalid inputs are returned to the model to correct.

The Themefy turn exposes only `ask_user` and `apply_theme`. Execution, filesystem, subagent and session tools are unavailable and rejected even if a model invents a call. At least two explicit typed answers are required before application. Palette validation accepts no CSS, JavaScript, filesystem paths or layout changes. Questions and generated colors are kept out of subsequent coding model context.

Selections, custom palettes and up to 20 undo steps are stored atomically in `themes.json` beside the daemon's SQLite database. The file is private to your user. It takes precedence over the initial configured theme once you choose a theme. Saved themes survive application and daemon restarts. Undo restores the previous selection without removing a custom theme from the picker. The library currently allows 256 generated themes; deleting or exporting themes is not yet a picker feature. A corrupt library is preserved and cannot be silently overwritten.

Cancellation, model failure before application, and rejected colors leave the current palette unchanged. A successful application ends the workflow immediately with a saved-theme receipt. Themefy uses the selected provider and model, so model latency still affects the interview; applying the completed palette requires no further inference call.

## API and implementation

- `POST /v1/sessions/ID/themefy` accepts optional `preferences` (up to 2,000 characters) and starts a restricted `themefy` turn, including without a project.
- `GET /v1/themes` returns the selected palette, theme library and undo availability.
- `POST /v1/themes` accepts `{ "action": "select", "name": "…" }` or `{ "action": "undo" }`.
- Answers use the [question protocol](questions.md#protocol). Restart continuations retain the Themefy scope and exact chain of recorded answers.

Source: [palette validation](../packages/brand/src/custom-theme.ts), [theme storage](../apps/daemon/src/themes.ts), [interview prompt and tool schema](../apps/daemon/src/themefy.ts), [restricted engine](../apps/daemon/src/engine.ts), and [interface host](../apps/graphics/host.ts).
