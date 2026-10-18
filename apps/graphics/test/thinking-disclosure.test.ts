import { expect, test } from "bun:test";

// Exercise the actual reasoning-entry renderer without booting the desktop host.
const source = await Bun.file(new URL("../live.ts", import.meta.url)).text();
const start = source.indexOf('    if (entry.type === "reasoning") {');
const end = source.indexOf('    if (entry.type === "tool") {', start);
const render = new Function("run", "detailsOpen", "detailsClosed", "active", "h", "thinkingBody", "spinner", "duration", `
  let body = "";
  const flush = () => {}, CHEVRON = "chevron ";
  const i = 0, entry = run.entries[i], key = run.id + ":" + entry.id;
  ${source.slice(start, end)}
  return body;
`);
const html = (status: string, raw: string, open: Set<string>, closed = new Set<string>()) => render(
  { id: "turn", status, entries: [{ id: 1, type: "reasoning", raw, durationMs: 3200 }] },
  open, closed, (run: { status: string }) => run.status === "running",
  (text: string) => text, (text: string) => text, () => "spinner", () => "3.2s",
) as string;

test("streaming thinking starts expanded and includes the complete trace", () => {
  const text = "First line\n\n" + "Detailed reasoning. ".repeat(50) + "\nLast line";
  const result = html("running", text, new Set());
  expect(result).not.toContain(' hidden>');
  expect(result).toContain('aria-expanded="true"');
  expect(result).toContain(text);
  expect(result).toContain("Collapse");
  expect(html("completed", text, new Set())).toContain('aria-expanded="false"');
});

test("manual collapse survives deltas; expansion survives completion", () => {
  const closed = new Set(["turn:1"]);
  for (const text of ["First", "Updated reasoning"]) {
    const result = html("running", text, new Set(), closed);
    expect(result).toContain(' hidden>');
    expect(result).toContain('aria-expanded="false"');
    expect(result).toContain("Show trace");
  }
  const open = new Set(["turn:1"]);
  closed.clear();
  for (const status of ["running", "completed"]) {
    const result = html(status, "Updated reasoning", open, closed);
    expect(result).not.toContain(' hidden>');
    expect(result).toContain('aria-expanded="true"');
  }
});
