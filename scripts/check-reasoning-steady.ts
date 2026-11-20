/** Real Electron regression: thinking updates the working line without moving an
 * open checklist or reloading an inline preview. After prepare-desktop, run:
 *   bun scripts/check-reasoning-steady.ts [prepared app directory]
 * On headless Linux, prefix the command with xvfb-run -a. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const prompt = "Check the live preview against the plan";
const headings = ["Checking the preview", "Checking the input", "Finishing the check"];
const gates = headings.map(() => Promise.withResolvers<void>()), finish = Promise.withResolvers<void>();
let round = 0;
const f = await fixture({
  providerId: "fixture", modelId: "slow",
  async listModels() { return [{ id: "slow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    // The desktop may append a system note to the user's message.
    if (String(messages.findLast(m => m.role === "user")?.content).split("\n")[0] !== prompt) {
      yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" }; return;
    }
    switch (round++) {
      case 0:
        yield { type: "tool_call_delta", index: 0, idDelta: "plan", nameDelta: "update_plan", argumentsDelta: JSON.stringify({ steps: [{ step: "Check the preview", status: "in_progress" }, { step: "Report back", status: "pending" }] }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      case 1:
        yield { type: "tool_call_delta", index: 0, idDelta: "server", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: [process.execPath, "serve.ts"], background: true }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      default:
        for (const [i, heading] of headings.entries()) {
          await gates[i]!.promise;
          yield { type: "reasoning_delta", delta: `**${heading}**\n\n` };
        }
        await finish.promise;
        yield { type: "text_delta", delta: "The preview is ready." }; yield { type: "finish", reason: "stop" };
    }
  },
});
writeFileSync(join(f.workspace, "serve.ts"), `const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<input aria-label="Preview draft">', { headers: { 'content-type': 'text/html' } }) });\nconsole.log('Local: http://127.0.0.1:' + server.port + '/');\n`);
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  desktop = await electron.launch({ args: [resolve(process.argv[2] ?? "apps/desktop/build/app"), `--user-data-dir=${join(f.root, "e")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env: { ...f.env, DEMESNE_GLASS: "0", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") } });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20_000);
  await page.locator("#app:not([hidden])").waitFor();
  await page.locator("textarea").fill(prompt); await page.locator("textarea").press("Enter");
  const turn = page.locator("#conversation .turn").last(), frame = turn.locator(".pv-view iframe");
  const allow = page.locator('#approval [data-action="permission"][data-args*="allow_once"]');
  await allow.or(frame).first().waitFor();
  if (await allow.isVisible()) await allow.click();
  await page.locator('#cards [data-card="preview"]').waitFor();
  await turn.locator(".pr-bar").click();
  const draft = frame.contentFrame().getByRole("textbox", { name: "Preview draft" });
  await draft.fill("Keep this unsent text");
  const read = await turn.evaluateHandle(node => {
    const shell = node.querySelector(".response")!, ribbon = shell.querySelector(".plan-ribbon")!, iframe = shell.querySelector("iframe")!;
    let ribbonMoves = 0, loads = 0;
    const watch = new MutationObserver(records => { for (const r of records) if ([...r.removedNodes].includes(ribbon)) ribbonMoves++; });
    watch.observe(node, { childList: true, subtree: true });
    node.addEventListener("load", event => { if (event.target instanceof HTMLIFrameElement) loads++; }, true);
    return () => ({ sameShell: shell === node.querySelector(".response"), sameFrame: iframe === node.querySelector("iframe"), ribbonMoves, loads });
  });
  // Start the thought, then extend it. Wait for each heading on the real working
  // line so the renderer can't batch all three chunks into an unobserved update.
  for (const [i, heading] of headings.entries()) {
    gates[i]!.resolve();
    await turn.locator(".wl-word:not(.out)", { hasText: heading }).first().waitFor();
    assert.deepEqual(await read.evaluate(stats => stats()), { sameShell: true, sameFrame: true, ribbonMoves: 0, loads: 0 }, `redraw on reasoning chunk ${i + 1}`);
    assert.equal(await draft.inputValue(), "Keep this unsent text");
  }
  finish.resolve();
  await turn.getByText("The preview is ready.", { exact: true }).waitFor();
  await turn.locator(".plan-ribbon.ended").waitFor();
  console.log("PASS: streamed reasoning updates the working line without moving the checklist or reloading the preview.");
} finally {
  for (const gate of gates) gate.resolve(); finish.resolve();
  await desktop?.close().catch(() => {});
  await f.close();
}
