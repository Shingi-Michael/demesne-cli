/// Terminal themes.
///
/// A theme maps the semantic color roles the interface draws with — `electric`
/// for authorship and changes, `inspect`/`execute` for tool operation types,
/// `citron` for confirmed results, `signal` for attention, `paper`/`secondary`
/// for text, `toolSurface`/`toolActive` for execution surfaces, and `syntax*`
/// for code tokens in answers and the Changes panel. Every drawing
/// call names a role, never a color, so a theme swap changes the whole interface
/// without touching a renderer.
///
/// The palettes are the published values from each project, mapped onto those
/// roles. Where a project has no color for a role, the nearest published one is
/// used. Tool surfaces are cool tonal derivatives of each theme's backgrounds.

/// The canonical Demesne palette, used for surfaces and reference. Values are
/// the redesign's `demesne/color` tokens (Figma "demesne UI redesign"); washes
/// and diff rows are those tokens composited over `surface`, since terminals
/// have no alpha.
export const palette = {
  ink: "#0B1218",
  paper: "#C5D2DC",
  strong: "#E6EEF4",
  surface: "#0E161D",
  raised: "#182530",
  rule: "#1E2C38",
  borderBright: "#2F4150",
  secondary: "#8FA1AF",
  muted: "#6B7D8B",
  electric: "#5AA9E6",
  electricBright: "#5AA9E6",
  signal: "#E5534B",
  citron: "#4CC38A",
  thinking: "#E5A93C",
  thinkingSurface: "#282821",
  errorSurface: "#281D23",
  accentSurface: "#172835",
  menuSelection: "#172835",
  diffAddedSurface: "#0F2219",
  diffRemovedSurface: "#26161A",
  userSurface: "#0E161D",
  inspect: "#5AA9E6",
  execute: "#E5A93C",
  toolSurface: "#0E161D",
  toolActive: "#182530",
  syntaxKeyword: "#C49CE6",
  syntaxString: "#9CCF8D",
  syntaxNumber: "#E5A93C",
  syntaxComment: "#5F7280",
  syntaxType: "#6FC2D6",
  syntaxFunction: "#5AA9E6",
  contextMessages: "#5AA9E6",
  contextTools: "#C49CE6",
  contextReserved: "#E5A93C",
  contextFree: "#6B7D8B",
} as const;

export type PaletteColor = keyof typeof palette;
type SyntaxColor = "syntaxKeyword" | "syntaxString" | "syntaxNumber" | "syntaxComment" | "syntaxType" | "syntaxFunction";
type ContextColor = "contextMessages" | "contextTools" | "contextReserved" | "contextFree";
type CoreColors = Omit<Record<PaletteColor, string>, "strong" | "muted" | "borderBright" | "thinking" | "thinkingSurface" | "errorSurface" | "accentSurface" | "menuSelection" | "userSurface" | "diffAddedSurface" | "diffRemovedSurface" | SyntaxColor | ContextColor>;
const menuSelection = (surface: string, accent: string): string => "#" + [1, 3, 5].map((offset) =>
  Math.round(parseInt(surface.slice(offset, offset + 2), 16) * 0.92 + parseInt(accent.slice(offset, offset + 2), 16) * 0.08).toString(16).padStart(2, "0")).join("");
const complete = (colors: CoreColors): Record<PaletteColor, string> => ({ ...colors,
  strong: colors.paper,
  muted: colors.secondary, borderBright: colors.rule, thinking: colors.execute,
  thinkingSurface: colors.raised, errorSurface: colors.raised, accentSurface: colors.toolActive, menuSelection: menuSelection(colors.surface, colors.electric), userSurface: colors.toolSurface,
  diffAddedSurface: menuSelection(colors.surface, colors.citron), diffRemovedSurface: menuSelection(colors.surface, colors.signal),
  // Syntax roles come from each project's own accents so code keeps the
  // theme's character: its purple/pink for keywords, green for strings.
  syntaxKeyword: colors.execute, syntaxString: colors.citron, syntaxNumber: colors.electricBright,
  syntaxComment: colors.secondary, syntaxType: colors.inspect, syntaxFunction: colors.electric,
  contextMessages: colors.electric, contextTools: colors.inspect, contextReserved: colors.execute, contextFree: colors.secondary });

export type TerminalTheme = "dark" | "light";

export interface Theme {
  /// The registry key, e.g. "tokyo-night".
  name: string;
  /// Human name, for a picker.
  label: string;
  /// The terminal background the theme is built for.
  appearance: TerminalTheme;
  colors: Record<PaletteColor, string>;
}

/// The redesign's calmer dark palette (Figma "demesne UI redesign").
/// Translucent request/thinking fills are composited onto its dark surfaces.
const demesne: Record<PaletteColor, string> = { ...palette };

