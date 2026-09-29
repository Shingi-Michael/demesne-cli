import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { SessionStateResponse } from "@demesne/protocol";

test("the real CLI starts and resumes offline history while slow file/artifact discovery hydrates independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-startup-"));
  const preload = join(root, "tty.ts");
  // Exercise production startup and input routing with deterministic pipe-backed
  // TTYs, without requiring a platform-specific external terminal emulator.
  writeFileSync(preload, `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.assign(process.stdout, { columns: 100, rows: 32 });
    process.stdin.setRawMode = () => process.stdin;
  `);
  const at = "2026-09-21T12:00:00Z";
  const state = (id: string): SessionStateResponse => ({
    session: { id, title: id === "start" ? "Empty session" : "Restored session", createdAt: at, updatedAt: at,
      workspace: null, turns: id === "start" ? [] : [{ id: "turn", sessionId: id, content: "Original request", responseText: "Saved answer intact",
        status: "completed", createdAt: at, completedAt: at, permissionMode: "deny", thinkingEnabled: false }] },
    lastEventId: id === "start" ? 0 : 1, pendingPermissions: [],
    latestProviderCall: id === "start" ? null : { provider: "offline-provider", model: "historical-model", contextPlan: null, metrics: null, usage: null },
  });
  const requests: string[] = [];
  const files = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>();
  const held = Promise.withResolvers<Response>();
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === "/healthz") return Response.json({ status: "ok", provider: "configured-provider", model: "configured-model", contextCapacity: 262144 });
    if (url.pathname === "/v1/runtime") return Response.json({ state: "unconfigured" });
    if (url.pathname.endsWith("/replay")) return Response.json({ error: { code: "not_found", message: "Older daemon" } }, { status: 404 });
    if (url.pathname === "/v1/sessions") return Response.json({ sessions: [] });
    if (url.pathname.endsWith("/files")) {
      const deferred = Promise.withResolvers<Response>();
      files.set(url.pathname, deferred);
      return deferred.promise;
    }
    // These requests never complete until the test releases them. Startup and
    // resume must finish first, rather than just having a shorter timeout.
    if (url.pathname === "/v1/models" || url.pathname.endsWith("/artifacts")) return (await held.promise).clone();
    if (url.pathname === "/v1/events") return new Response(`data: ${JSON.stringify({ schemaVersion: 1, eventId: 1, sessionId: "saved", turnId: "turn",
      workspaceId: null, agentRunId: null, occurredAt: at, type: "turn.completed", payload: {} })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return Response.json(state(url.pathname.split("/").at(-1)!));
  } });
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../src/main.ts"), "--server", server.url.href, "--session", "start"], {
    cwd: root,
    env: { ...process.env, DEMESNE_DATA_DIR: root, DEMESNE_CONFIG_FILE: join(root, "config.toml"), NO_COLOR: "1", DEMESNE_REDUCED_MOTION: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  let changed: (() => void) | undefined;
  const stdout = (async () => {
    for await (const chunk of child.stdout) { output += Buffer.from(chunk).toString("utf8"); changed?.(); }
  })();
  const stderr = new Response(child.stderr).text();
  const until = async (predicate: () => boolean) => {
    const deadline = AbortSignal.timeout(3000);
    while (!predicate()) {
      await new Promise<void>((resolve, reject) => {
        const timeout = () => reject(new Error(`CLI did not become ready; requests: ${requests.join(", ")}`));
        changed = () => { deadline.removeEventListener("abort", timeout); resolve(); };
        deadline.addEventListener("abort", timeout, { once: true });
        if (deadline.aborted) timeout();
      });
    }
  };
  try {
    await until(() => output.includes("\x1b[?2026l"));
    expect(stripVTControlCharacters(output)).toContain("262.1k");
    expect(requests).not.toContain("/v1/models");
    output = "";
    child.stdin.write("\x1b[200~/resume saved\x1b[201~\r");
    await until(() => stripVTControlCharacters(output).includes("Switched to Restored session"));
    expect(stripVTControlCharacters(output)).toContain("Saved answer intact");
    expect(requests).not.toContain("/v1/models");
    output = "";
    child.stdin.write("@");
    files.get("/v1/sessions/saved/files")!.resolve(Response.json({ files: ["saved-only.ts"] }));
    files.get("/v1/sessions/start/files")!.resolve(Response.json({ files: ["wrong-workspace.ts"] }));
    await until(() => stripVTControlCharacters(output).includes("@saved-only.ts"));
    expect(stripVTControlCharacters(output)).not.toContain("wrong-workspace.ts");
  } finally {
    held.resolve(Response.json({ models: [], artifacts: [], nextCursor: null }));
    for (const deferred of files.values()) deferred.resolve(Response.json({ files: [] }));
    child.kill();
    await child.exited;
    await stdout;
    await stderr;
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
