import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { designGuideBlock } from "../src/design-guide.ts";
import { foundryEditTool, foundrySaveTool } from "../src/foundry.ts";
import { chromatic, colorHSL, firstFont, loadProjectLook, nearest, offLook, projectLookBlock, readStylesheet, readTailwind } from "../src/project-look.ts";

// Piece 1 of pass 274, your project's look: Foundry reads a project's own
// colours, type, corners and components from its code, draws its mockups in
// them, and checks each one against them before it is shown.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-look-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
  return root;
};
const signal = new AbortController().signal;

const TAILWIND = `import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: {
    colors: {
      primary: { DEFAULT: "#0f766e", 600: "#0d5f59" }, // the clinic's teal
      paper: "#fbfaf7",
      ink: "#1c2422",
      warn: "#b45309",
    },
    fontFamily: { display: ["Georgia", "serif"], sans: ["Inter", "system-ui"] },
    borderRadius: { card: "10px", full: "9999px" },
  } },
} satisfies Config;`;

test("a Tailwind config gives its colours by name, the first family of each font, and its corners", () => {
  const found = readTailwind(TAILWIND);
  expect(found.colors).toEqual([{ name: "primary", value: "#0f766e" }, { name: "primary-600", value: "#0d5f59" }, { name: "paper", value: "#fbfaf7" }, { name: "ink", value: "#1c2422" }, { name: "warn", value: "#b45309" }]);
  expect(found.fonts).toEqual(["Georgia", "Inter"]);
  expect(found.corners).toEqual(["10px", "9999px"]);
});

test("a stylesheet gives its custom properties: colours (shadcn triplets too), fonts and radius, the first time each is set", () => {
  const found = readStylesheet(`:root { --background: 0 0% 100%; --primary: 173 77% 26%; --brand: #b45309; --font-sans: "Inter", system-ui; --radius: 0.5rem; --space: 4px; }
    .dark { --primary: 280 80% 60%; }
    body { font-family: var(--font-sans), sans-serif; } h1 { font-family: "Fraunces", Georgia, serif; }`);
  expect(found.colors).toEqual([{ name: "background", value: "hsl(0 0% 100%)" }, { name: "primary", value: "hsl(173 77% 26%)" }, { name: "brand", value: "#b45309" }]);
  expect(found.fonts).toEqual(["Inter", "Fraunces"]);
  expect(found.corners).toEqual(["0.5rem"]);
});

test("colours are read as hue, saturation and lightness; greys, whites and blacks have no hue of their own", () => {
  expect(Math.round(colorHSL("#0f766e")!.h)).toBe(175);
  expect(Math.round(colorHSL("rgb(124, 58, 237)")!.h)).toBe(262);
  expect(colorHSL("hsl(173 77% 26%)")).toEqual({ h: 173, s: 0.77, l: 0.26 });
  expect(colorHSL("not a colour")).toBeNull();
  expect(chromatic("#0f766e")).toBe(true);
  expect(chromatic("#fbfaf7")).toBe(false);
  expect(chromatic("#1c2422")).toBe(false);
  expect(chromatic("#888")).toBe(false);
  expect(firstFont("var(--font-sans), 'Inter', sans-serif")).toBe("Inter");
  expect(firstFont("system-ui, sans-serif")).toBe("");
});

test("the look is read from the project: files it came from, colours with a hue first, components by name", () => {
  const root = project({ "tailwind.config.ts": TAILWIND, "src/app/globals.css": ":root { --ring: #0f766e; --muted: #e7e2d6; }",
    "src/components/ui/button.tsx": "", "src/components/DayPicker.tsx": "", "src/components/slot-pill.tsx": "", "src/components/DayPicker.test.tsx": "", "components.json": "{}" });
  const look = loadProjectLook(root, 1)!;
  expect(look.from).toEqual(["tailwind.config.ts", "src/app/globals.css"]);
  expect(look.colors.map((one) => one.name)).toEqual(["primary", "primary-600", "warn", "paper", "ink", "muted"]);
  expect(look.fonts).toEqual(["Georgia", "Inter"]);
  expect(look.components).toEqual(["DayPicker", "SlotPill", "Button"]);
  expect(look.componentCount).toBe(3);
  expect(look.kit).toBe("shadcn/ui");
  const block = projectLookBlock(look);
  expect(block).toContain("read from its code (tailwind.config.ts, src/app/globals.css)");
  expect(block).toContain("Colours: primary #0f766e, primary-600 #0d5f59, warn #b45309");
  expect(block).toContain("Fonts: Georgia, Inter");
  expect(block).toContain("Components (3): DayPicker, SlotPill, Button");
  expect(designGuideBlock([], undefined, look).endsWith(block)).toBe(true);
  expect(designGuideBlock([])).not.toContain("own look");
  // A project whose code names no colours and no type has no look.
  expect(loadProjectLook(project({ "README.md": "# Hi", "src/components/Card.tsx": "" }), 1)).toBeNull();
  expect(loadProjectLook(undefined)).toBeNull();
});

