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
- `POST /v1/themes` accepts `{ "action": "select", "name": "…" }`, `{ "action": "undo" }`, or `{ "action": "system-source", "enabled": false, "path": "/absolute/palette.json" }`.
- Answers use the [question protocol](questions.md#protocol). Restart continuations retain the Themefy scope and exact chain of recorded answers.

Source: [palette validation](../packages/brand/src/custom-theme.ts), [theme storage](../apps/daemon/src/themes.ts), [interview prompt and tool schema](../apps/daemon/src/themefy.ts), [restricted engine](../apps/daemon/src/engine.ts), and [interface host](../apps/desktop/workspace/host.ts).

## Installed themes and System mode

User theme files live in **`~/.demesne/themes/`** on every platform, independently of a custom daemon data directory. Demesne creates this directory when the daemon starts. No source changes, rebuild, model call, or restart is required to install a palette: put a JSON file there and open `/theme` or Appearance settings. Connected windows check for theme changes every two seconds, including changes made in another window.

- `forest.json` appears under its label and can be selected with `/theme installed-forest`.
- **System** (`/theme system`) uses Demesne's default light/dark palettes unless you explicitly enable an external palette in **Settings → Appearance → Use an external System palette**. An existing `system.json` alone does not enable the override.
- **System palette file** defaults to `~/.demesne/themes/system.json`. You may symlink this file manually, or enter an absolute path (or a path starting with `~/`) directly in Settings and choose **Save path**. The path is on the daemon's computer. Saving a path does not enable it or change the selected theme; the separate switch controls whether System reads it. Demesne reads the path directly without creating or replacing symlinks. The path and switch are stored with the theme library and take effect without restarting.
- With the external switch off, or before the enabled source has supplied a valid palette, System follows the desktop's light/dark preference using Demesne's built-in pair. On Linux, availability of appearance changes depends on the desktop environment and Electron's integration. This fallback does not claim to discover a terminal's ANSI palette or arbitrary desktop accent colors.
- **Themefy (latest generated)** (`/theme themefy`) appears after the first successful Themefy generation. It selects the latest generated palette, while all earlier palettes remain individually selectable and undoable. No model runs when you select this entry. Themefy does not overwrite `system.json` or third-party files.

Filenames use lowercase letters, digits and dashes, beginning with a letter or digit, up to 64 characters before `.json`. `system.json` is reserved for the System entry. Each file must be a JSON object with exactly `label`, `appearance` (`dark` or `light`), and `colors`. All 14 color keys below are required and must contain six-digit `#RRGGBB` values:

```json
{
  "label": "Forest",
  "appearance": "dark",
  "colors": {
    "background": "#181A14",
    "surface": "#20231B",
    "raised": "#2B3024",
    "text": "#EEEAD8",
    "secondary": "#7B806B",
    "accent": "#A6B879",
    "accentBright": "#DBCD8B",
    "warning": "#DBC384",
    "syntaxKeyword": "#C6A6D0",
    "syntaxString": "#A6B879",
    "syntaxNumber": "#DBCD8B",
    "syntaxComment": "#6C745C",
    "syntaxType": "#91C0B0",
    "syntaxFunction": "#D3B889"
  }
}
```

Installed themes use the same semantic derivation and foreground contrast correction as Themefy, so low-contrast text can differ from the source palette. They allow a wider range of surface tones than Themefy's generated-palette design constraints. CSS, scripts, layout properties, and other keys are rejected. Files are limited to 64 KiB, and the library retains at most 256 installed palettes. Built-in names cannot be replaced by ordinary installed files.

Atomic file replacement and symlinks to generator output are supported. Invalid, missing, or partially written files keep their last valid palette rather than interrupting work. Last-good installed palettes are cached in the daemon's `themes.json` on the next theme selection/generation/undo; later valid file contents take precedence. Removing a file does not delete its cached entry. Undo restores the previous theme selection; for installed themes this means that theme's current last-good colors, not a historical revision of the external file. Generated Themefy palettes remain immutable snapshots.

### Kuru

Kuru is the system palette source for this setup; it does not use Matugen. Its Quickshell `ThemeService` renders application palettes through `services/KuruThemeTargets.js` whenever the theme family, effective light/dark mode, or Dynamic seed changes. Dynamic derives its seed from the wallpaper using ImageMagick. Kuru also updates GNOME appearance settings, but those settings alone do not carry its full palette.

The canonical Demesne export is `${XDG_STATE_HOME:-$HOME/.local/state}/kuru/theme/demesne.json`. Kuru writes it as a temporary file and atomically renames it into place. It contains `label: "Kuru: <theme-id>"`, the effective `appearance`, and all 14 color keys as lowercase six-digit hex values. [This exact Monokai Soda example](theme-examples/kuru.json) was supplied by Kuru's agent from its generated output.

Kuru owns this export and does not write directly into other applications' configuration directories. To connect it without a symlink, enter its expanded absolute path (normally `~/.local/state/kuru/theme/demesne.json`) in **Settings → Appearance → System palette file**, save it, turn on **Use an external System palette**, and select **System**. If you set `XDG_STATE_HOME`, use that directory instead; the path field does not expand shell variables.

Alternatively, leave the palette path at `~/.demesne/themes/system.json` and create the link yourself:

```sh
mkdir -p ~/.demesne/themes
ln -s "${XDG_STATE_HOME:-$HOME/.local/state}/kuru/theme/demesne.json" ~/.demesne/themes/system.json
```

Then turn on **Use an external System palette** and select `/theme system`. Turn the switch off at any time to return to Demesne's default System palette; the source file, path and symlink are left intact.

Do not overwrite an existing `system.json` without backing it up. The link may initially be dangling; System uses its fallback until valid generator output is available. Kuru owns its output file; Demesne only reads it.


## Appearance and glass

System's default light/dark choice comes from Electron's native system appearance, after clearing any previous explicit app-theme override. A selected external palette uses its own `appearance` field instead. On Linux the desktop session must publish its appearance through the settings portal/GTK integration; Kuru publishes these settings separately from its palette export.

Glass is a separate material layer over every palette, including installed and Themefy themes. Changing colors does not reset the Glass slider or make the shell opaque. Shell and conversation panels use the selected palette's background tones at the configured opacity; menus and popovers remain solid for readability. Actual background blur/translucency still requires a supported compositor or macOS vibrancy. The slider runs from nearly see-through (Clear) to solid; while it is clear, answers and code get a soft backing so text stays readable. On the Mac, `DEMESNE_VIBRANCY` (for example `fullscreen-ui` or `under-window`) swaps the blur material, which defaults to `hud`, the one that showed the most wallpaper colour.

After `bun scripts/prepare-desktop.ts`, `bun scripts/check-theme-material.ts` runs a disposable real-Electron regression check for native System appearance and glass across dark, light, and Kuru palettes. It requires a graphical session (or a virtual display).