/// The redesign palette carried to light terminals: the same blue accent and
/// softer semantic tones, darkened for at least 4.5:1 text contrast on every
/// light surface (dim `muted` text excepted, like the dark theme).
const demesneLight: Record<PaletteColor, string> = {
  ink: "#F6F8FA",
  paper: "#1F2A33",
  strong: "#1F2A33",
  surface: "#EEF2F5",
  raised: "#E2E8ED",
  rule: "#CBD5DD",
  borderBright: "#A7B6C2",
  secondary: "#4B5D6B",
  muted: "#55687A",
  electric: "#1F62A8",
  electricBright: "#1A5591",
  signal: "#B3302A",
  citron: "#166A3F",
  thinking: "#8A5700",
  thinkingSurface: "#E2DFD8",
  errorSurface: "#E8DFE1",
  accentSurface: "#D5E1EC",
  menuSelection: "#D5E1EC",
  diffAddedSurface: "#D4E2DF",
  diffRemovedSurface: "#E8DFE1",
  userSurface: "#EEF2F5",
  inspect: "#1F62A8",
  execute: "#8A5700",
  toolSurface: "#EEF2F5",
  toolActive: "#E2E8ED",
  syntaxKeyword: "#7A3E9D",
  syntaxString: "#2F6F1F",
  syntaxNumber: "#8A5600",
  syntaxComment: "#5E7684",
  syntaxType: "#0B6A74",
  syntaxFunction: "#1F5FAD",
  contextMessages: "#1F62A8",
  contextTools: "#7A3E9D",
  contextReserved: "#8A5700",
  contextFree: "#55687A",
};

/// https://draculatheme.com — purple is the signature accent, pink its lighter
/// partner, and `selection` serves as the rule color so structure stays quiet.
const dracula: CoreColors = {
  ink: "#282A36",
  paper: "#F8F8F2",
  surface: "#2E303E",
  raised: "#383A4A",
  rule: "#44475A",
  secondary: "#6272A4",
  electric: "#BD93F9",
  electricBright: "#FF79C6",
  signal: "#FF5555",
  citron: "#50FA7B",
  inspect: "#8BE9FD",
  execute: "#F1FA8C",
  toolSurface: "#232B35",
  toolActive: "#334454",
};

/// https://github.com/folke/tokyonight.nvim — night, the darkest variant.
const tokyoNight: CoreColors = {
  ink: "#1A1B26",
  paper: "#C0CAF5",
  surface: "#1F2335",
  raised: "#292E42",
  rule: "#3B4261",
  secondary: "#565F89",
  electric: "#7AA2F7",
  electricBright: "#7DCFFF",
  signal: "#F7768E",
  citron: "#9ECE6A",
  inspect: "#7DCFFF",
  execute: "#BB9AF7",
  toolSurface: "#202A3A",
  toolActive: "#2C3E55",
};

/// Tokyo Night's storm variant, for terminals on a lighter background.
const tokyoNightStorm: CoreColors = {
  ink: "#24283B",
  paper: "#C0CAF5",
  surface: "#292E42",
  raised: "#343B58",
  rule: "#414868",
  secondary: "#565F89",
  electric: "#7AA2F7",
  electricBright: "#7DCFFF",
  signal: "#F7768E",
  citron: "#9ECE6A",
  inspect: "#7DCFFF",
  execute: "#BB9AF7",
  toolSurface: "#253043",
  toolActive: "#344863",
};

/// https://www.nordtheme.com — frost is the accent; nord3 is the rule color.
const nord: CoreColors = {
  ink: "#2E3440",
  paper: "#ECEFF4",
  surface: "#3B4252",
  raised: "#434C5E",
  rule: "#4C566A",
  secondary: "#616E88",
  electric: "#88C0D0",
  electricBright: "#8FBCBB",
  signal: "#BF616A",
  citron: "#A3BE8C",
  inspect: "#81A1C1",
  execute: "#B48EAD",
  toolSurface: "#303D4A",
  toolActive: "#415264",
};

/// https://github.com/morhetz/gruvbox — dark, medium contrast.
const gruvboxDark: CoreColors = {
  ink: "#282828",
  paper: "#EBDBB2",
  surface: "#32302F",
  raised: "#3C3836",
  rule: "#504945",
  secondary: "#928374",
  electric: "#83A598",
  electricBright: "#8EC07C",
  signal: "#FB4934",
  citron: "#B8BB26",
  inspect: "#8EC07C",
  execute: "#D3869B",
  toolSurface: "#252D30",
  toolActive: "#374145",
};

