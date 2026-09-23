/// Terminal themes.
///
/// A theme maps the semantic color roles the interface draws with — `electric`
/// for authorship and changes, `inspect`/`execute` for tool operation types,
/// `citron` for confirmed results, `signal` for attention, `paper`/`secondary`
/// for text, and `toolSurface`/`toolActive` for execution surfaces. Every drawing
/// call names a role, never a color, so a theme swap changes the whole interface
/// without touching a renderer.
///
/// The palettes are the published values from each project, mapped onto those
/// roles. Where a project has no color for a role, the nearest published one is
/// used. Tool surfaces are cool tonal derivatives of each theme's backgrounds.

/// The canonical Demesne palette, used for surfaces and reference.
export const palette = {
  ink: "#050A0E",
  paper: "#C8DAE8",
  surface: "#090F14",
  raised: "#0D1720",
  rule: "#1A2D3D",
  borderBright: "#1E3A4F",
  secondary: "#7A9FB8",
  muted: "#536E82",
  electric: "#00D4FF",
  electricBright: "#00D4FF",
  signal: "#FF4C4C",
  citron: "#00E676",
  thinking: "#FFB700",
  thinkingSurface: "#272312",
  errorSurface: "#181317",
  accentSurface: "#082C37",
  userSurface: "#05161C",
  inspect: "#00D4FF",
  execute: "#FFB700",
  toolSurface: "#090F14",
  toolActive: "#0D1720",
} as const;

export type PaletteColor = keyof typeof palette;
type CoreColors = Omit<Record<PaletteColor, string>, "muted" | "borderBright" | "thinking" | "thinkingSurface" | "errorSurface" | "accentSurface" | "userSurface">;
const complete = (colors: CoreColors): Record<PaletteColor, string> => ({ ...colors,
  muted: colors.secondary, borderBright: colors.rule, thinking: colors.execute,
  thinkingSurface: colors.raised, errorSurface: colors.raised, accentSurface: colors.toolActive, userSurface: colors.toolSurface });

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

/// Futuristic Terminal Harness Design, with slightly raised panel contrast.
/// Translucent request/thinking fills are composited onto its dark surfaces.
const demesne: Record<PaletteColor, string> = { ...palette };

const demesneLight: Record<PaletteColor, string> = {
  ink: "#F5FAFD",
  paper: "#183447",
  surface: "#ECF4F8",
  raised: "#E0EDF4",
  rule: "#B8CCD9",
  borderBright: "#91AFBF",
  secondary: "#486C82",
  muted: "#627D8E",
  electric: "#007B9B",
  electricBright: "#006780",
  signal: "#BF303C",
  citron: "#087D43",
  thinking: "#946500",
  thinkingSurface: "#F4ECD8",
  errorSurface: "#F8EAEC",
  accentSurface: "#C9E7EF",
  userSurface: "#E2F2F8",
  inspect: "#007B9B",
  execute: "#946500",
  toolSurface: "#ECF4F8",
  toolActive: "#E0EDF4",
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
