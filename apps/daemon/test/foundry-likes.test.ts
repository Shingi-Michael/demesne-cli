import { expect, test } from "bun:test";
import { DemesneStore } from "@demesne/storage";
import { foundryReadTool } from "../src/foundry.ts";

// Pass 242 A: what the person pinned as liked on a mockup is handed back on
// every later read, so a new version does not lose it.
test("keep notes pinned on a mockup come back with it on every read", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Slow Pour", "/tmp");
    const { turn: made } = store.createTurn(session.id, "Show me the plans page");
    const mockup = store.saveFoundryArtifact({ kind: "html", title: "Plans page", source: "<main>Plans</main>", sessionId: session.id, turnId: made.id });
    store.startTurn(made.id); store.completeTurn(made.id);
    const read = async () => JSON.parse(await foundryReadTool(store).execute({ id: mockup.id }, { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id } as never));
    expect((await read()).liked).toBeUndefined();

    const notes = (lines: string, detail: string) => `On “Plans page”:\n${lines}\n\n\`\`\`parts\nNotes pinned on the Foundry mockup "Plans page" (id ${mockup.id}, v1). ${detail}\n♥ · not this one: it is in the folded detail\n\`\`\``;
    for (const content of [
      notes("1 · Daily card: Less orange\n♥ · “Most chosen”: Keep this tag, it reads warm", "Change only…"),
      "♥ · A heart line in a message about something else",
      notes("♥ · The page: Love the serif heading\n♥ · “Most chosen”: Keep this tag, it reads warm", "Nothing to change…"),
    ]) { const { turn } = store.createTurn(session.id, content); store.startTurn(turn.id); store.completeTurn(turn.id); }

    // Oldest first, said once, and only from notes on this mockup, never from the detail folded under them.
    expect(store.foundryLikes(mockup.id)).toEqual(["The page: Love the serif heading", "“Most chosen”: Keep this tag, it reads warm"]);
    const after = await read();
    expect(after.liked).toEqual(["The page: Love the serif heading", "“Most chosen”: Keep this tag, it reads warm"]);
    expect(after.liked_rule).toMatch(/keep each as it is/);
    expect(store.foundryLikes("x%")).toEqual([]);
  } finally { store.close(); }
});
