import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProject, parseDiagnostic } from "../src/type-check.ts";
import { ToolRegistry } from "../src/tools.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function project(withTypescript = true) {
  const root = mkdtempSync(join(tmpdir(), "demesne-types-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", skipLibCheck: true, types: [] }, include: ["src"] }));
  if (withTypescript) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(root, "node_modules", "typescript"));
  }
  writeFileSync(join(root, "src", "shape.ts"), "export interface Shape { width: number }\nexport const area = (shape: Shape) => shape.width * 2;\n");
  writeFileSync(join(root, "src", "use.ts"), "import { area } from './shape';\nexport const total = area({ width: 3 });\n");
  return root;
}

const context = (workspaceRoot: string) => ({ workspaceRoot, signal: new AbortController().signal });

describe("type errors with edits", () => {
  test("parses a tsc line", () => {
    expect(parseDiagnostic("src/a.ts(12,5): error TS2339: Property 'x' does not exist on type 'Y'.", "/p")).toEqual({ file: "/p/src/a.ts", text: "12:5 TS2339 Property 'x' does not exist on type 'Y'." });
    expect(parseDiagnostic("Found 2 errors.", "/p")).toBeNull();
  });

  test("finds the project only when TypeScript is installed", () => {
    const bare = project(false);
    expect(findProject(bare, join(bare, "src", "shape.ts"))).toBeNull();
    const ready = project();
    expect(findProject(ready, join(ready, "src", "shape.ts"))?.tsconfig).toBe(join(ready, "tsconfig.json"));
  });

  test("an edit comes back with its errors, then clean, and names what it broke elsewhere", async () => {
    const root = project();
    const edit = new ToolRegistry().get("edit_file")!;
    const broken = JSON.parse(await edit.execute({ path: "src/use.ts", oldText: "area({ width: 3 })", newText: "area({ width: 3 }).nope" }, context(root)));
    expect(broken.types).toHaveLength(1);
    expect(broken.types[0]).toContain("TS2339");
    const fixed = JSON.parse(await edit.execute({ path: "src/use.ts", oldText: ".nope", newText: "" }, context(root)));
    expect(fixed.types).toBe("no errors");
    const renamed = JSON.parse(await edit.execute({ path: "src/shape.ts", oldText: "export const area", newText: "export const surface" }, context(root)));
    expect(renamed.types).toBe("no errors");
    expect(renamed.typesElsewhere?.join("\n")).toContain("src/use.ts:1:");
  }, 60_000);

  test("files outside TypeScript projects carry no type report", async () => {
    const root = project(false);
    const result = JSON.parse(await new ToolRegistry().get("write_file")!.execute({ path: "src/new.ts", content: "export const x: number = 'no';\n" }, context(root)));
    expect(result.types).toBeUndefined();
  });
});
