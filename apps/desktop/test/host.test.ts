import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../workspace/test/fixture.ts";
import { parseDesktopInput, type DesktopOutput, type DesktopBootstrap } from "../host-protocol.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
type Response = Extract<DesktopOutput, { kind: "response" }>;
class Sidecar {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  messages: DesktopOutput[] = [];
  errors = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(f: Awaited<ReturnType<typeof fixture>>, args: string[] = []) {
    const command = process.env.DEMESNE_TEST_DESKTOP_HOST
      ? [process.env.DEMESNE_TEST_DESKTOP_HOST]
      : [process.execPath, resolve(import.meta.dir, "../host.ts")];
    const server = args.some(argument => argument === "--server" || argument.startsWith("--server=")) ? [] : ["--server", f.server.url.href];
    this.child = Bun.spawn([...command, ...server, ...args], {
      cwd: f.workspace, env: f.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    void this.read();
    void new Response(this.child.stderr).text().then(text => { this.errors = text; });
  }
  private async read() {
    let buffered = "";
    const decoder = new TextDecoder(), reader = this.child.stdout.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        buffered += decoder.decode(result.value, { stream: true });
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as DesktopOutput;
          this.messages.push(message);
          if (message.kind === "response") {
            const pending = this.pending.get(message.id);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message); }
          }
        }
      }
    } finally {
      reader.releaseLock();
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Sidecar exited before response")); }
      this.pending.clear();
    }
  }
  send(value: unknown) { this.child.stdin.write(JSON.stringify(value) + "\n"); }
  raw(text: string) { this.child.stdin.write(text); }
  request(method: string, args: Record<string, unknown> = {}) {
    const id = ++this.sequence;
    const promise = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No response to ${method}; ${this.errors}`)); }, 6000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ kind: "request", id, method, args });
    return promise;
  }
  async value(method: string, args: Record<string, unknown> = {}) {
    const response = await this.request(method, args);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }
  async close() {
    this.child.stdin.end();
    const timeout = setTimeout(() => this.child.kill(), 2000);
    const code = await this.child.exited;
    clearTimeout(timeout);
    return code;
  }
}
const bootstrap = (value: unknown) => value as DesktopBootstrap;

test("saved theme selections survive project opening and OS appearance changes",async()=>{
  const f=await fixture();writeFileSync(f.settings.configPath,'theme = "auto"\n[daemon]\nauto_start = "never"\n');
  await f.client.selectTheme("nord");const sidecar=new Sidecar(f);
  try {
    await sidecar.value("desktop-appearance",{dark:false});
    const opened=bootstrap(await sidecar.value("desktop-open-project",{path:f.workspace}));
    expect(opened.snapshot!.theme).toBe("nord");expect(opened.snapshot!.palette.ink).toBe("#2E3440");
    await sidecar.value("desktop-appearance",{dark:true});
    const latest=await sidecar.value("bootstrap") as {theme:string;palette:{ink:string}};
    expect(latest.theme).toBe("nord");expect(latest.palette.ink).toBe("#2E3440");
  }finally{await sidecar.close();await f.close();}
});

test("desktop sidecar starts without a project and keeps malformed IPC recoverable", async () => {
  const f = await fixture(), sidecar = new Sidecar(f);
  try {
    // No project yet: Home opens anyway, as Just a chat, and no project is kept.
    const booted = bootstrap(await sidecar.value("desktop-bootstrap"));
    expect(booted).toMatchObject({ workspace: null, recentProjects: [] });
    expect(booted.snapshot!.session!.workspace).toBeNull();
    expect(booted.snapshot!.workspace).toBe("");
    expect(typeof booted.userName).toBe("string");
    expect((await f.client.listSessions()).every(session => !session.workspace)).toBe(true);
    sidecar.raw("{broken json\n");
    sidecar.send({ kind: "request", id: 100, method: "submit", args: null });
    sidecar.send({ kind: "request", id: 101, method: "filesystem/path", args: {} });
    await eventually(() => sidecar.messages.some(message => message.kind === "response" && message.id === 101));
    expect(sidecar.messages.some(message => message.kind === "protocol-error")).toBe(true);
    expect(sidecar.messages.find(message => message.kind === "response" && message.id === 100)).toMatchObject({ ok: false });
    expect(bootstrap(await sidecar.value("desktop-bootstrap")).workspace).toBeNull();
    expect(JSON.stringify(sidecar.messages)).not.toContain("graphics-test-token");
  } finally { expect(await sidecar.close()).toBe(0); await f.close(); }
});

test("desktop project selection streams a real fixture daemon turn and replies to quit", async () => {
  const f = await fixture(), sidecar = new Sidecar(f);
  try {
    const selected = bootstrap(await sidecar.value("desktop-open-project", { path: f.workspace }));
    expect(selected.workspace).toBe(f.workspace);
    expect(selected.snapshot?.connection).toBe("online");
    const sessionId = selected.snapshot!.session!.id;
    await sidecar.value("submit", { sessionId, text: "Hello desktop" });
    await eventually(() => sidecar.messages.some(message => message.kind === "update" && JSON.stringify(message).includes("Ready.")));
    await eventually(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "completed");
    expect((await sidecar.value("bootstrap") as { runs: unknown[] }).runs).toHaveLength(1);
    const quit = await sidecar.request("quit");
    expect(quit.ok).toBe(true);
    expect(await sidecar.child.exited).toBe(0);
    expect((await f.client.health()).model).toBe("qwen3.8-27b");
  } finally { await sidecar.close(); await f.close(); }
});

test("desktop native responses correlate out of order and propagate OS errors", async () => {
  const f = await fixture(), sidecar = new Sidecar(f, ["--workspace", f.workspace]);
  try {
    const sessionId = bootstrap(await sidecar.value("desktop-bootstrap")).snapshot!.session!.id;
    let firstSettled = false;
    const first = sidecar.request("copy", { sessionId, text: "First" }).then(response => { firstSettled = true; return response; });
    const second = sidecar.request("copy", { sessionId, text: "Second" });
    await eventually(() => sidecar.messages.filter(message => message.kind === "native").length === 2);
    const native = sidecar.messages.filter((message): message is Extract<DesktopOutput, { kind: "native" }> => message.kind === "native");
    expect(native.map(message => message.args.text)).toEqual(["First", "Second"]);
    sidecar.send({ kind: "native-response", id: native[1]!.id, ok: true, value: null });
    expect((await second).ok).toBe(true);
    expect(firstSettled).toBe(false);
    sidecar.send({ kind: "native-response", id: 99_999, ok: true });
    sidecar.send({ kind: "native-response", id: native[0]!.id, ok: false, error: "Clipboard denied" });
    expect(await first).toMatchObject({ ok: false, error: "Clipboard denied" });
    const opened = sidecar.request("open-link", { sessionId, url: "https://example.com/design" });
    await eventually(() => sidecar.messages.some(message => message.kind === "native" && message.method === "open"));
    const open = nativeFrom(sidecar.messages, "open");
    expect(open.args.path).toBe("https://example.com/design");
    sidecar.send({ kind: "native-response", id: open.id, ok: true });
    expect((await opened).ok).toBe(true);
    expect(await sidecar.request("open-link", { sessionId, url: "javascript:alert(1)" })).toMatchObject({ ok: false, error: "Unsupported link" });
  } finally { expect(await sidecar.close()).toBe(0); await f.close(); }
});
function nativeFrom(messages: DesktopOutput[], method: "copy" | "open") {
  return messages.find((message): message is Extract<DesktopOutput, { kind: "native" }> => message.kind === "native" && message.method === method)!;
}

test("desktop switching preserves drafts, canonicalizes projects, and restores private preferences", async () => {
  const f = await fixture(), other = join(f.root, "other"), alias = join(f.root, "alias");
  mkdirSync(other); symlinkSync(other, alias);
  const sidecar = new Sidecar(f);
  let restored: Sidecar | undefined;
  try {
    const selected = bootstrap(await sidecar.value("desktop-open-project", { path: f.workspace })), sessionId = selected.snapshot!.session!.id;
    await sidecar.value("draft", { sessionId, text: "Please retain this draft" });
    expect(await sidecar.request("desktop-open-project", { path: alias })).toMatchObject({ ok: false, error: "Send or clear your unsent drafts before changing projects" });
    expect(bootstrap(await sidecar.value("desktop-bootstrap")).workspace).toBe(f.workspace);
    await sidecar.value("draft", { sessionId, text: "" });
    const untrusted = bootstrap(await sidecar.value("desktop-open-project", { path: alias }));
    expect(untrusted.workspace).toBe(other);
    expect(untrusted.snapshot!.session).toBeNull();
    expect(untrusted.snapshot!.untrustedWorkspace).toBe(other);
    await sidecar.value("trust-workspace", {});
    const prefsPath = join(f.settings.dataDirectory, "desktop-ui.json");
    expect(statSync(prefsPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(prefsPath, "utf8"))).toMatchObject({ lastWorkspace: other, recentProjects: [other, f.workspace] });
    const selectedOtherSession = bootstrap(await sidecar.value("desktop-bootstrap")).snapshot!.session!.id;
    const another = await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true });
    const openedChat = bootstrap(await sidecar.value("desktop-open-project", { path: f.workspace, sessionId: another.session.id }));
    expect(openedChat.snapshot!.session!.id).toBe(another.session.id);
    expect(await sidecar.request("desktop-open-project", { path: other, sessionId: another.session.id })).toMatchObject({ ok: false, error: "This conversation is not available in the selected project" });
    expect(bootstrap(await sidecar.value("desktop-bootstrap")).workspace).toBe(f.workspace);
    expect(bootstrap(await sidecar.value("desktop-open-project", { path: other, sessionId: selectedOtherSession })).snapshot!.session!.id).toBe(selectedOtherSession);
    expect(await sidecar.request("desktop-open-project", { path: join(f.root, "missing") })).toMatchObject({ ok: false });
    chmodSync(f.workspace, 0o775);
    const groupWritable = await sidecar.request("desktop-open-project", { path: f.workspace });
    expect(groupWritable.ok).toBe(true);
    expect(statSync(f.workspace).mode & 0o777).toBe(0o775);
    expect(bootstrap(await sidecar.value("desktop-open-project", { path: other })).workspace).toBe(other);
    await sidecar.close();
    restored = new Sidecar(f);
    // Launch lands on Home as Just a chat; the project's last chat is a
    // click away (opening the project brings it back).
    const recovered = bootstrap(await restored.value("desktop-bootstrap"));
    expect(recovered.workspace).toBe(other);
    expect(recovered.snapshot!.session!.workspace).toBeNull();
    expect(recovered.snapshot!.runs).toEqual([]);
    expect(bootstrap(await restored.value("desktop-bootstrap")).recentProjects).toEqual([other, f.workspace]);
  } finally { await sidecar.close(); if (restored) await restored.close(); await f.close(); }
});

test("desktop EOF leaves a running daemon-owned turn alive", async () => {
  const gate = Promise.withResolvers<void>();
  let streaming = false;
  const f = await fixture({ providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    streaming = true;
    yield { type: "text_delta", delta: "Still running." };
    await Promise.race([gate.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    signal.throwIfAborted();
    yield { type: "text_delta", delta: " Completed after desktop closed." };
    yield { type: "finish", reason: "stop" };
  } });
  const sidecar = new Sidecar(f, ["--workspace", f.workspace]);
  try {
    const sessionId = bootstrap(await sidecar.value("desktop-bootstrap")).snapshot!.session!.id;
    await sidecar.value("submit", { sessionId, text: "Keep working after close" });
    await eventually(() => streaming);
    expect(await sidecar.close()).toBe(0);
    expect((await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status).toBe("running");
    gate.resolve();
    await eventually(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "completed");
  } finally { gate.resolve(); await sidecar.close(); await f.close(); }
});

test("desktop auto appearance follows OS changes while explicit themes win", async () => {
  const f = await fixture();
  writeFileSync(f.settings.configPath, 'theme = "auto"\n[daemon]\nauto_start = "never"\n');
  const sidecar = new Sidecar(f);
  try {
    await sidecar.value("desktop-appearance", { dark: false });
    const selected = bootstrap(await sidecar.value("desktop-open-project", { path: f.workspace })), sessionId = selected.snapshot!.session!.id;
    expect(selected.snapshot!.theme).toBe("demesne-light");
    await sidecar.value("desktop-appearance", { dark: true });
    expect((await sidecar.value("bootstrap") as { theme: string }).theme).toBe("demesne");
    await sidecar.value("theme", { sessionId, name: "demesne-light" });
    await sidecar.value("desktop-appearance", { dark: true });
    expect((await sidecar.value("bootstrap") as { theme: string }).theme).toBe("demesne-light");
    expect(await sidecar.request("desktop-appearance", { dark: "false" })).toMatchObject({ ok: false, error: "Invalid desktop appearance" });
  } finally { expect(await sidecar.close()).toBe(0); await f.close(); }
});

test("desktop protocol rejects invalid identifiers, methods, and native replies", () => {
  for (const value of [null, [], { kind: "request", id: 0, method: "bootstrap", args: {} }, { kind: "request", id: 1, method: "__proto__", args: {} }, { kind: "native-response", id: 1, ok: "true" }])
    expect(() => parseDesktopInput(value)).toThrow();
  expect(parseDesktopInput({ kind: "native-response", id: 1, ok: true, value: null })).toMatchObject({ ok: true });
});


test("desktop recovery falls back cleanly after its saved session is archived", async () => {
  const f = await fixture(), first = new Sidecar(f, ["--workspace", f.workspace]);
  let second: Sidecar | undefined;
  try {
    const previous = bootstrap(await first.value("desktop-bootstrap")).snapshot!.session!.id;
    await first.close();
    await f.client.archiveSession(previous);
    second = new Sidecar(f);
    const recovered = bootstrap(await second.value("desktop-bootstrap"));
    expect(recovered.snapshot!.connection).toBe("online");
    expect(recovered.snapshot!.session!.id).not.toBe(previous);
    expect(recovered.workspace).toBe(f.workspace);
  } finally { await first.close(); if (second) await second.close(); await f.close(); }
});

test("closing the window hands a running Drive mission to the background, and reopening takes it back", async () => {
  const f = await fixture(), other = join(f.root, "other");
  mkdirSync(other);
  const sidecar = new Sidecar(f, ["--workspace", f.workspace]);
  let recovered: Sidecar | undefined, away: number | undefined;
  try {
    const selected = bootstrap(await sidecar.value("desktop-bootstrap")), sessionId = selected.snapshot!.session!.id;
    await sidecar.value("drive", { sessionId, text: "--bounded Inspect the workspace" });
    expect(await sidecar.request("desktop-open-project", { path: other })).toMatchObject({ ok: false, error: "Pause Drive before changing projects" });
    expect(await sidecar.close()).toBe(0);
    const key = createHash("sha256").update(`${f.server.url.href}\n${f.workspace}`).digest("hex");
    const journalPath = join(f.settings.dataDirectory, "drive", `${key}.json`);
    // A background process with no window carries the mission on.
    const marker = JSON.parse(readFileSync(`${journalPath}.away.json`, "utf8"));
    away = marker.pid;
    expect(marker.sessionId).toBe(sessionId);
    await eventually(() => { try { return readFileSync(`${journalPath}.lock`, "utf8") === String(marker.pid); } catch { return false; } }, 10000);
    // The closing window saved the mission paused; the background process
    // takes the lock before it resumes the mission and saves it again.
    await eventually(() => { try { return JSON.parse(readFileSync(journalPath, "utf8")).status !== "paused"; } catch { return false; } }, 10000);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(journal.mission).toBe("Inspect the workspace");
    expect(["running", "waiting"]).toContain(journal.status);
    // Opening the project again stops it and resumes the mission in the window.
    recovered = new Sidecar(f);
    expect(["running", "waiting"]).toContain(bootstrap(await recovered.value("desktop-bootstrap")).snapshot!.drive!.status);
    expect(existsSync(`${journalPath}.away.json`)).toBe(false);
    expect(alive(marker.pid)).toBe(false);
    expect(readFileSync(`${journalPath}.lock`, "utf8")).not.toBe(String(marker.pid));
    // Pausing first means closing leaves it paused, with nothing in the background.
    await recovered.value("drive-control", { sessionId, control: "pause" });
    expect(await recovered.close()).toBe(0);
    expect(existsSync(`${journalPath}.away.json`)).toBe(false);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).status).toBe("paused");
  } finally {
    await sidecar.close(); if (recovered) await recovered.close();
    if (away && alive(away)) process.kill(away, "SIGKILL");
    await f.close();
  }
});


test("desktop inline CLI options select the fixture daemon, workspace, session, and private HOME", async () => {
  const f = await fixture();
  writeFileSync(f.settings.configPath, 'theme = "demesne-light"\n[daemon]\nauto_start = "never"\n');
  const sessionId = (await f.client.createSession({ workspacePath: f.workspace, title: "Inline options restored session", trustWorkspace: true })).session.id;
  const sidecar = new Sidecar(f, [`--server=${f.server.url.href}`, `--workspace=${f.workspace}`, `--session=${sessionId}`]);
  try {
    const selected = bootstrap(await sidecar.value("desktop-bootstrap"));
    expect(selected.workspace).toBe(f.workspace);
    expect(selected.snapshot!.connection).toBe("online");
    expect(selected.snapshot!.model.id).toBe("qwen3.8-27b");
    expect(selected.snapshot!.session!.id).toBe(sessionId);
    expect(selected.snapshot!.session!.title).toBe("Inline options restored session");
    expect(selected.snapshot!.theme).toBe("demesne-light");
    const privatePreferences = JSON.parse(readFileSync(join(f.home, ".demesne", "desktop-ui.json"), "utf8"));
    expect(privatePreferences.lastWorkspace).toBe(f.workspace);
    expect(Object.values(privatePreferences.lastSessions)).toEqual([sessionId]);
    expect(await f.client.listSessions()).toHaveLength(1);
  } finally { expect(await sidecar.close()).toBe(0); await f.close(); }
});

test("desktop CLI rejects missing and empty split or inline option values", async () => {
  const f = await fixture();
  try {
    for (const args of [["--workspace"], ["--workspace", ""], ["--workspace="], ["--server="], ["--session="], ["--server", "--workspace", f.workspace], ["--workspace", f.workspace, `--workspace=${f.workspace}`]]) {
      const sidecar = new Sidecar(f, args);
      try {
        expect(await sidecar.child.exited).toBe(1);
        await eventually(() => sidecar.errors.length > 0);
        expect(sidecar.errors).toMatch(/Missing --(?:workspace|server|session) value|Use --workspace only once/);
        expect(sidecar.messages).toHaveLength(0);
      } finally { await sidecar.close(); }
    }
    expect(await f.client.listSessions()).toHaveLength(0);
  } finally { await f.close(); }
});

test("desktop launch options send the first message to the opened project", async () => {
  const f = await fixture();
  const sidecar = new Sidecar(f, [`--workspace=${f.workspace}`, "--prompt=Hello from the command line"]);
  try {
    await eventually(async () => {
      const sessions = await f.client.listSessions();
      if (!sessions.length) return false;
      return (await f.client.getSessionState(sessions[0]!.id)).session.turns.at(-1)?.status === "completed";
    });
    const [session] = await f.client.listSessions();
    expect((await f.client.getSessionState(session!.id)).session.turns.map(turn => turn.content)).toEqual(["Hello from the command line"]);
  } finally { expect(await sidecar.close()).toBe(0); await f.close(); }
});

test("launch lands on Home as Just a chat; the where word and Move to a project give a chat its folder", async () => {
  const f = await fixture(), other = join(f.root, "other");
  mkdirSync(other);
  await f.client.createSession({ workspacePath: other, trustWorkspace: true });
  const first = new Sidecar(f, ["--workspace", f.workspace]);
  let home: Sidecar | undefined;
  try {
    // Opened with a project: Home with that project picked, an empty chat.
    const opened = bootstrap(await first.value("desktop-bootstrap"));
    expect(opened.snapshot!.session!.workspace!.root).toBe(f.workspace);
    expect(opened.snapshot!.runs).toEqual([]);
    await first.close();
    // Launched again: Home as Just a chat, and an empty one is used again.
    home = new Sidecar(f);
    const launched = bootstrap(await home.value("desktop-bootstrap"));
    const plainId = launched.snapshot!.session!.id;
    expect(launched.workspace).toBe(f.workspace);
    expect(launched.snapshot!.session!.workspace).toBeNull();
    expect(await home.value("new-session", { plain: true, reuse: true, sessionId: plainId })).toBe(plainId);
    // Picking the project carries what was typed into a chat there.
    await home.value("draft", { sessionId: plainId, text: "Fix the sidebar" });
    await home.value("new-session", { reuse: true, draft: "Fix the sidebar", sessionId: plainId });
    let snapshot = await home.value("bootstrap") as { session: { id: string; workspace: { root: string } | null }; draft: string };
    expect(snapshot.session.workspace!.root).toBe(f.workspace);
    expect(snapshot.draft).toBe("Fix the sidebar");
    // Back to Just a chat, and a reply there has no project tools.
    await home.value("new-session", { plain: true, reuse: true, draft: "What is a CRDT?", sessionId: snapshot.session.id });
    snapshot = await home.value("bootstrap") as typeof snapshot;
    expect(snapshot.session.id).toBe(plainId);
    expect(snapshot.draft).toBe("What is a CRDT?");
    await home.value("submit", { sessionId: plainId, text: "What is a CRDT?" });
    await eventually(async () => (await f.client.getSessionState(plainId)).session.turns.at(-1)?.status === "completed");
    // Move to a project: here, the chat stays open with its folder.
    expect(await home.value("move-session", { sessionId: plainId, path: f.workspace })).toEqual({ here: true, sessionId: plainId });
    expect((await f.client.getSessionState(plainId)).session.workspace!.root).toBe(f.workspace);
    expect(await home.request("move-session", { sessionId: plainId, path: other })).toMatchObject({ ok: false, error: "Only a chat that isn't in a project can move" });
    // Elsewhere: the window then opens that project on the chat.
    await home.value("new-session", { plain: true, sessionId: plainId });
    const second = (await home.value("bootstrap") as typeof snapshot).session.id;
    await home.value("submit", { sessionId: second, text: "Hello" });
    await eventually(async () => (await f.client.getSessionState(second)).session.turns.at(-1)?.status === "completed");
    expect(await home.value("move-session", { sessionId: second, path: other })).toEqual({ here: false, sessionId: second });
    expect(bootstrap(await home.value("desktop-open-project", { path: other, sessionId: second })).snapshot!.session!.id).toBe(second);
    // The where word opens another project on an empty chat, with the draft.
    const back = bootstrap(await home.value("desktop-open-project", { path: f.workspace, fresh: true, draft: "Carry this" }));
    expect(back.workspace).toBe(f.workspace);
    expect(back.snapshot!.session!.workspace!.root).toBe(f.workspace);
    expect(back.snapshot!.runs).toEqual([]);
    expect(back.snapshot!.draft).toBe("Carry this");
  } finally { await first.close(); if (home) await home.close(); await f.close(); }
});
