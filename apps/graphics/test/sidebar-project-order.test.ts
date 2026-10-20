import { expect, test } from "bun:test";
import { moveProject, orderedProjects } from "../sidebar-project-order.ts";

test("manual order survives changes to the active project and appends new projects", () => {
  expect(orderedProjects(["c", "b", "a", "d"], ["a", "b", "c"])).toEqual(["a", "b", "c", "d"]);
});

test("stale, duplicate and malformed stored entries cannot remove available projects", () => {
  expect(orderedProjects(["a", "b", "b", "c"], ["gone", "b", "b", 42, null])).toEqual(["b", "a", "c"]);
  for (const saved of [null, {}, "a", 123])
    expect(orderedProjects(["a", "b"], saved)).toEqual(["a", "b"]);
});

test("moves work in both directions and preserve projects hidden by search", () => {
  const paths = ["a", "hidden", "b", "c"];
  expect(moveProject(paths, "c", "a", false)).toEqual(["c", "a", "hidden", "b"]);
  expect(moveProject(paths, "a", "c", true)).toEqual(["hidden", "b", "c", "a"]);
  expect(moveProject(paths, "c", "b", false)).toEqual(["a", "hidden", "c", "b"]);
  expect(moveProject(paths, "a", "b", true)).toEqual(["hidden", "b", "a", "c"]);
  expect(paths).toEqual(["a", "hidden", "b", "c"]);
});

test("self-drops and unknown sources or targets leave the order unchanged", () => {
  const paths = ["a", "b"];
  expect(moveProject(paths, "a", "a", false)).toEqual(paths);
  expect(moveProject(paths, "outside", "a", true)).toEqual(paths);
  expect(moveProject(paths, "a", "outside", false)).toEqual(paths);
});
