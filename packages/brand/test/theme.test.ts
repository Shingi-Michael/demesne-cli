import { describe, expect, test } from "bun:test";
import {
  THEMES,
  resolveTheme} from "../src/index.ts";

const palette = THEMES.demesne!.colors;
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

  test("operation, success, and failure roles remain distinct", () => {
    // Operation types and outcomes have different meanings. Themes must not
    // present a running check in the same color as a confirmed result.
    for (const [name, theme] of Object.entries(THEMES)) {
      const meanings = [theme.colors.inspect, theme.colors.execute, theme.colors.citron, theme.colors.signal];
      expect(new Set(meanings).size, `${name} reuses a meaning color`).toBe(4);
    }
  });
});

describe("resolveTheme", () => {
  test("uses a named theme when one is configured", () => {
    expect(resolveTheme("dracula", undefined).name).toBe("dracula");
    expect(resolveTheme("Tokyo-Night", undefined).name).toBe("tokyo-night");
  });

  test("follows the terminal background when unset or auto", () => {
    expect(resolveTheme(undefined, "0;15").appearance).toBe("light");
    expect(resolveTheme(undefined, "15;0").appearance).toBe("dark");
    expect(resolveTheme("auto", "0;15").appearance).toBe("light");
  });
});
