/// Step 6: a page made of several files.
import { expect, test } from "bun:test";
import { withFoundryFiles } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";

const W = { direction: "Plain, for a test.", look_at: "The list.", starts_from: "new" };
const PAGE = '<!doctype html><link rel="stylesheet" href="foundry://kit/base.css"><link rel="stylesheet" href="styles.css"><h1>Orders</h1><ul id="list"></ul><script type="application/json" id="data" src="data.json"></script><script src="./app.js"></script>';
const FILES = { "styles.css": "h1{color:#336}", "data.json": '[{"name":"Flat white"}]', "app.js": "for (const o of JSON.parse(data.textContent)) list.append(Object.assign(document.createElement('li'), { textContent: o.name }));" };

test("a page's files go in where it links them; names it doesn't keep stay as written", () => {
  const page = withFoundryFiles(PAGE, FILES);
  expect(page).toContain('<style data-file="styles.css">h1{color:#336}</style>');
  expect(page).toContain('<script type="application/json" id="data" data-file="data.json">[{"name":"Flat white"}]</script>');
  expect(page).toContain('<script data-file="app.js">for (const o');
  expect(page).toContain('<link rel="stylesheet" href="foundry://kit/base.css">');
  expect(withFoundryFiles('<img src="logo.svg"><div style="x"></div><style>.a{background:url(logo.svg)}</style>', { "logo.svg": "<svg/>" }))
    .toBe('<img src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E"><div style="x"></div><style>.a{background:url("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")}</style>');
  // A file can't close its tag early.
  expect(withFoundryFiles('<script src="a.js"></script>', { "a.js": "x = '</script><b>'" })).toBe('<script data-file="a.js">x = \'<\\/script><b>\'</script>');
  expect(withFoundryFiles(PAGE, undefined)).toBe(PAGE);
});

test("a page keeps its files with each version; a save without them keeps the ones before; edits can name a file", async () => {
  const store = new DemesneStore(":memory:");
  try {
    // Each ask its own chat, so each save is a new version.
    const context = () => { const { session } = store.createSession("Files"); return { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: store.createTurn(session.id, "an orders page").turn.id }; };
    const input = { title: "Orders", kind: "html", description: "Orders from a data file.", why: W, source: PAGE };
    await expect(foundrySaveTool(store).execute({ ...input, files: { "../x.css": "" } }, context())).rejects.toThrow("can't be a file of a page");
    await expect(foundrySaveTool(store).execute({ ...input, kind: "doc", source: "# Hi", files: FILES }, context())).rejects.toThrow("Only an html page keeps other files");
    const saved = JSON.parse(await foundrySaveTool(store).execute({ ...input, files: FILES }, context()));
    expect(store.getFoundryArtifact(saved.id)!.files).toEqual(FILES);
    // Read: the files come with the source.
    const read = JSON.parse(await foundryReadTool(store).execute({ id: saved.id }, context()));
    expect(read.files).toEqual(FILES);
    // An edit to a file is a new version with that file changed; the page and the other files stay.
    const edited = JSON.parse(await foundryEditTool(store).execute({ id: saved.id, base_version: 1, edits: [{ file: "styles.css", find: "#336", replace: "#633" }], note: "warmer", why: W }, context()));
    expect(edited.version).toBe(2);
    expect(store.getFoundryArtifact(saved.id)!.files).toEqual({ ...FILES, "styles.css": "h1{color:#633}" });
    expect(store.getFoundryArtifact(saved.id, 1)!.files!["styles.css"]).toBe("h1{color:#336}");
    await expect(foundryEditTool(store).execute({ id: saved.id, base_version: 2, edits: [{ file: "nope.css", find: "a", replace: "b" }], why: W }, context())).rejects.toThrow("its files are styles.css, data.json, app.js");
    // A save without files keeps them; {} drops them.
    await foundrySaveTool(store).execute({ id: saved.id, base_version: 2, source: PAGE.replace("Orders", "Today's orders"), why: W }, context());
    expect(store.getFoundryArtifact(saved.id)!.files).toEqual({ ...FILES, "styles.css": "h1{color:#633}" });
    await foundrySaveTool(store).execute({ id: saved.id, base_version: 3, source: "<!doctype html><h1>Plain</h1>", files: {}, why: W }, context());
    expect(store.getFoundryArtifact(saved.id)!.files).toBeUndefined();
  } finally { store.close(); }
});
