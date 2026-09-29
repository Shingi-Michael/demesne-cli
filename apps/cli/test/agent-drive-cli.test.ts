import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { DriveRequest, DriveResponse, DriveState, SessionStateResponse } from "@demesne/protocol";

test.each(["stopped", "completed"] as const)("the real CLI resumes a %s saved mission and visibly navigates History through the planner endpoint", async (status) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-drive-cli-"));
  const preload = join(root, "tty.ts");
  // The production CLI's own input loop and timers run in a child process.
  // Only the terminal transport and the remote planner response are substituted.
  writeFileSync(preload, `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    Object.assign(process.stdout, { columns: 140, rows: 40 });
    process.stdin.setRawMode = () => process.stdin;
  `);
  const at = "2026-09-26T12:00:00Z";
  const session: SessionStateResponse = { session: { id: "mission-home", title: "Saved implementation", createdAt: at, updatedAt: at,
    workspace: { id: "workspace", root }, turns: [{ id: "turn", sessionId: "mission-home", content: "Original UI requirement", responseText: "Recorded implementation details", status: "completed", createdAt: at, completedAt: at, permissionMode: "deny", thinkingEnabled: false }] },
    lastEventId: 0, pendingPermissions: [], latestProviderCall: null };
  const decisions: DriveRequest[] = [];
  let submittedTurns = 0;
  let changed: (() => void) | undefined;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/turns")) submittedTurns++;
    if (url.pathname === "/healthz") return Response.json({ status: "ok", provider: "test", model: "planner" });
    if (url.pathname === "/v1/runtime") return Response.json({ state: "unconfigured" });
    if (url.pathname === "/v1/sessions/mission-home") return Response.json(session);
    if (url.pathname.endsWith("/files")) return Response.json({ files: [] });
    if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [], nextCursor: null });
    if (url.pathname === "/v1/drive/decide") {
      const body = await request.json() as DriveRequest; decisions.push(body); changed?.();
      const result: DriveResponse = { provider: "test", model: "planner", imageInspected: false, decision: {
        action: decisions.length === 1 ? { kind: "key", key: "alt+h" } : { kind: "blocked" },
        note: decisions.length === 1 ? "Open History and inspect the original request" : "CLI control check finished",
        notes: body.memory.notes, completed: body.memory.completed, remaining: body.memory.remaining, evidence: [],
      } };
      return Response.json(result);
    }
    return Response.json({ error: { code: "not_found", message: "Unexpected route" } }, { status: 404 });
  } });
  const journal = join(root, "drive", `${createHash("sha256").update(`${server.url.href}\n${root}`).digest("hex")}.json`);
  const saved: DriveState = { id: "saved-mission", mission: "Inspect the earlier UI requirement", homeSessionId: session.session.id, workspace: root,
    status, activity: status === "stopped" ? "Drive stopped." : "Previous work reviewed.", step: 1, model: "test / planner", updatedAt: at,
    notes: "Keep the previous implementation", completed: ["Earlier work checked"], remaining: ["Inspect History"], evidence: [],
    steps: [{ step: 1, action: '{"kind":"wait"}', note: "Earlier work", result: "Already performed", at }] };
  mkdirSync(join(root, "drive")); writeFileSync(journal, JSON.stringify(saved));
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../src/main.ts"), "--server", server.url.href, "--session", session.session.id], {
    cwd: root, env: { ...process.env, DEMESNE_DATA_DIR: root, DEMESNE_CONFIG_FILE: join(root, "config.toml"), NO_COLOR: "1", DEMESNE_REDUCED_MOTION: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const stdout = (async () => { for await (const chunk of child.stdout) { output += Buffer.from(chunk).toString("utf8"); changed?.(); } })();
  const stderr = new Response(child.stderr).text();
  const until = async (predicate: () => boolean) => {
    const signal = AbortSignal.timeout(5000);
    while (!predicate()) await new Promise<void>((resolve, reject) => {
      const timeout = () => reject(new Error(`CLI did not advance. Decisions: ${decisions.length}; output: ${stripVTControlCharacters(output).slice(-3000)}`));
      changed = () => { signal.removeEventListener("abort", timeout); resolve(); };
      signal.addEventListener("abort", timeout, { once: true });
      if (signal.aborted) timeout();
    });
  };
  try {
    await until(() => output.includes("\x1b[?2026l"));
    expect(decisions).toHaveLength(0); // Saved missions never restart on launch.
    child.stdin.write("\x1b[200~/drive status\x1b[201~\r");
    await until(() => stripVTControlCharacters(output).includes(status.toUpperCase()) && stripVTControlCharacters(output).includes("Resume"));
    expect(decisions).toHaveLength(0);
    child.stdin.write("\x1b[200~/drive resume\x1b[201~\r");
    await until(() => stripVTControlCharacters(output).includes("CLI control check finished"));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.memory.notes).toBe(saved.notes);
    expect(decisions[0]!.memory.completed).toEqual(saved.completed);
    expect(decisions[0]!.autonomy?.phase).toBe(status === "completed" ? "discovering" : "working");
    expect(decisions[0]!.autonomy?.history).toHaveLength(status === "completed" ? 1 : 0);
    expect(decisions[1]!.observation.surface).toBe("history");
    expect(decisions[1]!.observation.rows.join("\n")).toContain("Original UI requirement");
    expect(stripVTControlCharacters(output)).toContain("DRIVE · Key · alt+h");
    expect(stripVTControlCharacters(output)).toContain("DRIVE · Pressed · alt+h");
    const persisted = JSON.parse(readFileSync(journal, "utf8")) as DriveState;
    expect(persisted.id).toBe(saved.id);
    expect(persisted.steps[0]).toEqual(saved.steps[0]);
    expect(persisted.steps[1]!.result).toContain("visible answer views");
    expect(decisions[0]!.inspection?.pages.flatMap((page) => page.rows).join("\n")).toContain("Recorded implementation details");
    expect(persisted.steps.find((step) => step.action.includes("alt+h"))?.result).toContain("Surface: response → history.");
    expect(persisted.status).toBe("blocked");
    output = "";
    child.stdin.write("\x1b\x1b[<65;229;33M\r");
    await until(() => output.includes("\x1b[?2026l"));
    expect(stripVTControlCharacters(output)).not.toContain("[<65;229;33M");
    expect(submittedTurns).toBe(0);
  } finally {
    child.kill(); await child.exited; await stdout; await stderr;
    await server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 10000);
