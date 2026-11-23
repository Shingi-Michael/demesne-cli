/// Step 7: start a new mockup from one version of another.
import { expect, test } from "bun:test";
import { DemesneStore } from "@demesne/storage";
import { DemesneClient } from "../../../packages/client/src/index.ts";

test("a new mockup starts from one version: same kind, page, files and pictures, its own history, the first left as it was", () => {
  const store = new DemesneStore(":memory:");
  try {
    const first = store.saveFoundryArtifact({ kind: "html", title: "Orders", workspace: "/p", source: "<h1>v1</h1>", files: { "styles.css": "h1{}" }, description: "Orders.", stage: { surface: { frame: "window" } } as never });
    store.saveFoundryArtifact({ id: first.id, source: "<h1>v2</h1>" });
    const made = store.copyFoundryArtifact(first.id, 1);
    expect(made.id).not.toBe(first.id);
    expect(made).toMatchObject({ kind: "html", title: "Orders 2", workspace: "/p", version: 1, source: "<h1>v1</h1>", files: { "styles.css": "h1{}" }, description: "Orders.", basedOn: { id: first.id, version: 1 } });
    expect(made.versions[0]!.note).toBe("Started from Orders v1");
    // The next one takes the next free number; the newest version when none is named.
    const again = store.copyFoundryArtifact(made.id);
    expect(again.title).toBe("Orders 3");
    expect(store.copyFoundryArtifact(first.id).source).toBe("<h1>v2</h1>");
    expect(store.getFoundryArtifact(first.id)!.version).toBe(2);
    expect(() => store.copyFoundryArtifact("nope")).toThrow("not found");
  } finally { store.close(); }
});

test("the client can ask for it", () => {
  expect(typeof DemesneClient.prototype.foundryCopy).toBe("function");
});
