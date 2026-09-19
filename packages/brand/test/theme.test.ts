import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  THEMES,
  createPainter,
  isThemeName,
  palette,
  resolveTheme,
  themeByName,
  themeLabel,
  themeNames,
} from "../src/index.ts";
import { lightTerminalPalette, terminalPalette } from "../src/theme.ts";

const ROLES = Object.keys(palette) as Array<keyof typeof palette>;

describe("theme registry", () => {
  test("every theme defines every role as a six-digit hex color", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      expect(theme.name).toBe(name);
      expect(theme.label.length).toBeGreaterThan(0);
      expect(["dark", "light"]).toContain(theme.appearance);
      for (const role of ROLES) {
        expect(theme.colors[role], `${name}.${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  test("ships the themes the interface advertises", () => {
    for (const name of ["demesne", "dracula", "tokyo-night", "nord", "gruvbox-dark", "catppuccin-mocha"]) {
      expect(isThemeName(name)).toBe(true);
    }
    expect(themeNames()).toContain(DEFAULT_DARK_THEME);
    expect(themeNames()).toContain(DEFAULT_LIGHT_THEME);
    expect(themeLabel("tokyo-night")).toBe("Tokyo Night");
  });

  test("no theme repeats a color across the roles that must stay distinct", () => {
    // electric, citron, and signal carry meaning, so a theme that maps two of
    // them to one color would erase the distinction the interface draws with.
    for (const [name, theme] of Object.entries(THEMES)) {
      const meanings = [theme.colors.electric, theme.colors.citron, theme.colors.signal];
      expect(new Set(meanings).size, `${name} reuses a meaning color`).toBe(3);
    }
  });

  test("dark and light defaults keep their back-compat aliases", () => {
    expect(terminalPalette).toBe(THEMES[DEFAULT_DARK_THEME]!.colors);
    expect(lightTerminalPalette).toBe(THEMES[DEFAULT_LIGHT_THEME]!.colors);
  });
});

describe("resolveTheme", () => {
  test("uses a named theme when one is configured", () => {
    expect(resolveTheme("dracula", undefined).name).toBe("dracula");
    expect(resolveTheme("Tokyo-Night", undefined).name).toBe("tokyo-night");
  });

  test("keeps accepting dark and light from older configurations", () => {
    expect(resolveTheme("dark", "15;0").name).toBe(DEFAULT_DARK_THEME);
    expect(resolveTheme("light", "0;15").name).toBe(DEFAULT_LIGHT_THEME);
  });

  test("follows the terminal background when unset or auto", () => {
    expect(resolveTheme(undefined, "0;15").appearance).toBe("light");
    expect(resolveTheme(undefined, "15;0").appearance).toBe("dark");
    expect(resolveTheme("auto", "0;15").appearance).toBe("light");
  });

  test("degrades an unknown name to the default rather than failing", () => {
    expect(resolveTheme("sepia", "15;0").name).toBe(DEFAULT_DARK_THEME);
    expect(resolveTheme("", "15;0").name).toBe(DEFAULT_DARK_THEME);
  });

  test("themeByName resolves objects, names, and the dark/light aliases", () => {
    expect(themeByName(THEMES.nord!).name).toBe("nord");
    expect(themeByName("light").name).toBe(DEFAULT_LIGHT_THEME);
    expect(themeByName(undefined).name).toBe(DEFAULT_DARK_THEME);
    expect(themeByName("nope").name).toBe(DEFAULT_DARK_THEME);
  });
});

describe("painter theming", () => {
  test("draws with the active theme's colors", () => {
    const dracula = createPainter(true, "dracula");
    expect(dracula.themeName).toBe("dracula");
    expect(dracula.theme).toBe("dark");
    const expected = THEMES.dracula!.colors.electric;
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(expected.slice(i, i + 2), 16));
    expect(dracula.text("x", "electric")).toContain(`38;2;${r};${g};${b}`);
  });

  test("swaps theme in place so one call re-themes every consumer", () => {
    const painter = createPainter(true, "demesne");
    const before = painter.text("x", "electric");
    painter.setTheme("gruvbox-dark");
    expect(painter.themeName).toBe("gruvbox-dark");
    expect(painter.colors).toBe(THEMES["gruvbox-dark"]!.colors);
    expect(painter.text("x", "electric")).not.toBe(before);

    // Switching to a light theme updates the appearance too.
    painter.setTheme("github-light");
    expect(painter.theme).toBe("light");
  });

  test("a disabled painter stays plain through a theme swap", () => {
    const painter = createPainter(false, "demesne");
    expect(painter.text("x", "electric")).toBe("x");
    painter.setTheme("dracula");
    expect(painter.themeName).toBe("dracula");
    expect(painter.text("x", "electric")).toBe("x");
    expect(painter.chip("READ", "electric")).toBe("[READ]");
  });

  test("every theme renders without throwing for every role", () => {
    const painter = createPainter(true, "demesne");
    for (const name of themeNames()) {
      painter.setTheme(name);
      for (const role of ROLES) {
        expect(painter.text("x", role)).toContain("x");
      }
    }
  });
});
