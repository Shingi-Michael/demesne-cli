/// Terminal themes.
///
/// A theme maps the semantic color roles the interface draws with — `electric`
/// for authorship and primary actions, `citron` for verified and local state,
/// `signal` for boundaries and errors, `paper`/`secondary` for text, `rule` for
/// structure — onto concrete colors. Every drawing call names a role, never a
/// color, so a theme swap changes the whole interface without touching a
/// renderer.
///
/// The palettes are the published values from each project, mapped onto those
/// roles. Where a project has no color for a role, the nearest published one is
/// used and the choice is noted.

/// The canonical Demesne palette, used for surfaces and reference.
export const palette = {
  ink: "#111014",
  paper: "#F7F3EA",
  surface: "#181820",
  raised: "#21212B",
  rule: "#3B3B3F",
  secondary: "#AAA7A0",
  electric: "#3857EB",
  electricBright: "#8CA3FF",
  signal: "#D63D1F",
  citron: "#B8DB47",
} as const;

export type PaletteColor = keyof typeof palette;

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

/// Terminal color occupies less visual space than a GUI surface, so the Demesne
/// theme uses lower-chroma accents than the canonical palette above.
const demesne: Record<PaletteColor, string> = {
  ink: "#111014",
  paper: "#F7F3EA",
  surface: "#1A1A20",
  raised: "#23232A",
  rule: "#56545B",
  secondary: "#918E88",
  electric: "#6678C8",
  electricBright: "#8493D0",
  signal: "#C16B59",
  citron: "#96A865",
};

const demesneLight: Record<PaletteColor, string> = {
  ink: "#111014",
  paper: "#27242A",
  surface: "#EEEAE2",
  raised: "#E4E0D8",
  rule: "#77727B",
  secondary: "#625E63",
  electric: "#4057B5",
  electricBright: "#314AAE",
  signal: "#A9422F",
  citron: "#5F741E",
};

/// https://draculatheme.com — purple is the signature accent, pink its lighter
/// partner, and `selection` serves as the rule color so structure stays quiet.
const dracula: Record<PaletteColor, string> = {
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
};

/// https://github.com/folke/tokyonight.nvim — night, the darkest variant.
const tokyoNight: Record<PaletteColor, string> = {
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
};

/// Tokyo Night's storm variant, for terminals on a lighter background.
const tokyoNightStorm: Record<PaletteColor, string> = {
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
};

/// https://www.nordtheme.com — frost is the accent; nord3 is the rule color.
const nord: Record<PaletteColor, string> = {
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
};

/// https://github.com/morhetz/gruvbox — dark, medium contrast.
const gruvboxDark: Record<PaletteColor, string> = {
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
};

/// https://catppuccin.com — mocha, the darkest flavour.
const catppuccinMocha: Record<PaletteColor, string> = {
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
};

/// Catppuccin's light flavour.
const catppuccinLatte: Record<PaletteColor, string> = {
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
};

/// GitHub's light theme, for a plain white terminal.
const githubLight: Record<PaletteColor, string> = {
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
};

export const THEMES: Record<string, Theme> = {
  demesne: { name: "demesne", label: "Demesne", appearance: "dark", colors: demesne },
  "demesne-light": { name: "demesne-light", label: "Demesne Light", appearance: "light", colors: demesneLight },
  dracula: { name: "dracula", label: "Dracula", appearance: "dark", colors: dracula },
  "tokyo-night": { name: "tokyo-night", label: "Tokyo Night", appearance: "dark", colors: tokyoNight },
  "tokyo-night-storm": { name: "tokyo-night-storm", label: "Tokyo Night Storm", appearance: "dark", colors: tokyoNightStorm },
  nord: { name: "nord", label: "Nord", appearance: "dark", colors: nord },
  "gruvbox-dark": { name: "gruvbox-dark", label: "Gruvbox Dark", appearance: "dark", colors: gruvboxDark },
  "catppuccin-mocha": { name: "catppuccin-mocha", label: "Catppuccin Mocha", appearance: "dark", colors: catppuccinMocha },
  "catppuccin-latte": { name: "catppuccin-latte", label: "Catppuccin Latte", appearance: "light", colors: catppuccinLatte },
  "github-light": { name: "github-light", label: "GitHub Light", appearance: "light", colors: githubLight },
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
