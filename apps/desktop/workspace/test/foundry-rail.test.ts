import { expect, test } from "bun:test";
import type { FoundryArtifact } from "@demesne/protocol";
import { foundryOrder } from "../foundry-page.ts";
import { railHTML, railMarks, railMatches, railStep } from "../foundry-rail.ts";

const artifact = (id: string, title: string): FoundryArtifact =>
  ({ id, title, kind: "html", workspace: null, sessionId: null, createdAt: "", updatedAt: "", version: 1, description: "", basedOn: null });
const now = new Date();
const at = (daysAgo: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour).toISOString();

test("the rail has a tick per mockup in page order, grouped by day (pass 209 A)", () => {
  const list = [artifact("price", "Roaster pricing"), artifact("phone", "Roaster pricing, phone"), artifact("logo", "Blossom logo")];
  const versions = [
    { artifactId: "phone", version: 1, createdAt: at(0, 12), sessionId: null, note: "" },
    { artifactId: "price", version: 2, createdAt: at(0, 11), sessionId: null, note: "" },
    { artifactId: "price", version: 1, createdAt: at(0, 10), sessionId: null, note: "" },
    { artifactId: "logo", version: 4, createdAt: at(1, 15), sessionId: null, note: "" },
    { artifactId: "gone", version: 1, createdAt: at(1, 14), sessionId: null, note: "" },
  ];
  const marks = railMarks(foundryOrder(list, versions));
  expect(marks.map((mark) => [mark.id, mark.version, mark.versions, mark.day])).toEqual([
    ["phone", 1, 1, "Today"], ["price", 2, 2, "Today"], ["logo", 4, 1, "Yesterday"],
  ]);
  const html = railHTML(marks, "price");
  expect(html.match(/class="fr-day"/g)?.length).toBe(2);
  expect(html).toMatch(/class="fr-tk on" data-rail="price"[^>]*aria-current="true"/);
  expect(html).toContain("Roaster pricing<small>2 versions</small>");
  expect(foundryOrder(null, versions)).toEqual([]);
});

test("↑ ↓ step between mockups and stop at the ends; typing narrows by name", () => {
  const marks = railMarks([
    { id: "a", version: 1, title: "Roaster pricing", day: "Today" },
    { id: "b", version: 1, title: "Blossom logo", day: "Today" },
    { id: "c", version: 1, title: "Q1 launch deck", day: "Friday" },
  ]);
  expect(railStep(marks, "a", 1)?.id).toBe("b");
  expect(railStep(marks, "c", 1)?.id).toBe("c");
  expect(railStep(marks, "a", -1)?.id).toBe("a");
  expect(railStep(marks, null, -1)?.id).toBe("c");
  expect(railStep([], "a", 1)).toBeNull();
  expect(railMatches(marks, "LOGO").map((mark) => mark.id)).toEqual(["b"]);
  expect(railMatches(marks, "launch q1").map((mark) => mark.id)).toEqual(["c"]);
  const found = railHTML(marks, "a", "logo");
  expect(found).toContain('<div class="fr-find"><span>logo</span><small>Enter to go</small></div>');
  expect(found).not.toContain("fr-day");
  expect(found.match(/data-rail=/g)?.length).toBe(1);
  expect(railHTML(marks, "a", "zzz")).toContain("No mockup by that name");
});
