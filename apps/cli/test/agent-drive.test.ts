import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDriveDecision, parseDriveRequest, validateDriveDecisionContext, type DriveAction, type DriveDecision, type DriveObservation, type DriveRequest, type DriveResponse } from "@demesne/protocol";
import { AgentDrive, DriveJournal } from "../src/agent-drive.ts";

const decision = (action: DriveAction, extra: Partial<DriveDecision> = {}): DriveDecision => ({ action, note: "Inspect the result", notes: "Recovered the goal", completed: [], remaining: ["Verify"], evidence: [], ...extra });
const response = (value: DriveDecision): DriveResponse => ({ decision: value, provider: "test", model: "test", imageInspected: false });
const observation = (): DriveObservation => ({ id: crypto.randomUUID(), sessionId: "home", workspace: "/project", title: "Mission", mode: "input", ready: true, draft: "", surface: "response", width: 100, height: 30, rows: ["Done", "test suite: 12 passed"], controls: [] });

test("Drive defers inference for running turns, approvals, loading and existing drafts", async () => {
  let current = observation(), calls = 0;
  const drive = new AgentDrive({ observe: () => current, perform: async () => "", decide: async () => { calls++; return response(decision({ kind: "wait" })); }, changed() {}, delayMs: 60_000 });
  try {
    drive.start("Finish the parser");
    for (const mode of ["streaming", "approval"] as const) { current = { ...current, mode }; await drive.step(); expect(drive.state?.status).toBe("waiting"); }
    current = { ...current, mode: "input", ready: false }; await drive.step();
    current = { ...current, ready: true, draft: "human draft" }; await drive.step();
    expect(calls).toBe(0); expect(drive.state?.status).toBe("blocked");
  } finally { drive.dispose(); }
});

test("Resume explains missing or completed missions instead of silently returning", async () => {
  const screen = { ...observation(), surface: "log" };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", decide: async () => response(decision({ kind: "complete" }, {
    remaining: [], evidence: [{ observationId: screen.id, quote: "test suite: 12 passed" }],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    expect(() => drive.control("resume")).toThrow("No saved Drive mission");
    drive.start("--bounded Verify the result"); await drive.step();
    expect(() => drive.control("resume")).toThrow("mission is complete");
  } finally { drive.dispose(); }
});

test("pause aborts a pending decision and ignores a late action; resume observes afresh", async () => {
  const gate = Promise.withResolvers<DriveResponse>(); let calls = 0, actions = 0, signal: AbortSignal | undefined;
  const drive = new AgentDrive({ observe: observation, perform: async () => { actions++; return "sent"; }, decide: async (_, input) => { signal = input; return ++calls === 1 ? gate.promise : response(decision({ kind: "key", key: "alt+d" })); }, changed() {}, delayMs: 60_000 });
  try {
    drive.start("Finish"); const pending = drive.step(); drive.intervene();
    expect(signal?.aborted).toBe(true);
    gate.resolve(response(decision({ kind: "compose", text: "Never submit this stale instruction" })));
    await pending; expect(actions).toBe(0); expect(drive.state?.status).toBe("paused");
    drive.control("resume"); await drive.step(); expect(actions).toBe(1);
  } finally { drive.dispose(); }
});

