import { expect, test } from "bun:test";
import type { RepoCommit, RepoFlow, RepoSnapshot } from "@demesne/protocol";
import { commitWords, laneText, repoScene, type FlowScene } from "../repo-flow.ts";

const c = (sha: string, subject = sha, merge = false): RepoCommit => ({ sha: sha.padEnd(8, "0"), subject, merge });
const snap = (part: Partial<RepoSnapshot>): RepoSnapshot => ({ main: "main", head: "main", tip: "t", commits: [], lanes: [], older: 0, files: [], moreFiles: 0, ...part });
const main = [c("a1", "Settings page (#336)"), c("a2", "Proof marks removed (#337)"), c("a3", "CI and hot reload (#338)")];
const drive = { name: "drive/fix-smoke-1a2b", base: main[0]!.sha, commits: [c("d1"), c("d2")], worktree: true };

/// Every x a pipe or a dot reaches.
const xs = (scene: FlowScene) => [...scene.nodes.map((node) => node.x), ...scene.paths.flatMap((path) => [...path.d.matchAll(/-?\d+(?:\.\d+)?/g)].filter((_, index) => index % 2 === 0).map((match) => Number(match[0])))];

test("a commit on your branch: files wait on its row and flow into a new commit", () => {
  const before = snap({ head: "claude/el20ji", commits: main, lanes: [drive], tip: "x",
    files: [{ path: "apps/desktop/electron/foundry-assemble.ts", added: 104, removed: 0 }, { path: "policy.ts", added: 18, removed: 3 }], moreFiles: 3 });
  const after = snap({ head: "claude/el20ji", commits: main, tip: "y",
    lanes: [{ name: "claude/el20ji", base: main[2]!.sha, commits: [c("y1", "Foundry assembles a page")], worktree: false }, drive] });
  const scene = repoScene({ command: "commit", before, after });
  const you = scene.rows.find((row) => row.text === "claude/el20ji")!;
  expect(you.tone).toBe("you");
  expect(you.after).toBe("Foundry assembles a…");
  expect(scene.rows.map((row) => row.text)).toEqual(["main", "claude/el20ji", "fix-smoke"]);
  expect(scene.files.map((file) => file.path)).toEqual(["electron/foundry-assemble.ts", "policy.ts"]);
  expect(scene.moreFiles).toBe(3);
  expect(scene.target).toEqual({ x: expect.any(Number), y: you.y });
  expect(scene.nodes.filter((node) => node.fresh)).toHaveLength(1);
  expect(scene.done).toBe("Committed 5 files to claude/el20ji  +122 −3");
});

test("text never sits on the tree: every label is right of every pipe and rows don't collide", () => {
  const before = snap({ head: "feature", commits: main, lanes: [drive, { name: "feature", base: main[2]!.sha, commits: [c("f1")], worktree: false }],
    files: [1, 2, 3, 4, 5].map((n) => ({ path: `f${n}.ts`, added: n, removed: 0 })), moreFiles: 2 });
  const after = { ...before, files: [], moreFiles: 0, lanes: [drive, { ...before.lanes[1]!, commits: [c("f1"), c("f2", "Next")] }] };
  const scene = repoScene({ command: "commit", before, after });
  expect(Math.max(...xs(scene))).toBeLessThan(scene.labelX - 10);
  const ys = [...scene.rows.map((row) => row.y), ...scene.files.map((file) => file.y), scene.files.at(-1)!.y + 15].sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(13);
});

test("branches nearest main are the latest forks, so no pipes cross", () => {
  const late = { name: "late", base: main[2]!.sha, commits: [c("l1")], worktree: false };
  const scene = repoScene({ command: "commit", before: snap({ commits: main, lanes: [drive, late] }), after: snap({ commits: main, lanes: [drive, late], tip: "z" }) });
  const y = (name: string) => scene.rows.find((row) => row.text.includes(name))!.y;
  expect(y("late")).toBeLessThan(y("fix-smoke"));
});

test("a merge bends the branch into a new main commit ahead of its tip", () => {
  const lane = { name: "feature", base: main[1]!.sha, commits: [c("f1"), c("f2")], worktree: false };
  const flow: RepoFlow = { command: "merge", before: snap({ commits: main, lanes: [lane, drive] }),
    after: snap({ commits: [...main.slice(1), c("m1", "Foundry assembles a page (#339)", true)], lanes: [drive], tip: "m" }) };
  const scene = repoScene(flow);
  expect(scene.merged).toBe(0);
  const join = scene.paths.find((path) => path.part === "join")!;
  const merge = scene.nodes.find((node) => node.fresh && node.lane === -1)!;
  expect(merge.merge).toBe(true);
  expect(join.d.endsWith(`${merge.x} ${merge.y}`)).toBe(true);
  expect(merge.x).toBeGreaterThan(Math.max(...scene.nodes.filter((node) => node.lane === 0).map((node) => node.x)));
  expect(scene.rows[0]!.after).toBe("#339 Foundry assembles a page");
  expect(scene.done).toBe("Merged feature into main");
  expect(scene.files).toEqual([]);
});

