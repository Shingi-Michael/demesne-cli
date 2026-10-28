/// The tree under a commit or merge step (pass 92): main as a fine pipe, the
/// branches not in it as lanes below, and the step played on it. Your files
/// line up, flow into the branch as sparks and become the commit; a merge
/// bends the branch back into main and the branch fades. No frame: the
/// step's guide holds it. Text never sits on the tree: every label is in one
/// column to its right, one per row. It plays once, live; history, a
/// reload or reduced motion show the finished tree.
import { createTimeline, stagger, svg as animeSvg, utils } from "animejs";

import type { RepoFlow, RepoLane } from "@demesne/protocol";

const LEFT = 8, MAIN_Y = 14, STEP = 50, LANE_GAP = 40, LANE_STEP = 36, BEND = 34, FILE_ROW = 15, FILES_TOP = 17;

export type FlowTone = "main" | "you" | "drive" | "other";
export interface FlowPath { d: string; tone: FlowTone; part: "main" | "main-new" | "lane" | "lane-new" | "join"; lane: number }
export interface FlowNode { x: number; y: number; tone: FlowTone; merge: boolean; fresh: boolean; lane: number }
export interface FlowRow { y: number; text: string; after: string | null; tone: FlowTone; lane: number }
export interface FlowFile { y: number; path: string; added: number; removed: number }
export interface FlowScene {
  width: number; height: number; labelX: number;
  paths: FlowPath[]; nodes: FlowNode[]; rows: FlowRow[]; files: FlowFile[]; moreFiles: number;
  /// Where the files land: the new commit's node.
  target: { x: number; y: number } | null;
  /// The lane that merged into main, if one did.
  merged: number | null;
  older: { y: number; count: number } | null;
  done: string;
}

