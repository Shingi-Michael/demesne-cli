import { expect, test } from "bun:test";
import { formatMail, isMailTurn, parseMailTurn } from "../src/heartbeat-mail.ts";

const address = "demesne@macbook/demesne-cli-k3x9a";

test("parseMailTurn reads back what formatMail wrote: sender, kind, words, pair requests", () => {
  const text = formatMail(address, [
    { authority: "peer", compact: 'REQ#msg-1 →demesne@macbook/demesne-cli-k3x9a ←claude@macbook/heartbeat-k3x9a why:"status of the tests"', english: "claude asked demesne: status of the tests" },
    { authority: "owner", compact: "INF#msg-2 ^msg-1 ←codex@air/api-2v8qa", english: "codex informed demesne: the api tests pass" },
  ], [{ node_id: "macbook-air", requester: "codex@macbook-air", capabilities: ["mail"] }]);
  expect(isMailTurn(text)).toBe(true);
  const mail = parseMailTurn(text)!;
  expect(mail.address).toBe(address);
  expect(mail.messages).toHaveLength(2);
  expect(mail.messages[0]).toMatchObject({ authority: "peer", performative: "request", id: "msg-1", from: "claude@macbook/heartbeat-k3x9a", text: "status of the tests" });
  // No why:"...": the English line stands in for the words.
  expect(mail.messages[1]).toMatchObject({ authority: "owner", performative: "inform", id: "msg-2", from: "codex@air/api-2v8qa", text: "codex informed demesne: the api tests pass" });
  expect(mail.pairRequests).toEqual([{ requester: "codex@macbook-air", node: "macbook-air" }]);
});

test("parseMailTurn is null for a typed prompt and tolerates an envelope without a sender", () => {
  expect(parseMailTurn("Heartbeat is a daemon, explain it")).toBeNull();
  const mail = parseMailTurn(`Heartbeat mail for ${address}:\n[peer] DONE#7 why:"finished"`)!;
  expect(mail.messages[0]).toMatchObject({ performative: "done", from: "", text: "finished" });
});
