import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp } from "../src/app.ts";
import { WorkspaceTrust } from "../src/workspace-trust.ts";
import { listSourceDocuments, sourceDocumentResponse } from "../src/source-documents.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-documents-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project"), shared = join(root, "shared");
  mkdirSync(workspace); mkdirSync(shared);
  const databasePath = join(root, "data", "state.sqlite");
  const store = new DemesneStore(databasePath); cleanup.push(() => store.close());
  const { session } = store.createSession("Sources", workspace);
  const { turn } = store.createTurn(session.id, "Review the document"); store.startTurn(turn.id);
  const { providerCallId } = store.startProviderCall(turn.id, "fixture", "fixture");
  const context = { store, folders: { documents: shared } as Record<string, string>, trusted: (path: string) => path === workspace };
  function record(name: string, input: unknown, result: unknown, status: "completed" | "failed" | "denied" = "completed") {
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, crypto.randomUUID(), name, JSON.stringify(input));
    store.settleToolCall(toolCallId, status, JSON.stringify(result));
  }
  const list = () => listSourceDocuments(context, session.id, turn.id);
  const download = (id: string, revision: string | null) => sourceDocumentResponse(context, session.id, turn.id, id, revision);
  return { root, workspace, shared, databasePath, context, session, turn, store, record, list, download };
}

test("sources come only from completed verified reads, including successful members of a partial batch", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "guide.md"), "Guide"); writeFileSync(join(f.workspace, "other.txt"), "Other");
  f.record("read_file", { path: "guide.md" }, { path: "guide.md", content: "Guide" });
  f.record("read_file", { path: "guide.md" }, { path: "guide.md", content: "Guide" });
  f.record("read_files", { files: [{ path: "other.txt" }, { path: "missing.txt" }, { path: "never.txt" }] },
    { results: [{ path: "other.txt", content: "Other" }, { path: "missing.txt", error: "missing" }] });
  f.record("read_file", { path: "denied.txt" }, {}, "denied");
  f.record("read_file", { path: "failed.txt" }, {}, "failed");
  f.record("read_file", { path: "invented.txt" }, { path: "different.txt" });
  f.record("run_command", { path: "shell.txt" }, { path: "shell.txt" });
  expect(f.list().map(item => item.filename)).toEqual(["guide.md", "other.txt"]);
  const first = f.list()[0]!;
  expect(first.byteLength).toBe(5); expect(first.mimeType).toBe("text/plain");
  const response = f.download(first.id, first.revision);
  expect(response.status).toBe(200); expect(await response.text()).toBe("Guide");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("personal PDF sources retain scope, report missing files and recheck revoked sharing", async () => {
  const f = fixture(), path = join(f.shared, "renewal.pdf");
  const content = "%PDF-1.4\nFixture PDF bytes"; writeFileSync(path, content);
  f.record("personal_files", { action: "read", folder: "documents", path: "renewal.pdf" }, { path: "renewal.pdf", content: "renewal" });
  f.record("personal_files", { action: "list", folder: "documents" }, { path: "renewal.pdf" });
  const source = f.list()[0]!;
  expect(source.path).toBe("documents/renewal.pdf"); expect(source.mimeType).toBe("application/pdf");
  expect(await f.download(source.id, source.revision).text()).toBe(content);
  delete f.context.folders.documents;
  expect(f.download(source.id, source.revision).status).toBe(403);
  f.context.folders.documents = f.shared; rmSync(path);
  expect(f.list()[0]!.issue).toBe("missing"); expect(f.download(source.id, source.revision).status).toBe(404);
});

test("traversal, private paths, symlinks, hard links and revoked workspace trust never serve bytes", () => {
  const f = fixture();
  writeFileSync(join(f.workspace, "safe.txt"), "Safe"); writeFileSync(join(f.workspace, ".env"), "secret");
  symlinkSync(join(f.workspace, "safe.txt"), join(f.workspace, "link.txt"));
  linkSync(join(f.workspace, "safe.txt"), join(f.workspace, "hard.txt"));
  for (const path of ["../outside.txt", ".env", "link.txt", "hard.txt", "safe.txt", "/absolute.txt"]) {
    f.record("read_file", { path }, { path, content: "recorded" });
  }
  for (const source of f.list()) {
    expect(source.issue).not.toBeNull(); expect(f.download(source.id, source.revision).status).not.toBe(200);
  }
  writeFileSync(join(f.workspace, "regular.txt"), "Regular"); f.record("read_file", { path: "regular.txt" }, { path: "regular.txt" });
  const regular = f.list().find(source => source.filename === "regular.txt")!;
  f.context.trusted = () => false;
  expect(f.download(regular.id, regular.revision).status).toBe(403);
});

test("size, type and revision checks bound downloads and reject stale metadata", () => {
  const f = fixture(), path = join(f.workspace, "file.txt"); writeFileSync(path, "one");
  f.record("read_file", { path: "file.txt" }, { path: "file.txt" });
  const first = f.list()[0]!;
  expect(f.download(first.id, null).status).toBe(409);
  writeFileSync(path, "a changed document"); expect(f.download(first.id, first.revision).status).toBe(409);
  writeFileSync(path, Buffer.from([0, 1, 2])); let source = f.list()[0]!; expect(f.download(source.id, source.revision).status).toBe(415);
  writeFileSync(path, Buffer.from([0xFF])); source = f.list()[0]!; expect(f.download(source.id, source.revision).status).toBe(415);
  truncateSync(path, 2 * 1024 * 1024 + 1); source = f.list()[0]!;
  expect(source.issue).toBe("too_large"); expect(f.download(source.id, source.revision).status).toBe(413);
  expect(f.download("invented", first.revision).status).toBe(404);
});

test("HTTP endpoints require authentication and the matching session/turn and never take a filesystem path", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "guide.md"), "Readable");
  f.record("read_file", { path: "guide.md" }, { path: "guide.md" });
  new WorkspaceTrust(join(f.root, "data", "trusted-workspaces.json")).trust(f.workspace);
  const app = createDaemonApp({ databasePath: f.databasePath, authToken: "fixture-key" }); cleanup.push(() => app.close());
  const base = `http://localhost/v1/sessions/${f.session.id}/turns/${f.turn.id}/sources`;
  const get = (url: string, auth = true) => app.fetch(new Request(url, { headers: auth ? { authorization: "Bearer fixture-key" } : {} }));
  expect((await get(base, false)).status).toBe(401);
  const response = await get(base); expect(response.status).toBe(200);
  const { documents } = await response.json(); const document = documents[0];
  expect(await (await get(`${base}/${document.id}/content?revision=${document.revision}`)).text()).toBe("Readable");
  const other = f.store.createSession("Other", f.workspace).session;
  expect((await get(base.replace(f.session.id, other.id))).status).toBe(404);
  expect((await get(`${base}/guide.md/content?revision=${document.revision}`)).status).toBe(404);
  const reopened = new DemesneStore(f.databasePath);
  expect(reopened.completedFileReads(f.session.id, f.turn.id)).toHaveLength(1); reopened.close();
});