test.each(["invented", "response-only", "own-notes", "remaining", "verified"])("completion evidence gate: %s", async (kind) => {
  const current = { ...observation(), surface: kind === "own-notes" ? "drive" : kind === "response-only" ? "response" : "log" };
  const drive = new AgentDrive({ observe: () => current, perform: async () => "", decide: async () => response(decision({ kind: "complete" }, {
    evidence: [{ observationId: current.id, quote: kind === "invented" ? "made up result" : "test suite: 12 passed" }], remaining: kind === "remaining" ? ["Still broken"] : [],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try { drive.start("--bounded Finish"); await drive.step(); expect(drive.state?.status).toBe(kind === "verified" ? "completed" : "blocked"); }
  finally { drive.dispose(); }
});

test.each(["answer", "request", "thinking", "drive-notes", "implementation", "old-observation"])("advisory completion is grounded in a visible completed answer: %s", async (source) => {
  const screen = { ...observation(), surface: "drive", rows: ["Earlier audit recommends removing duplicate menu wiring."],
    evidenceRows: ["Earlier audit recommends removing duplicate menu wiring."], answerRows: source === "answer" || source === "implementation" || source === "old-observation" ? ["Earlier audit recommends removing duplicate menu wiring."] : [] };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", decide: async () => response(decision({ kind: "complete", basis: source === "implementation" ? "verified-work" : "answer" }, {
    note: "The earlier audit recommends consolidating the menu paths. Inspect current consumers before deleting helpers.", remaining: [],
    evidence: [{ observationId: source === "old-observation" ? "old" : screen.id, quote: "removing duplicate menu wiring" }],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    drive.start(source === "implementation" ? "Implement menu cleanup" : "What can we improve?"); await drive.step();
    expect(drive.state?.status).toBe(source === "answer" ? "completed" : "blocked");
  } finally { drive.dispose(); }
});

test("a rejected completion is available to the planner on resume and after journal recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-feedback-")), path = join(root, "mission.json");
  const screen = { ...observation(), surface: "response", answerRows: ["Done"] }; let calls = 0;
  const services = { path, observe: () => screen, changed() {}, perform: async () => "Opened log", delayMs: 60_000, retryDelaysMs: [],
    decide: async (request: DriveRequest) => {
      if (++calls > 1) {
        expect(request.memory.feedback).toContain("verified-work completion requires");
        expect(request.memory.feedback).toContain('"kind":"complete"');
        return response(decision({ kind: "key", key: "ctrl+b" }));
      }
      return response(decision({ kind: "complete" }, { remaining: [], evidence: [{ observationId: screen.id, quote: "Done" }] }));
    } };
  const drive = new AgentDrive(services);
  try {
    drive.start("Verify the implementation"); await drive.step(); expect(drive.state?.status).toBe("blocked");
    // An existing failed journal predating memory.feedback recovers the failed
    // trace's reason too; it must not resend only the stale successful notes.
    const old = JSON.parse(readFileSync(path, "utf8")); delete old.feedback;
    writeFileSync(path, JSON.stringify(old));
    const restored = new AgentDrive(services);
    try { restored.control("resume"); await restored.step(); expect(restored.state?.feedback).toBeUndefined(); expect(restored.state?.status).toBe("running"); }
    finally { restored.dispose(); }
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("completed subtask memory reaches the next decision and survives journal restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-progress-")), path = join(root, "mission.json");
  const requests: DriveRequest[] = [];
  const services = { path, observe: observation, changed() {}, perform: async () => "Opened log", delayMs: 60_000,
    decide: async (request: DriveRequest) => {
      requests.push(structuredClone(request));
      return response(decision({ kind: "key", key: "ctrl+b" }, {
        notes: "Implementation finished; inspect recorded checks next.",
        completed: ["Parser implementation finished"], remaining: ["Inspect recorded checks"],
      }));
    } };
  const drive = new AgentDrive(services);
  let restored: AgentDrive | undefined;
  try {
    drive.start("Implement and verify parser");
    await drive.step();
    expect(drive.state?.completed).toEqual(["Parser implementation finished"]);
    expect(drive.state?.ledger?.tasks[0]?.status).toBe("active");
    await drive.step();
    expect(requests[1]?.memory.completed).toEqual(["Parser implementation finished"]);
    expect(requests[1]?.memory.remaining).toEqual(["Inspect recorded checks"]);
    expect(requests[1]?.memory.steps.at(-1)?.result).toBe("Opened log");
    drive.control("pause");
    restored = new AgentDrive(services);
    restored.control("resume");
    await restored.step();
    expect(requests[2]?.memory.completed).toEqual(["Parser implementation finished"]);
    expect(requests[2]?.memory.notes).toBe("Implementation finished; inspect recorded checks next.");
  } finally { restored?.dispose(); drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("planner progress cannot erase or replace verified ledger completions", async () => {
  const drive = new AgentDrive({ observe: observation, changed() {}, perform: async () => "Opened log", delayMs: 60_000,
    decide: async () => response(decision({ kind: "key", key: "ctrl+b" }, {
      completed: Array.from({ length: 32 }, (_, index) => `Subtask ${index}`),
    })) });
  try {
    drive.start("Verify current task");
    const ledger = drive.state!.ledger!;
    const prior = structuredClone(ledger.tasks[0]!);
    prior.id = "prior-task"; prior.title = "Previously verified task"; prior.status = "completed";
    ledger.tasks.unshift(prior);
    await drive.step();
    expect(drive.state?.completed).toHaveLength(32);
    expect(drive.state?.completed[0]).toBe("Previously verified task");
    expect(drive.state?.completed[1]).toBe("Subtask 0");
    expect(ledger.tasks[0]?.status).toBe("completed");
    expect(ledger.tasks[1]?.status).toBe("active");
  } finally { drive.dispose(); }
});

test("journal restores paused, holds a single writer, and does not replay prepared submissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-drive-")); const path = join(root, "drive.json");
  let performs = 0;
  const services = { path, observe: observation, perform: async () => { performs++; return "sent"; }, decide: async () => response(decision({ kind: "compose", text: "Implement the recovered goal" })), changed() {}, delayMs: 60_000 };
  const drive = new AgentDrive(services);
  try {
    drive.start("Finish parser"); await drive.step();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => new DriveJournal(path).acquire()).toThrow("another workbench");
    const restored = new AgentDrive(services); expect(restored.state?.status).toBe("paused"); await restored.step();
    expect(performs).toBe(1); expect(restored.state?.steps[0]?.result).toBe("sent");
    expect(readFileSync(path, "utf8")).toContain("Recovered the goal");
    restored.dispose(); drive.control("pause"); restored.control("resume"); restored.dispose();
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test.each([true, false])("docked Drive accepts conversation evidence while excluding its own notes: %s", async (visibleResult) => {
  const screen = { ...observation(), surface: "drive", rows: ["test suite: 12 passed | Drive notes: all done"], evidenceRows: ["test suite: 12 passed"] };
  let actions = 0;
  const drive = new AgentDrive({ observe: () => screen, perform: async () => { actions++; return "opened Diff"; }, decide: async () => response(decision({ kind: "key", key: "alt+d" }, {
    evidence: [{ observationId: screen.id, quote: visibleResult ? "test suite: 12 passed" : "Drive notes: all done" }],
  })), changed() {}, delayMs: 60_000 });
  try { drive.start("Review"); await drive.step(); expect(actions).toBe(visibleResult ? 1 : 0); }
  finally { drive.dispose(); }
});

test("Drive cannot submit work or /plan into a history session, and detects no-progress loops", async () => {
  let current = observation(); let next = decision({ kind: "compose", text: "/plan change parser" }); let performed = 0;
  const drive = new AgentDrive({ observe: () => current, perform: async () => { performed++; return "no change"; }, decide: async () => response(next), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    drive.start("Finish"); current = { ...current, sessionId: "old" }; await drive.step();
    expect(drive.state?.status).toBe("blocked"); expect(performed).toBe(0);
    drive.control("resume"); next = decision({ kind: "key", key: "down" });
    for (let i = 0; i < 4; i++) await drive.step();
    expect(drive.state?.status).toBe("blocked"); expect(drive.state?.activity).toContain("repeated an action");
  } finally { drive.dispose(); }
});

test("Drive validation names the failing decision or request field", () => {
  expect(() => parseDriveDecision(decision({ kind: "key" } as DriveAction))).toThrow("action.key");
  expect(() => parseDriveDecision(decision({ kind: "wait" }, { notes: "x".repeat(8001) }))).toThrow("notes");
  expect(() => parseDriveRequest({ mission: "Review", homeSessionId: "home", observation: observation(),
    memory: { notes: "", completed: [], remaining: ["x".repeat(1001)], evidence: [], steps: [] } })).toThrow("memory.remaining[0]");
});

test("protocol rejects arbitrary commands, keys, invalid payload sizes and coordinates", () => {
  for (const text of ["/exit", "/undo", "/model other", "/custom-task"]) expect(() => parseDriveDecision(decision({ kind: "compose", text }))).toThrow();
  expect(() => parseDriveDecision(decision({ kind: "key", key: "ctrl+c" as never }))).toThrow();
  expect(() => parseDriveDecision(decision({ kind: "scroll", row: -1, column: 0, amount: 1 }))).toThrow();
  expect(() => parseDriveRequest({ mission: "a".repeat(8001), homeSessionId: "home", observation: observation(), memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } })).toThrow();
});

test("Drive thinks only on judgment steps: the first decision and each newly finished turn; navigation is quick", async () => {
  const nav = (turn: string, answer: boolean) => ({ document: `doc-${turn}`, turn, latest: true, answer, readingHeld: false, files: [], checks: [] });
  let current: DriveObservation = { ...observation(), navigation: nav("t1", false) };
  const thinking: (boolean | undefined)[] = [];
  const keys = ["ctrl+b", "alt+d", "escape", "ctrl+g", "alt+h", "alt+r"] as const;
  const drive = new AgentDrive({ observe: () => current, perform: async () => "", changed() {}, delayMs: 60_000, retryDelaysMs: [],
    decide: async (body) => { thinking.push(body.thinking); return response(decision({ kind: "key", key: keys[thinking.length % keys.length]! })); } });
  try {
    drive.start("Explain the lexer");
    await drive.step();                                                     // first decision: think
    await drive.step();                                                     // coder's turn not finished: quick
    current = { ...observation(), navigation: nav("t1", true), latestAnswerRows: ["The lexer scans identifiers."] };
    await drive.step();                                                     // turn t1 finished: think
    await drive.step();                                                     // following steps on t1: quick
    current = { ...observation(), navigation: nav("t2", true), latestAnswerRows: ["Fixed the guard."] };
    await drive.step();                                                     // new finished turn t2: think
    expect(thinking).toEqual([true, false, true, false, true]);
  } finally { drive.dispose(); }
});

test("in continuous mode an answered question ends Drive instead of looking for more work", async () => {
  const answer = "The UI is a workbench with a docked panel.";
  const screen = { ...observation(), surface: "response", rows: [answer], evidenceRows: [answer], answerRows: [answer], latestAnswerRows: [answer] };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", changed() {}, delayMs: 60_000, retryDelaysMs: [], continuous: true,
    decide: async () => response(decision({ kind: "complete", basis: "answer" }, { note: "It is a workbench with a docked panel.", remaining: [],
      evidence: [{ observationId: screen.id, quote: "workbench with a docked panel" }] })) });
  try {
    drive.start("Tell me about the UI of this CLI"); await drive.step();
    expect(drive.state?.status).toBe("completed");
    expect(drive.state?.autonomy?.phase).toBe("working");
  } finally { drive.dispose(); }
});

test("a blank composer draft does not block Drive", async () => {
  const drive = new AgentDrive({ observe: () => ({ ...observation(), draft: "\n" }), perform: async () => "ok", changed() {}, delayMs: 60_000,
    decide: async () => response(decision({ kind: "wait" })) });
  try { drive.start("Describe this UI"); await drive.step(); expect(drive.state?.status).not.toBe("blocked"); }
  finally { drive.dispose(); }
});

test("Drive is told why alt+enter outside a Diff, and inspecting before any turn, are invalid", () => {
  const navigation = { document: "doc:1", turn: "0", latest: true, answer: false, readingHeld: false, files: [], checks: [] };
  const request = (screen: Partial<DriveObservation>): DriveRequest => ({ mission: "Describe this UI", homeSessionId: "home",
    observation: { ...observation(), navigation, ...screen }, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } });
  expect(() => validateDriveDecisionContext(decision({ kind: "key", key: "alt+enter" }), request({}))).toThrow("types a newline into the composer");
  expect(() => validateDriveDecisionContext(decision({ kind: "key", key: "alt+enter" }), request({ panes: [{ surface: "diff", row: 0, column: 60, width: 40, height: 30 }] }))).not.toThrow();
  expect(() => validateDriveDecisionContext(decision({ kind: "inspect", target: "log" }), request({}))).toThrow("no turn to inspect yet");
  expect(() => validateDriveDecisionContext(decision({ kind: "inspect", target: "log" }), request({ navigation: { ...navigation, turn: "3" } }))).not.toThrow();
});

