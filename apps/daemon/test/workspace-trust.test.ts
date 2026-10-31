import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp } from "../src/app.ts";
import { WorkspaceTrust } from "../src/workspace-trust.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-trust-")));
  directories.push(root);
  return root;
}

test("trusting a folder covers its subfolders but not siblings, and is stored privately", () => {
  const root = scratch(), path = join(root, "data", "trusted-workspaces.json");
  const trust = new WorkspaceTrust(path);
  expect(trust.isTrusted(join(root, "project"))).toBe(false);
  trust.trust(join(root, "project"));
  trust.trust(join(root, "project"));
  expect(trust.isTrusted(join(root, "project"))).toBe(true);
  expect(trust.isTrusted(join(root, "project", "src"))).toBe(true);
  expect(trust.isTrusted(join(root, "project-other"))).toBe(false);
  expect(trust.isTrusted(root)).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new WorkspaceTrust(path).isTrusted(join(root, "project"))).toBe(true);
});

test("sessions in an untrusted folder are refused until the user trusts it", async () => {
  const root = scratch(), workspace = join(root, "project");
  mkdirSync(workspace, { mode: 0o775 });
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite") });
  const create = (body: Record<string, unknown>) => app.fetch(new Request("http://localhost/v1/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    const refused = await create({ title: "First", workspacePath: workspace });
    expect(refused.status).toBe(403);
    const body = await refused.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("workspace_untrusted");
    expect(body.error.message).toContain(workspace);
    expect((await create({ title: "Trusted", workspacePath: workspace, trustWorkspace: true })).status).toBe(201);
    expect((await create({ title: "Again", workspacePath: workspace })).status).toBe(201);
    expect((await create({ title: "Bad", workspacePath: workspace, trustWorkspace: "yes" })).status).toBe(400);
    expect((await create({ title: "No workspace" })).status).toBe(201);
  } finally {
    await app.close();
  }
});

test("Settings lists the trusted folders, without Drive's worktrees, and can take one back", async () => {
  const root = scratch(), workspace = join(root, "project"), worktrees = join(root, ".demesne-worktrees");
  mkdirSync(workspace);
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), worktreeRoot: worktrees });
  const trust = new WorkspaceTrust(join(root, "data", "trusted-workspaces.json"));
  trust.trust(workspace);
  trust.trust(join(worktrees, "fix-1"));
  try {
    // Like a Mac after weeks of Drive: worktrees made elsewhere and folders that are gone stay trusted but unlisted.
    const elsewhere = join(root, "other", ".demesne-worktrees", "fix-2");
    mkdirSync(elsewhere, { recursive: true });
    trust.trust(elsewhere);
    for (let i = 0; i < 20; i++) trust.trust(join(root, `gone-${i}`));
    const listed = await (await app.fetch(new Request("http://localhost/v1/trusted"))).json() as { trusted: string[] };
    expect(listed.trusted).toEqual([workspace]);
    expect(trust.isTrusted(elsewhere)).toBe(true);
    const forget = await app.fetch(new Request("http://localhost/v1/trusted/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: workspace }) }));
    expect(((await forget.json()) as { trusted: string[] }).trusted).toEqual([]);
    expect(trust.isTrusted(workspace)).toBe(false);
    expect((await app.fetch(new Request("http://localhost/v1/trusted/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: "relative" }) }))).status).toBe(400);
  } finally {
    await app.close();
  }
});