/// https://catppuccin.com — mocha, the darkest flavour.
const catppuccinMocha: CoreColors = {
  ink: "#1E1E2E",
  paper: "#CDD6F4",
  surface: "#181825",
  raised: "#313244",
  rule: "#45475A",
  secondary: "#7F849C",
  electric: "#89B4FA",
  electricBright: "#94E2D5",
  signal: "#F38BA8",
  citron: "#A6E3A1",
  inspect: "#89DCEB",
  execute: "#CBA6F7",
  toolSurface: "#192331",
  toolActive: "#29394D",
};

/// Catppuccin's light flavour.
const catppuccinLatte: CoreColors = {
  ink: "#EFF1F5",
  paper: "#4C4F69",
  surface: "#E6E9EF",
  raised: "#DCE0E8",
  rule: "#BCC0CC",
  secondary: "#8C8FA1",
  electric: "#1E66F5",
  electricBright: "#179299",
  signal: "#D20F39",
  citron: "#40A02B",
  inspect: "#147D8E",
  execute: "#8839EF",
  toolSurface: "#E2EAF3",
  toolActive: "#D1DFEF",
};

/// GitHub's light theme, for a plain white terminal.
const githubLight: CoreColors = {
  ink: "#FFFFFF",
  paper: "#24292F",
  surface: "#F6F8FA",
  raised: "#EAEEF2",
  rule: "#D0D7DE",
  secondary: "#57606A",
  electric: "#0969DA",
  electricBright: "#8250DF",
  signal: "#CF222E",
  citron: "#116329",
  inspect: "#096C83",
  execute: "#8250DF",
  toolSurface: "#EAF2F7",
  toolActive: "#D9E8F2",
};

export const THEMES: Record<string, Theme> = {
  demesne: { name: "demesne", label: "Demesne", appearance: "dark", colors: demesne },
  "demesne-light": { name: "demesne-light", label: "Demesne Light", appearance: "light", colors: demesneLight },
  dracula: { name: "dracula", label: "Dracula", appearance: "dark", colors: complete(dracula) },
  "tokyo-night": { name: "tokyo-night", label: "Tokyo Night", appearance: "dark", colors: complete(tokyoNight) },
  "tokyo-night-storm": { name: "tokyo-night-storm", label: "Tokyo Night Storm", appearance: "dark", colors: complete(tokyoNightStorm) },
  nord: { name: "nord", label: "Nord", appearance: "dark", colors: complete(nord) },
  "gruvbox-dark": { name: "gruvbox-dark", label: "Gruvbox Dark", appearance: "dark", colors: complete(gruvboxDark) },
  "catppuccin-mocha": { name: "catppuccin-mocha", label: "Catppuccin Mocha", appearance: "dark", colors: complete(catppuccinMocha) },
  "catppuccin-latte": { name: "catppuccin-latte", label: "Catppuccin Latte", appearance: "light", colors: complete(catppuccinLatte) },
  "github-light": { name: "github-light", label: "GitHub Light", appearance: "light", colors: complete(githubLight) },
};

export const DEFAULT_DARK_THEME = "demesne";
export const DEFAULT_LIGHT_THEME = "demesne-light";

/// Back-compat aliases: the Demesne themes are what the interface shipped with.
export const terminalPalette = THEMES[DEFAULT_DARK_THEME]!.colors;
export const lightTerminalPalette = THEMES[DEFAULT_LIGHT_THEME]!.colors;

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

export function isThemeName(value: string | undefined): boolean {
  return value !== undefined && Object.hasOwn(THEMES, value);
}

/// The theme's human label, for a picker.
export function themeLabel(name: string): string {
  return THEMES[name]?.label ?? name;
}

/// Reads the terminal background from `COLORFGBG`, which reports
/// `foreground;background` as ANSI indexes. Anything 7 or brighter is a light
/// background.
export function detectAppearance(colorForegroundBackground: string | undefined): TerminalTheme {
  const background = Number(colorForegroundBackground?.split(";").at(-1));
  return Number.isFinite(background) && background >= 7 ? "light" : "dark";
}

/// Resolves the configured value to a theme.
///
/// `undefined`, `auto`, and an unknown name fall back to the Demesne theme for
/// the detected appearance, so a typo degrades to the default rather than
/// breaking startup. `dark` and `light` remain accepted for the configurations
/// written before named themes existed.
export function resolveTheme(
  configured: string | undefined,
  colorForegroundBackground: string | undefined,
): Theme {
  const wanted = configured?.trim().toLowerCase();
  if (wanted && isThemeName(wanted)) return THEMES[wanted]!;
  const appearance = wanted === "light" || wanted === "dark"
    ? wanted
    : detectAppearance(colorForegroundBackground);
  return THEMES[appearance === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME]!;
}