test("a commit straight onto main lands on main's row", () => {
  const scene = repoScene({ command: "commit", before: snap({ commits: main, files: [{ path: "a.ts", added: 1, removed: 1 }] }),
    after: snap({ commits: [...main, c("n1", "Fix")], tip: "n" }) });
  expect(scene.target).toEqual({ x: scene.nodes.at(-1)!.x, y: scene.rows[0]!.y });
  expect(scene.files[0]!.y).toBeGreaterThan(scene.rows[0]!.y);
  expect(scene.rows[0]!.after).toBe("Fix");
  expect(scene.done).toBe("Committed 1 file to main  +1 −1");
});

test("commit words lead with the PR number", () => {
  expect(commitWords("Foundry assembles a page (#339)")).toBe("#339 Foundry assembles a page");
  expect(commitWords("Plain")).toBe("Plain");
});

test("branches forked from the same commit put yours nearest main", () => {
  const other = { name: "drive/fix-a", base: main[2]!.sha, commits: [c("o1")], worktree: false };
  const mine = { name: "feature", base: main[2]!.sha, commits: [c("m1")], worktree: false };
  const scene = repoScene({ command: "commit", before: snap({ head: "feature", commits: main, lanes: [other] }), after: snap({ head: "feature", commits: main, lanes: [other, mine], tip: "z" }) });
  expect(scene.rows.map((row) => row.text)).toEqual(["main", "feature", "fix-a"]);
});

test("settled, the files are in and the rows close up", () => {
  const lane = { name: "feature", base: main[2]!.sha, commits: [c("f1")], worktree: false };
  const flow: RepoFlow = { command: "commit", before: snap({ head: "feature", commits: main, lanes: [lane, drive], files: [{ path: "a.ts", added: 2, removed: 0 }, { path: "b.ts", added: 1, removed: 1 }] }),
    after: snap({ head: "feature", commits: main, lanes: [{ ...lane, commits: [c("f1"), c("f2", "Next")] }, drive], tip: "z" }) };
  const playing = repoScene(flow), settled = repoScene(flow, { settled: true });
  expect(settled.files).toEqual([]);
  expect(settled.height).toBeLessThan(playing.height);
  expect(settled.done).toBe(playing.done);
  expect(settled.rows.at(-1)!.y - settled.rows.at(-2)!.y).toBe(settled.rows[1]!.y - settled.rows[0]!.y);
});

test("your branch's first commit shows even beside three others", () => {
  const others = ["drive/a", "b", "c"].map((name) => ({ name, base: main[0]!.sha, commits: [c(`${name}1`)], worktree: false }));
  const mine = { name: "feature", base: main[2]!.sha, commits: [c("m1", "First")], worktree: false };
  const scene = repoScene({ command: "commit", before: snap({ head: "feature", commits: main, lanes: others, files: [{ path: "a.ts", added: 1, removed: 0 }] }),
    after: snap({ head: "feature", commits: main, lanes: [mine, ...others.slice(0, 2)], tip: "z" }) });
  expect(scene.rows.some((row) => row.text === "feature")).toBe(true);
  expect(scene.target).not.toBeNull();
});

test("a width spreads the tree across it; labels keep their column", () => {
  const flow: RepoFlow = { command: "commit", before: snap({ commits: main, lanes: [drive] }), after: snap({ commits: [...main, c("n1")], lanes: [drive], tip: "n" }) };
  const natural = repoScene(flow), wide = repoScene(flow, { width: 760 }), narrow = repoScene(flow, { width: natural.width - 40 });
  expect(wide.width).toBeLessThanOrEqual(760);
  expect(wide.width).toBeGreaterThan(740);
  expect(wide.width - wide.labelX).toBe(natural.width - natural.labelX);
  expect(narrow.width).toBeLessThanOrEqual(natural.width - 40);
  expect(repoScene(flow, { width: 0 })).toEqual(natural);
  const long = repoScene({ ...flow, after: { ...flow.after, commits: [...main, c("n1", "x".repeat(80))] } });
  expect(long.rows[0]!.after!.length).toBeLessThanOrEqual(40);
  expect(long.rows[0]!.after!.endsWith("…")).toBe(true);
});

test("Drive's branches lose their prefix and random tail; long names cut at a word", () => {
  expect(laneText("drive/investigate-check-macos-release-signing-read-819c")).toBe("investigate-check-macos…");
  expect(laneText("drive/fix-paths-1a2b")).toBe("fix-paths");
  expect(laneText("codex/foundry-inline")).toBe("codex/foundry-inline");
});
