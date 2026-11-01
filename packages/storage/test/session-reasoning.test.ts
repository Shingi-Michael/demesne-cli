import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "../src/index.ts";

test("effort migrates additively and survives reopening with the selected model", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-effort-"));
  let store: DemesneStore | undefined;
  try {
    const path = join(root, "state.sqlite");
    store = new DemesneStore(path);
    const { session } = store.createSession("Legacy chat");
    store.setSessionPreferredModel(session.id, "model");
    store.database.run("ALTER TABLE sessions DROP COLUMN preferred_reasoning");
    store.close();
    store = new DemesneStore(path);
    expect(store.getSession(session.id)?.preferredReasoning).toBeUndefined();
    store.setSessionInference(session.id, { preferredModel: "model", preferredReasoning: "high" });
    store.close();
    store = new DemesneStore(path);
    expect(store.getSession(session.id)).toMatchObject({ preferredModel: "model", preferredReasoning: "high" });
    expect(store.setSessionInference(session.id, { preferredReasoning: "low" })).toMatchObject({ preferredModel: "model", preferredReasoning: "low" });
    expect(store.setSessionInference(session.id, { preferredReasoning: null }).preferredReasoning).toBeUndefined();
    store.setSessionInference(session.id, { preferredReasoning: "high" });
    expect(store.setSessionPreferredModel(session.id, "different").preferredReasoning).toBeUndefined();
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
