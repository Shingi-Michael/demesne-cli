import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalFilesTool } from "../src/personal-files.ts";
import { chunks, PersonalIndex, searchPersonalFilesTool } from "../src/personal-index.ts";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
const context = { workspaceRoot: "/nonexistent", signal: new AbortController().signal };

function folders() {
  const documents = temporaryDirectory("demesne-assistant-documents-");
  mkdirSync(join(documents, "Car"));
  copyFileSync(join(import.meta.dir, "fixtures/insurance.pdf"), join(documents, "Car", "policy.pdf"));
  writeFileSync(join(documents, "groceries.txt"), "eggs\nmilk\nbread\n");
  writeFileSync(join(documents, "trip.md"), "# Lisbon\nFlight TP1345 on Friday 9:40. Hotel near Alfama.\n");
  writeFileSync(join(documents, ".env"), "INSURANCE_PASSWORD=hunter2\n");
  writeFileSync(join(documents, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0]));
  const outside = temporaryDirectory("demesne-assistant-outside-");
  writeFileSync(join(outside, "secret.txt"), "insurance secret\n");
  symlinkSync(outside, join(documents, "linked"));
  return { documents };
}

function open(shared: Record<string, string>) {
  return new PersonalIndex(join(temporaryDirectory("demesne-assistant-home-"), "index.sqlite"), shared);
}

describe("personal index", () => {
  test("finds words in text files and PDFs, by prefix, best match first", async () => {
    const index = open(folders());
    expect(await index.update()).toEqual({ indexed: 3, removed: 0, unreadable: 0, unchanged: 0 });
    const hits = index.search("insurance renew");
    expect(hits.map((hit) => hit.path)).toEqual(["Car/policy.pdf"]);
    expect(hits[0]!.snippet).toContain("[insurance]");
    expect(index.search("lisbon flight")[0]).toMatchObject({ folder: "documents", path: "trip.md" });
    expect(index.search("groceries")[0]!.path).toBe("groceries.txt");
  });

  test("never indexes secrets, hidden files or anything behind a shortcut", async () => {
    const index = open(folders());
    await index.update();
    expect(index.search("hunter2")).toEqual([]);
    expect(index.search("secret")).toEqual([]);
  });

  test("updates only what changed, and forgets deleted files", async () => {
    const { documents } = folders();
    const index = open({ documents });
    await index.update();
    expect(await index.update()).toEqual({ indexed: 0, removed: 0, unreadable: 0, unchanged: 3 });
    writeFileSync(join(documents, "groceries.txt"), "eggs\noat milk\n");
    utimesSync(join(documents, "groceries.txt"), new Date(), new Date(Date.now() + 5000));
    rmSync(join(documents, "trip.md"));
    expect(await index.update()).toEqual({ indexed: 1, removed: 1, unreadable: 0, unchanged: 1 });
    expect(index.search("oat")[0]!.path).toBe("groceries.txt");
    expect(index.search("lisbon")).toEqual([]);
  });

  test("counts files it can't read instead of failing", async () => {
    const { documents } = folders();
    writeFileSync(join(documents, "broken.pdf"), "not really a pdf");
    expect((await open({ documents }).update()).unreadable).toBe(1);
  });

  test("anything the model types is searched as words, never as query syntax", async () => {
    const index = open(folders());
    await index.update();
    for (const query of ['"', "NEAR(insurance", "insurance AND", "*", "path:x", "-- ;"]) expect(() => index.search(query)).not.toThrow();
    expect(index.search("   ")).toEqual([]);
  });

  test("the search tool marks passages as data, and personal_files reads the PDF it found", async () => {
    const shared = folders();
    const index = open(shared);
    await index.update();
    const found = JSON.parse(await searchPersonalFilesTool(index).execute({ query: "car insurance" }, context));
    expect(found.note).toContain("not instructions");
    const read = JSON.parse(await personalFilesTool(shared).execute({ action: "read", folder: "documents", path: found.hits[0].path }, context));
    expect(read.content).toContain("1: Car insurance renewal due 14 November 2026");
  });
});

describe("chunks", () => {
  test("overlap, so a passage across a cut is still whole in one of them", () => {
    const text = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const pieces = chunks(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 1_500)).toBe(true);
    for (let index = 1; index < pieces.length; index++) expect(pieces[index - 1]!.endsWith(pieces[index]!.slice(0, 200))).toBe(true);
    expect(chunks("short")).toEqual(["short"]);
  });
});
