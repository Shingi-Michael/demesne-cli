import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME_SKIES, isHomeSky, mountMilkyWay, PIECES, SKY } from "../milkyway.ts";

/// Just enough of a page for the sky to mount on: elements that keep what they were given.
type Fake = { tag: string; className: string; src: string; alt: string; hidden: boolean; style: Record<string, string>; dataset: Record<string, string>; kids: Fake[]; append(...kids: Fake[]): void };
const element = (tag: string): Fake => ({ tag, className: "", src: "", alt: "x", hidden: false, style: {}, dataset: {}, kids: [], append(...kids) { this.kids.push(...kids); } });
const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = realDocument; });
const mount = (dark: boolean, floor: () => number, piece?: Parameters<typeof mountMilkyWay>[3]) => {
  (globalThis as { document?: unknown }).document = { createElement: element };
  const host = element("div");
  return { host, sky: mountMilkyWay(host as unknown as HTMLElement, dark, floor, piece) };
};

test("Home's sky is one galaxy picture with the flagship over it (pass 268)", () => {
  const { host } = mount(true, () => 220);
  expect(host.kids).toHaveLength(1);
  const [box] = host.kids, [sky, ship] = box!.kids;
  expect(box!.className).toBe("mw-hero");
  expect([sky!.className, sky!.src]).toEqual(["mw-sky", SKY.night]);
  expect([ship!.className, ship!.src]).toEqual(["mw-ship", SKY.ship]);
  // decoration: a screen reader hears nothing for either picture
  expect([sky!.alt, ship!.alt]).toEqual(["", ""]);
});

test("the sky turns to dawn with the light theme and back, and the ship stays", () => {
  const { host, sky } = mount(true, () => 220);
  const [picture, ship] = host.kids[0]!.kids;
  sky.setDark(false); expect(picture!.src).toBe(SKY.dawn);
  sky.setDark(true); expect(picture!.src).toBe(SKY.night);
  expect(ship!.src).toBe(SKY.ship);
});

test("the sky ends just under the top of the greeting, and follows it when Home grows a line", () => {
  let floor = 220;
  const { host, sky } = mount(false, () => floor);
  expect(host.kids[0]!.style.height).toBe("234px");
  floor = 301.4; sky.refit();
  expect(host.kids[0]!.style.height).toBe("315px");
  // a greeting above the panel's top never gives the sky a negative height
  floor = -80; sky.refit();
  expect(host.kids[0]!.style.height).toBe("0px");
});

test("Home's sky flies the piece you picked, swaps it in place, and can be just the sky (pass 276)", () => {
  const { host, sky } = mount(true, () => 220, "station");
  const [box] = host.kids, [, ship] = box!.kids;
  expect([box!.dataset.piece, ship!.src, ship!.hidden]).toEqual(["station", PIECES.station, false]);
  sky.setPiece("planet"); expect([box!.dataset.piece, ship!.src]).toEqual(["planet", PIECES.planet]);
  sky.setPiece("none"); expect([box!.dataset.piece, ship!.hidden]).toEqual(["none", true]);
  sky.setPiece("flagship"); expect([ship!.src, ship!.hidden]).toEqual([SKY.ship, false]);
  // with nothing saved, the flagship flies, as before
  expect(mount(true, () => 220).host.kids[0]!.dataset.piece).toBe("flagship");
  expect(HOME_SKIES.map(([id]) => id)).toEqual(["flagship", "station", "freighter", "scout", "planet", "none"]);
  expect([isHomeSky("scout"), isHomeSky("probe"), isHomeSky(null)]).toEqual([true, false, false]);
});

test("each piece has its own place in the sky", () => {
  const css = readFileSync(join(import.meta.dir, "../../workspace.css"), "utf8");
  for (const id of Object.keys(PIECES).filter((id) => id !== "flagship")) expect(css).toContain(`.mw-hero[data-piece="${id}"] .mw-ship {`);
});

test("the pictures the sky names ship with the app, and stay light", () => {
  const workspace = join(import.meta.dir, "..");
  for (const path of [...Object.values(SKY), ...Object.values(PIECES)]) {
    expect(existsSync(join(workspace, path))).toBe(true);
    expect(statSync(join(workspace, path)).size).toBeLessThan(400_000);
  }
});

test("in its own full-screen Space the Milky Way themes put the ringed planet under the glass (pass 275 C)", () => {
  const css = readFileSync(join(import.meta.dir, "../../workspace.css"), "utf8");
  const assets = join(import.meta.dir, "../assets");
  // night and dawn, each already frosted, small enough to load at once
  for (const name of ["milky-way-full-night.jpg", "milky-way-full-dawn.jpg"]) {
    expect(css).toContain(`url("assets/${name}")`);
    expect(statSync(join(assets, name)).size).toBeLessThan(120_000);
  }
  // only in full screen, only for Demesne's own themes; other themes keep their plain ground
  const rules = css.split("\n").filter((line) => line.includes("--full-sky"));
  expect(rules.length).toBeGreaterThan(2);
  for (const rule of rules) expect(rule).toMatch(/^html\.glass\.fullscreen(:is\(\[data-theme="demesne"\], \[data-theme="demesne-light"\]\)|\[data-theme="demesne-light"\]) /);
  // pinned to the window, so the sidebar and the page show one sky
  expect(rules.filter((rule) => rule.includes("var(--full-sky) center / cover fixed"))).toHaveLength(2);
  // Home's own galaxy steps aside for it
  expect(css).toContain('html.glass.fullscreen:is([data-theme="demesne"], [data-theme="demesne-light"]) .mw-sky { opacity: 0; }');
});
