import { expect, test } from "bun:test";
import { lookChange, lookWords } from "../self-build.ts";

test("a turn's files say whether the window, the engine, or both changed", () => {
  expect(lookChange(["apps/desktop/workspace.css"])).toBe("window");
  expect(lookChange(["apps/desktop/workspace/live.ts", "apps/desktop/index.html"])).toBe("window");
  expect(lookChange(["apps/daemon/src/app.ts"])).toBe("engine");
  expect(lookChange(["packages/protocol/src/index.ts"])).toBe("engine");
  expect(lookChange(["apps/desktop/electron/main.ts"])).toBe("engine");
  expect(lookChange(["apps/desktop/host.ts", "apps/desktop/workspace/host.ts"])).toBe("engine");
  expect(lookChange(["apps/desktop/workspace.css", "apps/daemon/src/app.ts"])).toBe("both");
  expect(lookChange(["README.md", "docs/desktop.md", "apps/desktop/workspace/test/live.test.ts"])).toBeNull();
  expect(lookChange([])).toBeNull();
});

test("paths may be absolute under the project", () => {
  expect(lookChange(["/Users/mike/projects/demesne-cli/apps/desktop/workspace.css"], "/Users/mike/projects/demesne-cli")).toBe("window");
  expect(lookChange(["/Users/mike/projects/demesne-cli/apps/desktop/workspace.css"], "/Users/mike/projects/demesne-cli/")).toBe("window");
  expect(lookChange(["./apps/desktop/workspace.css"])).toBe("window");
  expect(lookChange(["/elsewhere/apps/desktop/workspace.css"], "/Users/mike/projects/demesne-cli")).toBeNull();
});

test("the line's words follow where the look stands", () => {
  expect(lookWords({ kind: "installed" })).toBe("");
  expect(lookWords({ kind: "building", project: "/p" })).toBe("Rebuilding the window");
  expect(lookWords({ kind: "trial", project: "/p", keep: true })).toBe("You’re looking at it now · Keep or Go back is in the top bar");
  expect(lookWords({ kind: "trial", project: "/p", keep: false })).toBe("You’re looking at it now · Go back is in the top bar");
  expect(lookWords({ kind: "broken", project: "/p", why: "x" })).toBe("Your change didn’t load, so Demesne went back");
  expect(lookWords({ kind: "kept", project: "/p" })).toBe("Kept · it opens the next time Demesne starts");
});
