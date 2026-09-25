import sharp from "sharp";
import { createPainter, SLASH_COMMANDS } from "../packages/brand/src/index.ts";
import { Workbench } from "../apps/cli/src/workbench/controller.ts";
import { CliContextRail } from "../apps/cli/src/context-rail.ts";
import type { ImageArtifact } from "@demesne/protocol";

const png = await sharp(Buffer.from(`<svg width="640" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="400" fill="#090f14"/><circle cx="320" cy="180" r="110" fill="#00d4ff"/><circle cx="360" cy="140" r="45" fill="#ffb700"/><text x="190" y="350" fill="#c8dae8" font-size="36">demesne preview</text></svg>`)).png().toBuffer();
let queue = "";
const ui = new Workbench({ paint: createPainter(!process.argv.includes("--plain")), contextRail: new CliContextRail({ id: "fixture", provider: "demo" }, process.cwd()),
  sessionTitle: "Image preview fixture", version: "preview", onExit: () => { ui.stop(); process.exit(0); }, onInterrupt: () => {},
  queue: { get: () => queue, set: (value) => { queue = value; } },
  preview: { content: async () => png, open: async () => { throw new Error("Fixture: no saved original. Use a daemon-backed artifact to open its file."); } } });
ui.setArtifactSession("fixture");
ui.beginTurn({ userText: "Preview a generated image", at: "now" });
ui.assistantDelta("The fixture image is available in Preview. Alt+V opens it; Tab selects controls, Enter activates, and Escape closes it.");
ui.finishTurn("completed", "Fixture ready");
const artifact: ImageArtifact = { id: "fixture-image", kind: "image", sessionId: "fixture", turnId: "fixture-turn", toolCallId: "fixture-tool",
  createdAt: new Date().toISOString(), filename: "preview.png", mimeType: "image/png", width: 640, height: 400, byteLength: png.length,
  sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"), source: { kind: "tool", name: "fixture", modelId: null }, revisionOf: null };
ui.addArtifact(artifact);
const input = ui as unknown as { onKeypress(text: string, key: { name?: string; meta?: boolean }): void };
// Auto-open may already have opened it on a wide terminal.
const state = ui as unknown as { preview: { open: boolean; focused: boolean } };
if (!state.preview.open) input.onKeypress("", { name: "v", meta: true });
state.preview.focused = true;
const snapshot = process.argv.find((arg) => arg.startsWith("--snapshot="))?.slice(11);
if (snapshot) {
  const [width, height] = snapshot.split("x").map(Number);
  console.log(ui.frame(width ?? 80, height ?? 24).rows.join("\n"));
} else {
  if (!process.stdout.isTTY) throw new Error("Use --snapshot=120x36 --plain outside an interactive terminal");
  process.on("SIGTERM", () => { ui.stop(); process.exit(0); });
  ui.start();
  while (true) {
    const value = await ui.readPrompt({ commands: SLASH_COMMANDS, mentions: [], history: [] });
    if (value === "/exit") { ui.stop(); break; }
    ui.notice("Preview fixture: use Alt+V to inspect the image, or /exit.");
  }
}