const short = (path: string) => { const parts = path.split("/"); const tail = parts.slice(-2).join("/"); return tail.length > 30 ? `…${tail.slice(-29)}` : tail; };
const laneTone = (name: string, you: boolean): FlowTone => you ? "you" : name.startsWith("drive/") ? "drive" : "other";
const laneText = (name: string) => name.startsWith("drive/") ? `Drive · ${name.slice(6)}` : name;
/// "Foundry assembles a page (#339)" reads "#339 Foundry assembles a page".
export function commitWords(subject: string) {
  const pr = /\s*\(#(\d+)\)\s*$/.exec(subject);
  return pr ? `#${pr[1]} ${subject.slice(0, pr.index)}` : subject;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/// Lays out the tree from git before and after the step. Pure, so the
/// layout is tested on its own.
/// `settled` is the tree after the step: the files are in, so the rows
/// they waited on close up.
export function repoScene(flow: RepoFlow, { settled = false } = {}): FlowScene {
  const { before, after } = flow;
  const known = new Set(before.commits.map((commit) => commit.sha));
  const head = after.head ?? before.head;
  const onMain = !head || head === after.main;
  // Lanes: the branches before, then any new one (a branch's first commit).
  const names: string[] = [];
  for (const lane of [...before.lanes, ...after.lanes]) if (!names.includes(lane.name)) names.push(lane.name);
  const lanes = names.slice(0, 3).map((name) => {
    const was = before.lanes.find((lane) => lane.name === name), now = after.lanes.find((lane) => lane.name === name);
    const lane = (now ?? was)!;
    const seen = new Set(was?.commits.map((commit) => commit.sha) ?? []);
    return { lane, isNew: !was, merged: flow.command === "merge" && Boolean(was) && !now, fresh: lane.commits.map((commit) => !seen.has(commit.sha)) };
  });
  // main: the commits before the step keep their places; new ones go to
  // the right of every branch tip, so a merge bends forward into main.
  const xOf = new Map<string, number>();
  const old = after.commits.filter((commit) => known.has(commit.sha));
  old.forEach((commit, index) => xOf.set(commit.sha, LEFT + 20 + index * STEP));
  const lastOld = Math.max(LEFT + 20, ...[...xOf.values()]);
  const forkX = (lane: RepoLane) => lane.base && xOf.has(lane.base) ? xOf.get(lane.base)! : LEFT + 4;
  const laneX = lanes.map(({ lane }) => lane.commits.map((_, index) => forkX(lane) + BEND + 12 + index * LANE_STEP));
  const tips = laneX.map((xs) => xs.at(-1) ?? 0);
  const mergedTips = lanes.flatMap((item, index) => item.merged ? [tips[index]!] : []);
  let nextX = Math.max(lastOld + STEP, ...mergedTips.map((x) => x + STEP + 6));
  const freshMain = after.commits.filter((commit) => !known.has(commit.sha));
  for (const commit of freshMain) { xOf.set(commit.sha, nextX); nextX += STEP; }
  // Rows: main, then branches nearest first (the latest fork), so a farther
  // branch bends down before a nearer one starts and no pipes cross. Forks
  // from the same commit put your branch nearest.
  const mine = (index: number) => lanes[index]!.lane.name === head ? 0 : 1;
  const order = lanes.map((_, index) => index).sort((a, b) => forkX(lanes[b]!.lane) - forkX(lanes[a]!.lane) || mine(a) - mine(b));
  // The row the files wait on: -1 is main; below that, nowhere.
  const headLane = lanes.findIndex((item) => item.lane.name === head);
  const active = flow.command !== "commit" ? -2 : onMain ? -1 : headLane >= 0 ? headLane : -3;
  const fileRows = flow.command === "commit" && !settled ? before.files.length + (before.moreFiles ? 1 : 0) : 0;
  const rowY = new Map<number, number>();
  let y = MAIN_Y;
  rowY.set(-1, y);
  let grow = active === -1 ? fileRows * FILE_ROW : 0;
  for (const index of order) { y += LANE_GAP + grow; rowY.set(index, y); grow = active === index ? fileRows * FILE_ROW : 0; }
  const bottom = y + grow;
  const xs = [...xOf.values(), ...laneX.flat()];
  const right = Math.max(...xs, lastOld) + 18;
  const labelX = right + 22;
  const paths: FlowPath[] = [], nodes: FlowNode[] = [];
  const lastOldMain = old.length ? lastOld + 18 : LEFT + 40;
  paths.push({ d: `M${LEFT} ${MAIN_Y}H${Math.max(lastOldMain, ...lanes.map(({ lane }) => forkX(lane) + 6))}`, tone: "main", part: "main", lane: -1 });
  if (freshMain.length) paths.push({ d: `M${lastOldMain} ${MAIN_Y}H${right}`, tone: "main", part: "main-new", lane: -1 });
  for (const commit of after.commits) nodes.push({ x: xOf.get(commit.sha)!, y: MAIN_Y, tone: freshMain.includes(commit) && flow.command === "merge" ? "you" : "main", merge: commit.merge, fresh: !known.has(commit.sha), lane: -1 });
  let merged: number | null = null, target: FlowScene["target"] = null;
  lanes.forEach((item, index) => {
    const ly = rowY.get(index)!, fx = forkX(item.lane), tone = laneTone(item.lane.name, item.lane.name === head || item.merged);
    const firstFresh = item.fresh.indexOf(true);
    const stable = item.isNew ? -1 : firstFresh === -1 ? laneX[index]!.length - 1 : firstFresh - 1;
    const end = stable >= 0 ? laneX[index]![stable]! : fx + BEND + 6;
    paths.push({ d: `M${fx} ${MAIN_Y}C${fx + BEND * .7} ${MAIN_Y} ${fx + BEND * .3} ${ly} ${fx + BEND} ${ly}H${end}`, tone, part: item.isNew ? "lane-new" : "lane", lane: index });
    if (firstFresh !== -1 || item.isNew) paths.push({ d: `M${end} ${ly}H${tips[index]!}`, tone, part: "lane-new", lane: index });
    item.lane.commits.forEach((commit, at) => nodes.push({ x: laneX[index]![at]!, y: ly, tone, merge: commit.merge, fresh: item.fresh[at]!, lane: index }));
    if (item.merged) {
      merged = index;
      const mx = xOf.get(freshMain.at(-1)?.sha ?? "") ?? right, tx = tips[index]!;
      paths.push({ d: `M${tx} ${ly}C${tx + (mx - tx) * .55} ${ly} ${mx - (mx - tx) * .55} ${MAIN_Y} ${mx} ${MAIN_Y}`, tone, part: "join", lane: index });
    }
    if (index === active) target = { x: tips[index]!, y: ly };
  });
  if (active === -1 && freshMain.length) target = { x: xOf.get(freshMain.at(-1)!.sha)!, y: MAIN_Y };
  const newest = (lane: number) => lane === -1 ? freshMain.at(-1) : lanes[lane]?.lane.commits.at(-1);
  const rows: FlowRow[] = [{ y: MAIN_Y, text: after.main, tone: "main", lane: -1,
    after: freshMain.length ? `${after.main} · ${commitWords(newest(-1)!.subject)}` : null }];
  order.forEach((index) => {
    const item = lanes[index]!, tone = laneTone(item.lane.name, item.lane.name === head || item.merged);
    rows.push({ y: rowY.get(index)!, text: laneText(item.lane.name), tone, lane: index,
      after: index === active && item.fresh.includes(true) ? `${laneText(item.lane.name)} · ${commitWords(newest(index)!.subject)}` : null });
  });
  const filesY = active < -1 ? 0 : (rowY.get(active) ?? MAIN_Y) + FILES_TOP;
  const files = flow.command === "commit" && target && !settled ? before.files.map((file, index) => ({ y: filesY + index * FILE_ROW, path: short(file.path), added: file.added, removed: file.removed })) : [];
  const older = before.older + (lanes.length < names.length ? names.length - lanes.length : 0);
  const added = before.files.reduce((sum, file) => sum + file.added, 0), removed = before.files.reduce((sum, file) => sum + file.removed, 0);
  const committed = before.files.length + before.moreFiles;
  const branch = onMain ? after.main : head!;
  const done = flow.command === "commit"
    ? `Committed ${committed ? `${plural(committed, "file")} ` : ""}to ${laneText(branch)}${committed ? ` · +${added} −${removed}` : ""}`
    : merged !== null ? `Merged ${laneText(lanes[merged]!.lane.name)} into ${after.main}` : `Merged into ${after.main}`;
  return {
    width: labelX + 250, height: bottom + (older ? 30 : 10), labelX, paths, nodes, rows,
    files, moreFiles: files.length ? before.moreFiles : 0, target, merged,
    older: older ? { y: bottom + 22, count: older } : null, done,
  };
}

const NS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}
function text(parent: Element, x: number, y: number, words: string, className: string) {
  const node = el("text", { x, y: y + 4, class: className }, parent);
  node.textContent = words;
  return node;
}

/// The drawn tree for one step, kept across repaints so a running
/// animation is never cut off.
export class RepoFlowView {
  readonly element = document.createElement("div");
  private played = false;
  constructor(readonly flow: RepoFlow, private readonly command: string) {
    this.element.className = "repo-flow";
  }

  /// Draws the tree; `live` plays it once, otherwise it shows finished.
  render(live: boolean) {
    if (this.element.childElementCount) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const playing = live && !reduced && !this.played;
    this.draw(repoScene(this.flow, { settled: !playing }), playing);
  }

  private draw(scene: FlowScene, playing: boolean) {
    const svg = el("svg", { viewBox: `0 0 ${scene.width} ${scene.height}`, width: scene.width, height: scene.height, role: "img", "aria-label": scene.done });
    const tracks = el("g", { class: "rf-tracks" }, svg), pipes = el("g", { class: "rf-pipes" }, svg), dots = el("g", {}, svg), words = el("g", {}, svg), sparks = el("g", {}, svg);
    const pipeOf = new Map<FlowPath, SVGPathElement>();
    for (const path of scene.paths) {
      el("path", { d: path.d, class: `rf-track rf-${path.tone}` }, tracks);
      pipeOf.set(path, el("path", { d: path.d, class: `rf-pipe rf-${path.tone}`, "data-part": path.part, "data-lane": path.lane }, pipes));
    }
    const nodeOf = scene.nodes.map((node) => el("circle", { cx: node.x, cy: node.y, r: node.merge ? 3.6 : 2.8, class: `rf-node rf-${node.tone}${node.merge ? " rf-ring" : ""}` }, dots));
    const ring = scene.target ? el("circle", { cx: scene.target.x, cy: scene.target.y, r: 5.5, class: "rf-wait rf-you" }, dots) : null;
    const rowOf = scene.rows.map((row) => text(words, scene.labelX, row.y, row.text, `rf-row rf-t-${row.tone}`));
    const afterOf = scene.rows.map((row) => row.after ? text(words, scene.labelX, row.y, row.after, "rf-row rf-new") : null);
    const fileOf: SVGElement[] = scene.files.map((file) => {
      const g = el("g", { class: "rf-file" }, words);
      text(g, scene.labelX, file.y, file.path, "rf-path");
      text(g, scene.labelX + 186, file.y, `+${file.added}`, "rf-add");
      if (file.removed) text(g, scene.labelX + 222, file.y, `−${file.removed}`, "rf-del");
      return g;
    });
    if (scene.moreFiles) fileOf.push(text(words, scene.labelX, (scene.files.at(-1)?.y ?? 0) + FILE_ROW, `${scene.moreFiles} more`, "rf-path rf-file"));
    if (scene.older) text(words, LEFT, scene.older.y, `${plural(scene.older.count, "older branch")}`.replace("branchs", "branches"), "rf-older");
    const caption = document.createElement("div");
    caption.className = "rf-caption";
    const doing = document.createElement("span"), done = document.createElement("span");
    doing.textContent = this.command; done.textContent = scene.done;
    caption.append(doing, done);
    this.element.append(svg, caption);
    const mergedParts = scene.merged === null ? [] : [...pipeOf].filter(([path]) => path.lane === scene.merged).map(([, node]) => node);
    const finish = () => {
      for (const node of fileOf) node.style.opacity = "0";
      if (ring) ring.style.opacity = "0";
      scene.rows.forEach((row, index) => { if (row.after) { rowOf[index]!.style.opacity = "0"; afterOf[index]!.style.opacity = "1"; } });
      for (const node of mergedParts) node.style.opacity = ".18";
      scene.nodes.forEach((node, index) => { if (node.lane === scene.merged && node.lane !== -1) nodeOf[index]!.style.opacity = ".18"; });
      if (scene.merged !== null) rowOf[scene.rows.findIndex((row) => row.lane === scene.merged)]!.style.opacity = ".3";
      doing.style.opacity = "0"; done.style.opacity = "1";
    };
    if (!playing) { finish(); return; }
    this.played = true;
    const timeline = this.play(scene, { pipeOf, nodeOf, ring, rowOf, afterOf, fileOf, mergedParts, doing, done, sparks });
    // Once the files are in, the rows they waited on close up.
    if (scene.files.length) timeline.then(() => setTimeout(() => {
      this.element.replaceChildren();
      this.draw(repoScene(this.flow, { settled: true }), false);
      this.element.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }, 700));
  }

  private play(scene: FlowScene, parts: {
    pipeOf: Map<FlowPath, SVGPathElement>; nodeOf: SVGCircleElement[]; ring: SVGCircleElement | null;
    rowOf: SVGTextElement[]; afterOf: (SVGTextElement | null)[]; fileOf: SVGElement[]; mergedParts: SVGPathElement[];
    doing: HTMLSpanElement; done: HTMLSpanElement; sparks: SVGGElement;
  }) {
    const { pipeOf, nodeOf, ring, rowOf, afterOf, fileOf, mergedParts, doing, done, sparks } = parts;
    const pipes = (test: (path: FlowPath) => boolean) => [...pipeOf].filter(([path]) => test(path)).map(([, node]) => node);
    // Every pipe starts undrawn and draws on in its turn.
    const drawable = new Map([...pipeOf.values()].map((node) => [node, animeSvg.createDrawable(node)[0]!] as const));
    utils.set([...drawable.values()], { draw: "0 0" });
    const draw = (nodes: SVGPathElement[]) => nodes.map((node) => drawable.get(node)!);
    const nodes = (test: (node: FlowNode) => boolean) => scene.nodes.flatMap((node, index) => test(node) ? [nodeOf[index]!] : []);
    const t = createTimeline({ defaults: { ease: "inOutQuad" } });
    const hidden = (targets: Element[]) => { for (const node of targets) (node as SVGElement).style.opacity = "0"; };
    // Everything new starts out of sight.
    hidden([...nodeOf, ...rowOf, ...fileOf, ...afterOf.filter((node): node is SVGTextElement => Boolean(node)), done]);
    if (ring) hidden([ring]);
    const oldPipes = pipes((path) => path.part === "main" || path.part === "lane");
    // 1 · the tree draws itself
    t.add(draw(pipes((path) => path.part === "main")), { draw: ["0 0", "0 1"], duration: 520 }, 0);
    t.add(draw(oldPipes.filter((node) => node.dataset.part === "lane")), { draw: ["0 0", "0 1"], duration: 480, delay: stagger(90) }, 260);
    t.add(nodes((node) => !node.fresh), { opacity: [0, 1], scale: [0, 1], duration: 380, ease: "outBack(1.4)", delay: stagger(40) }, 300);
    t.add(rowOf, { opacity: [0, 1], duration: 260, delay: stagger(60) }, 520);
    let at = 900;
    // 2 · the files wait at your branch
    if (fileOf.length && ring && scene.target) {
      t.add(draw(pipes((path) => path.part === "lane-new" || (path.part === "main-new" && scene.merged === null))), { draw: ["0 0", "0 1"], duration: 420 }, at);
      t.add(ring, { opacity: [0, 1], scale: [0, 1], duration: 320, ease: "outBack(1.4)" }, at);
      t.add(ring, { rotate: [0, 120], duration: 1700, ease: "linear" }, at);
      t.add(fileOf, { opacity: [0, 1], translateX: [10, 0], duration: 300, delay: stagger(90), ease: "outQuad" }, at + 100);
      at += 1000;
      // 3 · they flow in as sparks and become the commit
      const target = scene.target;
      fileOf.forEach((file, index) => {
        const y = scene.files[index]?.y ?? scene.files.at(-1)!.y + FILE_ROW, spark = el("circle", { cx: 0, cy: 0, r: 1.8, class: "rf-spark rf-you" }, sparks);
        spark.style.opacity = "0";
        t.add(file, { opacity: [1, 0], translateX: [0, -8], duration: 220, ease: "inQuad" }, at + index * 70);
        t.add(spark, { translateX: [scene.labelX - 6, target.x], translateY: [y, target.y], opacity: [{ from: 0, to: 1, duration: 60 }, { to: 1, duration: 340 }, { to: 0, duration: 60 }], duration: 460, ease: "inOutCubic" }, at + index * 70 + 30);
      });
      at += 460 + fileOf.length * 70;
      t.add(ring, { opacity: [1, 0], scale: [1, 1.5], duration: 220 }, at - 80);
      t.add(nodes((node) => node.fresh && node.lane !== -1 || (node.fresh && scene.merged === null)), { opacity: [0, 1], scale: [1.35, 1], duration: 420, ease: "outBack(1.6)" }, at - 80);
      at += 260;
    }
    // 4 · a merge bends the branch back into main
    if (scene.merged !== null) {
      const join = pipes((path) => path.part === "join");
      t.add(draw(join), { draw: ["0 0", "0 1"], duration: 620 }, at);
      t.add(draw(pipes((path) => path.part === "main-new")), { draw: ["0 0", "0 1"], duration: 700 }, at + 200);
      for (const [index, path] of join.entries()) for (let k = 0; k < 3; k++) {
        const spark = el("circle", { cx: 0, cy: 0, r: 1.8, class: "rf-spark rf-you" }, sparks);
        spark.style.opacity = "0";
        t.add(spark, { ...animeSvg.createMotionPath(path), duration: 620, ease: "inOutSine" }, at + 120 + k * 120 + index * 60);
        t.add(spark, { opacity: [{ from: 0, to: 1, duration: 80 }, { to: 1, duration: 460 }, { to: 0, duration: 80 }], duration: 620, ease: "linear" }, at + 120 + k * 120 + index * 60);
      }
      at += 700;
      t.add(nodes((node) => node.fresh && node.lane === -1), { opacity: [0, 1], scale: [0, 1], duration: 440, ease: "outBack(1.6)" }, at);
      at += 300;
      t.add(mergedParts, { opacity: [1, .18], duration: 500, ease: "linear" }, at);
      t.add(nodes((node) => node.lane === scene.merged), { opacity: [1, .18], duration: 500, ease: "linear" }, at);
      const mergedRow = scene.rows.findIndex((row) => row.lane === scene.merged);
      if (mergedRow >= 0) t.add(rowOf[mergedRow]!, { opacity: [1, .3], duration: 400 }, at);
    } else if (!fileOf.length) {
      // A commit with nothing listed (or a fast-forward): the new commits draw on.
      t.add(draw(pipes((path) => path.part === "lane-new" || path.part === "main-new")), { draw: ["0 0", "0 1"], duration: 500 }, at);
      t.add(nodes((node) => node.fresh), { opacity: [0, 1], scale: [0, 1], duration: 420, ease: "outBack(1.6)", delay: stagger(80) }, at + 200);
      at += 700;
    }
    // The row says what landed, and the line under the tree what happened.
    scene.rows.forEach((row, index) => {
      if (!row.after) return;
      t.add(rowOf[index]!, { opacity: [1, 0], duration: 200 }, at);
      t.add(afterOf[index]!, { opacity: [0, 1], duration: 260 }, at + 120);
    });
    t.add(doing, { opacity: [1, 0], duration: 200 }, at + 200);
    t.add(done, { opacity: [0, 1], duration: 260 }, at + 320);
    t.add(sparks, { opacity: [1, 0], duration: 1 }, at + 600);
    return t;
  }
}
