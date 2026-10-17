import { expect, test } from "bun:test";

// Exercise the actual reasoning-entry renderer without booting the desktop host.
const source = await Bun.file(new URL("../live.ts", import.meta.url)).text();
const start = source.indexOf('    if (entry.type === "reasoning") {');
const end = source.indexOf('    if (entry.type === "tool") {', start);
const render = new Function("run", "detailsOpen", "active", "h", "thinkingBody", "spinner", "duration", `
  let body = "";
  const flush = () => {}, CHEVRON = "chevron ";
  const i = 0, entry = run.entries[i], key = run.id + ":" + entry.id;
  ${source.slice(start, end)}
  return body;
`);
const html = (status: string, raw: string, open: Set<string>) => render(
  { id: "turn", status, entries: [{ id: 1, type: "reasoning", raw, durationMs: 3200 }] },
  open, (run: { status: string }) => run.status === "running",
  (text: string) => text, (text: string) => text, () => "spinner", () => "3.2s",
) as string;

test("main thinking stays collapsed during streaming and after completion", () => {
  const open = new Set<string>();
  for (const [status, text] of [["running", "First"], ["running", "More reasoning"], ["completed", "Finished"]]) {
    const result = html(status!, text!, open);
    expect(result).toContain(' hidden>');
    expect(result).toContain('aria-expanded="false"');
    expect(result).toContain(status === "running" ? "spinnerThinking" : "chevron Thought for 3.2s");
  }
});

test("manual expansion survives updates and completion; collapse stays closed", () => {
  const open = new Set(["turn:1"]);
  for (const status of ["running", "completed"]) {
    const result = html(status, "Updated reasoning", open);
    expect(result).not.toContain(' hidden>');
    expect(result).toContain('aria-expanded="true"');
  }
  open.delete("turn:1");
  expect(html("running", "Next delta", open)).toContain('aria-expanded="false"');
});