test("a page is off the look when a colour is far from every hue of the palette, or a font isn't the project's", () => {
  const look = loadProjectLook(project({ "tailwind.config.ts": TAILWIND }), 1)!;
  const on = `<style>:root{--accent:#0f766e;--paper:#fbfaf7} h1{font:600 24px/1.2 Georgia, serif;color:#115e59} p{font-family:Inter,system-ui;color:#555} .warn{color:#c2410c} code{font-family:"JetBrains Mono",monospace}</style>`;
  expect(offLook(on, look)).toEqual([]);
  const off = `<style>:root{--accent:#7c3aed} h1{font-family:"Poppins",sans-serif;color:rgb(124,58,237)} .b{background:#7C3AED}</style><script>const c="#ff00ff"</script>`;
  expect(offLook(off, look)).toEqual([{ what: "colour", value: "#7c3aed" }, { what: "colour", value: "rgb(124,58,237)" }, { what: "font", value: "Poppins" }]);
  expect(nearest("#7c3aed", look)).toEqual({ name: "primary", value: "#0f766e" });
  // A palette with no hue of its own judges no colour.
  const grey = loadProjectLook(project({ "styles/tokens.css": ":root{--ink:#111;--paper:#fff}" }), 1)!;
  expect(offLook(off.replace(/font-family:"Poppins",sans-serif;/, ""), grey)).toEqual([]);
});

const WALK = [{ what: "A page for a test.", parts: [{ name: "Heading", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the test." }];
const W = { direction: "Calm, for patients booking a visit.", look_at: "The Book button.", starts_from: "new", walkthrough: WALK };
const page = (accent: string, font: string) => `<!doctype html><html><head><style>:root{--accent:${accent}} h1{font-family:${font}}</style></head><body><main><h1>Book a visit</h1></main></body></html>`;

test("a mockup off the project's look goes back once with what to use, and the version says how it sits with the look", async () => {
  const store = new DemesneStore(":memory:"), root = project({ "tailwind.config.ts": TAILWIND });
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const { session } = store.createSession("Harbor Clinic", root);
    const turn = (ask: string) => { const { turn: made } = store.createTurn(session.id, ask); store.startTurn(made.id); return { workspaceRoot: root, signal, sessionId: session.id, turnId: made.id }; };
    const why = (id: string) => { const found = store.getFoundryArtifact(id)!; return found.versions.find((item) => item.version === found.version)!.why!; };

    // Off the look: sent back once, with the nearest colour of the palette and the project's fonts.
    const t1 = turn("A booking page");
    const input = { kind: "html", title: "Booking page", description: "Pick a time in two taps.", source: page("#7c3aed", '"Poppins", sans-serif'), why: W };
    await expect(save.execute(input, t1)).rejects.toThrow(/\[look\][\s\S]*read from tailwind\.config\.ts[\s\S]*colour #7c3aed is far from every colour of its palette \(nearest: primary #0f766e\)[\s\S]*font Poppins is not one of the project's \(Georgia, Inter\)/);
    const fixed = JSON.parse(await save.execute({ ...input, source: page("#0f766e", "Georgia, serif") }, t1));
    expect(why(fixed.id).onLook).toBe("Checked against tailwind.config.ts: 2 things fixed before you saw it");
    store.completeTurn(t1.turnId);

    // On the look from the start: it says so, and nothing is asked.
    const t2 = turn("A page for the confirmation");
    const direct = JSON.parse(await save.execute({ ...input, title: "Confirm page", source: page("#0d5f59", "Inter, system-ui") }, t2));
    expect(why(direct.id).onLook).toBe("Drawn in the project's own look, read from tailwind.config.ts");
    store.completeTurn(t2.turnId);

    // An ask for a new look: saved as it is the second time, and the line says it was on purpose.
    const t3 = turn("Try the booking page in purple");
    const purple = { id: fixed.id, base_version: fixed.version, source: page("#7c3aed", "Georgia, serif"), note: "Purple", why: W };
    await expect(save.execute(purple, t3)).rejects.toThrow("[look]");
    const kept = JSON.parse(await save.execute(purple, t3));
    expect(why(kept.id).onLook).toBe("1 thing off the project's look, kept on purpose");
    // A fix of that version by edit keeps its walkthrough and says where it stands now.
    await edit.execute({ id: kept.id, base_version: kept.version, edits: [{ find: "#7c3aed", replace: "#0f766e" }], critique: "Back to the clinic's teal." }, t3);
    expect(why(kept.id).onLook).toBe("Checked against tailwind.config.ts: 1 thing fixed before you saw it");
    expect(why(kept.id).walk).toHaveLength(1);
    store.completeTurn(t3.turnId);

    // A project with no look of its own: nothing is checked and no line is added.
    const bare = project({ "README.md": "# Hi" });
    const other = store.createSession("Other", bare).session;
    const made = store.createTurn(other.id, "A page"); store.startTurn(made.turn.id);
    const plain = JSON.parse(await save.execute({ ...input, title: "Plain page" }, { workspaceRoot: bare, signal, sessionId: other.id, turnId: made.turn.id }));
    expect(why(plain.id).onLook).toBeUndefined();
  } finally { store.close(); }
});
