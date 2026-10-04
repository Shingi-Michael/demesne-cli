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
