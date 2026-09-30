import { afterEach, expect, test } from "bun:test";
import { createPainter } from "@demesne/brand";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";

const stdout = process.stdout as unknown as { isTTY?: boolean; write: (chunk: string) => boolean };
const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => unknown; resume: () => unknown; pause: () => unknown };
const saved = { tty: stdout.isTTY, write: stdout.write, raw: stdin.setRawMode, resume: stdin.resume };
afterEach(() => { stdout.isTTY = saved.tty; stdout.write = saved.write; stdin.setRawMode = saved.raw; stdin.resume = saved.resume; });

test("while running, the terminal background follows the theme's page color, and exit restores the terminal's own", () => {
  let written = "";
  stdout.isTTY = true; stdout.write = (chunk: string) => { written += chunk; return true; };
  stdin.setRawMode = () => stdin; stdin.resume = () => stdin;
  const paint = createPainter(true);
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  ui.start();
  expect(written).toContain(`\x1b]11;${paint.colors.ink}\x07`);
  // Re-sent only when the color changes: a theme switch.
  written = ""; (ui as unknown as { render(): void }).render();
  expect(written).not.toContain("\x1b]11;");
  paint.setTheme("demesne-light"); (ui as unknown as { render(): void }).render();
  expect(written).toContain(`\x1b]11;${paint.colors.ink}\x07`);
  written = ""; ui.stop();
  expect(written).toContain("\x1b]111\x07");
  expect(written.indexOf("\x1b]111\x07")).toBeGreaterThan(written.indexOf("\x1b[?1049l"));
});

test("without color, the terminal background is left alone", () => {
  let written = "";
  stdout.isTTY = true; stdout.write = (chunk: string) => { written += chunk; return true; };
  stdin.setRawMode = () => stdin; stdin.resume = () => stdin;
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  ui.start(); ui.stop();
  expect(written).not.toContain("\x1b]11;"); expect(written).not.toContain("\x1b]111");
});
