import { expect, test } from "bun:test";
import { formatMail } from "../../../../packages/protocol/src/heartbeat-mail.ts";
import { answersAfter, askedIn, askRowHTML } from "../ask-row.ts";

const send = (id: number, to: string, message?: Record<string, unknown>, state = "done") =>
  ({ type: "tool", id, name: "heartbeat", state, input: { action: "send", to, text: "look into it" }, ...(message ? { message: JSON.stringify(message) } : {}) });
const CLAUDE = "demesne@mac/demesne-cli-dfzw5", CODEX = "demesne@mac/demesne-cli-chb3f", GEMINI = "gemini@other/garden";
const entries = [
  { type: "tool", id: 1, name: "heartbeat", state: "done", input: { action: "agents" } },
  send(2, CLAUDE, { id: "7", to: CLAUDE, agent: "claude", name: "Claude Code", project: "demesne-cli" }),
  send(3, CODEX, { id: "8", to: CODEX, agent: "codex", name: "Codex", project: "demesne-cli" }),
  send(4, GEMINI),
];
const mail = (from: string, text: string) => formatMail("demesne@mac/demesne-cli-aaaaa", [{ authority: "peer", compact: `DON#12 ^7 →demesne@mac/demesne-cli-aaaaa ←${from} why:"${text}"`, english: text }], []);

test("a turn's sends name who they went to", () => {
  const asked = askedIn(entries);
  expect(asked.map((item) => [item.name, item.agent, item.project])).toEqual([["Claude Code", "claude", "demesne-cli"], ["Codex", "codex", "demesne-cli"], ["Gemini", "gemini", "garden"]]);
});

test("answers are the mail that came back from each address afterwards", () => {
  const runs = [{ content: "ask them" }, { content: mail(CODEX, "Drafts are keyed by session") }, { content: mail(CODEX, "a second note") }, { content: "unrelated" }];
  const answers = answersAfter(runs, 0, [CLAUDE, CODEX, GEMINI]);
  expect([...answers.keys()]).toEqual([CODEX]);
  expect(answers.get(CODEX)!.text).toBe("Drafts are keyed by session");
});

const view = (answers: Map<string, { text: string; performative: string }>, open = false, working = false) =>
  askRowHTML({ asked: askedIn(entries), answers, open, runId: "r1", mail: "<i class=mail></i>", face: (agent) => `<i data-face="${agent}"></i>`, working: () => working });

test("one row: faces, how many asked, how many answered", () => {
  const html = view(new Map([[CODEX, { text: "Drafts are keyed by session", performative: "done" }]]), false, true);
  expect(html).toContain("Asked 3 agents");
  expect(html.match(/data-face=/g)?.length).toBe(3);
  expect(html).toContain("1 of 3 answered");
  expect(html).toContain("running");
  expect(html).not.toContain("ask-line");
  const all = view(new Map([CLAUDE, CODEX, GEMINI].map((to) => [to, { text: "ok", performative: "done" }])));
  expect(all).toContain("all answered");
});

test("open, a line per agent with the first line of its answer and its chat", () => {
  const html = view(new Map([[CODEX, { text: "Drafts are keyed by session", performative: "done" }]]), true);
  expect(html.match(/class="ask-line"/g)?.length).toBe(3);
  expect(html).toContain("<b>Codex:</b> Drafts are keyed by session");
  expect(html).toContain('data-action="agent-open"');
  expect(html).toContain("waiting");
});
