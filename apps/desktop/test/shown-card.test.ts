import { expect, test } from "bun:test";
import { chatShown, latestShown, shownCardHTML, shownKind } from "../workspace/shown-card.ts";
import { chatPile } from "../workspace/shot-pile.ts";

const picture = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", width: 800, height: 600 };
const step = (toolCallId: string, name: string, message: Record<string, unknown>, state = "done") =>
  ({ type: "tool", toolCallId, name, state, input: {}, message: JSON.stringify(message) });
const figma = step("c1", "open", { shown: "window", name: "Figma", app: "Figma", title: "Roaster", kind: "app", picture });
const live = step("c2", "show", { shown: "app", name: "localhost:5173", url: "http://localhost:5173/", live: true });
const file = step("c3", "show", { shown: "file", name: "design.png", path: "design.png" });

test("the newest thing opened or shown gets the card; a closed one stays closed", () => {
  const all = chatShown([{ entries: [figma, live] }]);
  expect(all.map((one) => one.id)).toEqual(["c1", "c2"]);
  expect(latestShown(all, new Set())?.id).toBe("c2");
  expect(latestShown(all, new Set(["c2"]))).toBeNull();
  // A file goes to the file preview card instead.
  expect(latestShown(chatShown([{ entries: [figma, file] }]), new Set())).toBeNull();
  // A window with no picture has nothing to show.
  expect(latestShown(chatShown([{ entries: [step("c4", "open", { shown: "window", name: "Notes", app: "Notes", kind: "app" })] }]), new Set())).toBeNull();
  expect(chatShown([{ entries: [step("c5", "open", {}, "failed")] }])).toEqual([]);
});

test("the card: name, 4:3 preview, kind, Bring to front or Open, never the keyboard", () => {
  const [window, app] = chatShown([{ entries: [figma, live] }]);
  const html = shownCardHTML(window!, () => "data:image/png;base64,AQ==");
  expect(html).toContain("Roaster");
  expect(html).toContain('data-action="shown-front"');
  expect(html).toContain("Bring to front");
  expect(html).toContain('src="data:image/png;base64,AQ=="');
  expect(shownKind(window!)).toBe("App · opened behind");
  const liveHtml = shownCardHTML(app!, () => undefined);
  expect(liveHtml).toContain('class="card fp sh"');
  expect(liveHtml).toContain('<iframe src="http://localhost:5173/"');
  expect(liveHtml).toContain('tabindex="-1"');
  expect(liveHtml).toContain('class="pv-live"');
  expect(liveHtml).toContain("Open ↗");
});

test("earlier pictures fold into the screenshots pile", () => {
  const pile = chatPile([{ entries: [figma, live] }]);
  expect(pile).toEqual([{ id: picture.id, caption: "Roaster", by: "chat" }]);
});