test("/drive keeps choosing worthwhile work by default; --bounded or a bounded workbench opts out", () => {
  const services = { observe: observation, perform: async () => "", decide: async () => response(decision({ kind: "wait" })), changed() {}, delayMs: 60_000 };
  for (const [continuous, mission, mode] of [[undefined, "Improve the parser", "continuous"], [undefined, "--bounded Fix one bug", "bounded"],
    [false, "Fix one bug", "bounded"], [false, "--continuous Improve the parser", "continuous"]] as const) {
    const drive = new AgentDrive({ ...services, continuous });
    try {
      drive.start(mission);
      expect([drive.state?.mode, Boolean(drive.state?.autonomy)]).toEqual([mode, mode === "continuous"]);
    } finally { drive.dispose(); }
  }
});

test("resuming a blocked mission tells Drive to retry the blocked step instead of re-reading the old answer", async () => {
  const requests: DriveRequest[] = [];
  let calls = 0;
  const drive = new AgentDrive({ observe: observation, perform: async () => "Sent through the visible composer: retry", changed() {}, delayMs: 60_000,
    decide: async (request) => { requests.push(structuredClone(request)); return response(decision(++calls === 1 ? { kind: "blocked" } : { kind: "wait" })); } });
  try {
    drive.start("Send an astra sub-agent to look at the UI"); await drive.step();
    expect(drive.state?.status).toBe("blocked");
    drive.control("resume"); await drive.step();
    expect(requests[1]!.memory.feedback).toContain("Retry the blocked step once with a fresh request");
    // A pause is not a block: resuming it carries no such instruction.
    drive.control("pause"); drive.control("resume"); await drive.step();
    expect(requests[2]!.memory.feedback ?? "").not.toContain("Retry the blocked step");
  } finally { drive.dispose(); }
});

