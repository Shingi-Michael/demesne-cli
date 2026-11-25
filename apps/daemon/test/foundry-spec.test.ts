/// Piece 7 of pass 274: a measured hand-off, read with foundry_read {spec: true}.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { foundryReadTool } from "../src/foundry.ts";
import type { FoundryLook } from "../src/foundry-look.ts";
import { specReport, tokenFor } from "../src/foundry-spec.ts";

const look = { from: ["src/tokens.css"], colors: [{ name: "--brand", value: "#0b6e4f" }, { name: "--ink", value: "#1a1f1c" }, { name: "--paper", value: "#f6f4ee" }], fonts: ["Inter"], corners: ["10px"], components: ["Button", "SlotPicker"], componentCount: 2 };

const measured = {
  page: { width: 1280, height: 1400, background: "#f6f4ee", color: "#1a1f1c", font: "16px/24px Inter" },
  colours: [{ value: "#f6f4ee", uses: ["ground"], share: 1 }, { value: "#0b6e4f", uses: ["button", "text"], share: 0.02 }, { value: "#c2410c", uses: ["text"], share: 0.01 }],
  type: [{ font: "Inter", size: "16px", weight: "400", line: "24px", sample: "Pick a time that suits you", chars: 420 }, { font: "Inter", size: "40px", weight: "700", line: "44px", sample: "Book a visit", chars: 12 }],
  spacing: [4, 8, 16, 24], radii: ["10px", "999px"],
  parts: [{ name: "Book button", tag: "button", text: "Book the visit", x: 96, y: 620, width: 180, height: 44, font: "600 16px/24px Inter", color: "#ffffff", background: "#0b6e4f", padding: "10px 20px", radius: "10px", border: "", gap: "", layout: "" },
    { name: "Clinic picker", tag: "div", text: "", x: 96, y: 200, width: 400, height: 56, font: "400 16px Inter", color: "#1a1f1c", background: "none, on #f6f4ee", padding: "", radius: "", border: "1px #1a1f1c at 20%", gap: "8px", layout: "flex row" },
    { name: "Gone", missing: true }],
  words: ["Book a visit", "Pick a time that suits you", "Book the visit"],
  motion: [{ on: 'button.book "Book the visit"', what: "background-color", duration: "160ms", easing: "ease-out", delay: "0ms" }, { on: ".sheet", what: "animation", name: "rise", duration: "240ms", easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", delay: "40ms", frames: "0% transform: translateY(100%) → 100% transform: none" },
    { on: 'div.sheet "Booked"', what: "animation", name: "rise", duration: "240ms", easing: "cubic-bezier(.2,.8,.2,1)", delay: "0ms", frames: "from transform: translateY(100%) → at rest", when: "each time it appears" }],
};

test("a measured colour is named by the project's token when one matches", () => {
  expect(tokenFor("#0b6e4f", look)).toBe("= --brand");
  expect(tokenFor("#0B6E4F", look)).toBe("= --brand");
  expect(tokenFor("#0d7052", look)).toBe("≈ --brand");
  expect(tokenFor("#1a1f1c at 20%", look)).toBe("= --ink");
  expect(tokenFor("#c2410c", look)).toBe("");
  expect(tokenFor("#ffffff", look)).toBe("");
  expect(tokenFor("#0b6e4f", null)).toBe("");
});

test("the spec reads as short lines: numbers first, tokens named, missing parts said", () => {
  const spec = specReport(measured, look)!;
  expect(spec.page).toBe("1280×1400, ground #f6f4ee (= --paper), text #1a1f1c (= --ink), 16px/24px Inter");
  expect(spec.colours).toEqual(["#f6f4ee (= --paper): ground", "#0b6e4f (= --brand): button, text", "#c2410c: text"]);
  expect((spec.type as string[])[1]).toBe("Inter 40px, weight 700, line 44px: “Book a visit”");
  expect(spec.spacing).toBe("4, 8, 16, 24 px");
  expect(spec.corners).toBe("10px, 999px");
  const [button, picker, gone] = spec.parts as Record<string, string>[];
  expect(button).toEqual({ name: "Book button", is: "<button> 180×44 at 96,620", words: "Book the visit", type: "600 16px/24px Inter", colour: "#ffffff", ground: "#0b6e4f (= --brand)", padding: "10px 20px", corners: "10px" });
  expect(picker).toMatchObject({ ground: "none, on #f6f4ee (= --paper)", line: "1px #1a1f1c at 20%", gap: "8px", layout: "flex row" });
  expect(gone!.missing).toMatch(/matched nothing/);
  expect(spec.motion).toEqual(['button.book "Book the visit": background-color, 160ms, ease-out', ".sheet: animation rise (0% transform: translateY(100%) → 100% transform: none), 240ms, cubic-bezier(0.2, 0.8, 0.2, 1), after 40ms",
    'div.sheet "Booked": animation rise (from transform: translateY(100%) → at rest), 240ms, cubic-bezier(.2,.8,.2,1), each time it appears']);
  expect(specReport({ ...measured, places: [{ name: "Booked", words: ["See you Tuesday"] }, { name: "Empty", words: [] }] }, look)!.other_places).toEqual([{ name: "Booked", words: ["See you Tuesday"] }]);
  expect(specReport(null, look)).toBeNull();
  expect(specReport({ page: measured.page }, null)).toEqual({ page: "1280×1400, ground #f6f4ee, text #1a1f1c, 16px/24px Inter" });
});

const part = (name: string, at: string) => ({ name, says: `${name} does its job.`, at });
const PAGE = `<script src="foundry://kit/parts.js"></script><d-compare recommended="Day first"><section data-option="Day first"><button class="book">Book</button><div class="slots">9:00</div></section><section data-option="Clinic first"><button class="book">Book</button><div class="slots">9:00</div></section></d-compare>`;

test("foundry_read {spec: true} draws the option, measures its walkthrough's parts and names the project's parts", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-spec-"));
  const store = new DemesneStore(":memory:");
  try {
    mkdirSync(join(root, "src/components"), { recursive: true });
    writeFileSync(join(root, "src/tokens.css"), ":root{--brand:#0b6e4f;--ink:#1a1f1c;--paper:#f6f4ee;font-family:Inter,sans-serif}");
    writeFileSync(join(root, "src/components/SlotPicker.tsx"), "export const SlotPicker = () => null;");
    const asked: Parameters<FoundryLook>[0][] = [];
    const draws: FoundryLook = async (page) => { asked.push(page); return { pages: [{ width: 1280, height: 1400, issues: [], png: "", spec: measured }], errors: [] }; };
    const { session } = store.createSession("Harbor Clinic", root);
    const { turn } = store.createTurn(session.id, "build Clinic first");
    const context = { workspaceRoot: root, signal: new AbortController().signal, sessionId: session.id, turnId: turn.id } as never;
    const walk = ["Day first", "Clinic first"].map((option) => ({ option, what: `${option}, for patients.`, parts: [part(`${option} button`, ".book"), part("Slots", ".slots")], why: "w", differs: "d" }));
    const mockup = store.saveFoundryArtifact({ kind: "html", title: "Booking", source: PAGE, sessionId: session.id, turnId: turn.id, description: "Two ways to book.", why: { direction: "Calm.", look: "The slots.", dropped: "", walk } });
    const tool = foundryReadTool(store, draws);

    // Which option? It has two.
    await expect(tool.execute({ id: mockup.id, spec: true }, context)).rejects.toThrow(/\[spec_option\].*"Day first", "Clinic first"/);
    const read = JSON.parse(await tool.execute({ id: mockup.id, spec: true, option: "Clinic" }, context) as string);
    expect(asked.at(-1)).toMatchObject({ option: 1, spec: { parts: [{ name: "Clinic first button", at: ".book" }, { name: "Slots", at: ".slots" }] } });
    expect(read).toMatchObject({ id: mockup.id, option: "Clinic first", version: 1 });
    expect(read.spec.colours[1]).toBe("#0b6e4f (= brand): button, text");
    expect(read.project.components).toContain("SlotPicker");
    expect(read.project.rule).toMatch(/own components/);
    expect(read.how).toMatch(/token[\s\S]*foundry_built/);
    expect(read.source).toBeUndefined();

    // A plain read says to read the spec before building.
    expect(JSON.parse(await tool.execute({ id: mockup.id }, context) as string).if_you_build_it).toMatch(/spec: true[\s\S]*foundry_built/);
    // Nothing to draw with, or nothing measured: said plainly, with the way on.
    await expect(foundryReadTool(store).execute({ id: mockup.id, spec: true, option: "Day first" }, context)).rejects.toThrow(/\[no_spec\].*source/);
    await expect(foundryReadTool(store, async () => null).execute({ id: mockup.id, spec: true, option: "Day first" }, context)).rejects.toThrow(/\[no_spec\]/);
    const doc = store.saveFoundryArtifact({ kind: "markdown", title: "Notes", source: "# Notes", sessionId: session.id, turnId: turn.id });
    await expect(tool.execute({ id: doc.id, spec: true }, context)).rejects.toThrow(/\[no_spec\].*markdown/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
