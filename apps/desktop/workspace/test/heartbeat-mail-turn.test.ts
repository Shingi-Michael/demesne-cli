import { expect, test } from "bun:test";
import { formatMail } from "../../../../packages/protocol/src/heartbeat-mail.ts";

// Exercise the mail bubble and reply receipt renderers without booting the desktop host.
const source = await Bun.file(new URL("../live.ts", import.meta.url)).text();
const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const { parseMailTurn } = await import("../../../../packages/protocol/src/heartbeat-mail.ts");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${slice("const ICON_MAIL =", "/// \"replied to")}\n${slice("function mailReply(", "\n}\n")}}`);
const render = new Function("parseMailTurn", "h", "clock", `${js}\n  return { mailRequest, mailReply };`)(parseMailTurn, (text: string) => String(text).replace(/</g, "&lt;"), () => "04:52") as {
  mailRequest: (run: unknown) => string | null;
  mailReply: (run: unknown) => string;
};

const content = formatMail("demesne@macbook/demesne-cli-k3x9a", [
  { authority: "peer", compact: 'REQ#msg-1 →demesne@macbook/demesne-cli-k3x9a ←claude@macbook/heartbeat-k3x9a why:"status of the tests"', english: "claude asked: status of the tests" },
], []);

test("a mail turn draws as a tinted bubble with the sender, the kind and the words; no edit or retry", () => {
  const html = render.mailRequest({ id: "t", content, createdAt: "2026-10-19T04:52:00Z", entries: [] })!;
  expect(html).toContain('class="request mail"');
  expect(html).toContain("claude@macbook/heartbeat-k3x9a");
  expect(html).toContain('class="mail-kind"');
  expect(html).toContain(">request<");
  expect(html).toContain('<span class="text">status of the tests</span>');
  expect(html).not.toContain("edit-ask");
  expect(html).not.toContain("retry-ask");
  expect(render.mailRequest({ id: "t", content: "typed by hand", createdAt: "", entries: [] })).toBeNull();
});

test("the receipt says where the reply went, by machine", () => {
  const entries = [
    { id: 1, type: "tool", name: "heartbeat", input: { action: "send", to: "claude@macbook/heartbeat-k3x9a", performative: "inform", text: "693 pass" }, state: "done" },
    { id: 2, type: "tool", name: "heartbeat", input: { action: "agents" }, state: "done" },
  ];
  expect(render.mailReply({ id: "t", content, entries })).toBe('replied to <span class="mail-address">claude@macbook</span>');
  expect(render.mailReply({ id: "t", content, entries: [entries[1]] })).toBe("");
});
