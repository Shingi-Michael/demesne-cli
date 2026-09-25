import { DemesneStore } from "../packages/storage/src/index.ts";
import { ingestImage, readArtifact } from "../apps/daemon/src/artifacts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "demesne-image-runtime-"));
const store = new DemesneStore(join(root, "state.sqlite"));
try {
  const { session } = store.createSession("Runtime check", root);
  const { turn } = store.createTurn(session.id, "Decode");
  const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNg+P8fhCAUADPaB/npjhoDAAAAAElFTkSuQmCC", "base64");
  const artifact = await ingestImage(store, { data, mimeType: "image/png" }, { sessionId: session.id, turnId: turn.id, toolCallId: "runtime", name: "runtime" }, 0);
  if (!(await readArtifact(store, artifact, true)).length) throw new Error("No decoded preview");
  console.log("Image runtime: decoded, persisted, and retrieved PNG successfully");
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