test("a question's full answer is kept apart from Drive's one-line note", async () => {
  const screen = { ...observation(), surface: "response", rows: ["The parser lives in src/parser.ts"], answerRows: ["The parser lives in src/parser.ts"] };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", changed() {}, delayMs: 60_000, continuous: false,
    decide: async () => response({ ...decision({ kind: "complete", basis: "answer" }, { note: "Answered where the parser lives.", remaining: [],
      evidence: [{ observationId: screen.id, quote: "src/parser.ts" }] }), answer: "The parser is in src/parser.ts; its entry point is parse()." }) });
  try {
    drive.start("Where is the parser?"); await drive.step();
    expect(drive.state?.status).toBe("completed");
    expect(drive.state?.activity).toBe("Answered where the parser lives.");
    expect(drive.state?.answer).toBe("The parser is in src/parser.ts; its entry point is parse().");
  } finally { drive.dispose(); }
  expect(parseDriveDecision({ action: { kind: "complete", basis: "answer" }, note: "Answered.", notes: "", completed: [], remaining: [], evidence: [], answer: "Full text." }).answer).toBe("Full text.");
  expect(parseDriveDecision({ action: { kind: "wait" }, note: "Waiting.", notes: "", completed: [], remaining: [], evidence: [] }).answer).toBeUndefined();
});

test("Drive's own just-sent text lingering in a stale observation is waited out; a real draft still blocks", async () => {
  let draft = "";
  const drive = new AgentDrive({ observe: () => ({ ...observation(), draft }), changed() {}, delayMs: 60_000,
    perform: async (action) => action.kind === "compose" ? `Sent through the visible composer: ${action.text}` : "",
    decide: async () => response(decision({ kind: "compose", text: "Run the fixture check and report its result" })) });
  try {
    drive.start("Verify the fixture check"); await drive.step();
    draft = "Run the fixture check and report";
    await drive.step();
    expect(drive.state?.status).toBe("waiting");
    draft = "my own idea";
    await drive.step();
    expect(drive.state?.status).toBe("blocked");
  } finally { drive.dispose(); }
});
