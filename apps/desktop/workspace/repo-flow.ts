/// A real Git snapshot, replayed after success. The whole tree draws once;
/// branch names, commit details and file evidence live outside the paths.
import type { RepoFlow, RepoLane, RepoCommit, RepoFile } from "@demesne/protocol";

const LEFT = 8, MAIN_Y = 58, STEP = 50, LANE_GAP = 68, LANE_STEP = 36, BEND = 34;

export type FlowTone = "main" | "you" | "drive" | "other";
export interface FlowPath { d: string; tone: FlowTone; part: "main" | "main-new" | "lane" | "lane-new" | "join"; lane: number }
export interface FlowNode { x: number; y: number; tone: FlowTone; merge: boolean; fresh: boolean; lane: number; sha: string; subject: string }
export interface FlowRow { y: number; text: string; after: string | null; tone: FlowTone; lane: number }
export type FlowFile = RepoFile;
export interface FlowScene {
  width: number; height: number; labelX: number;
  paths: FlowPath[]; nodes: FlowNode[]; rows: FlowRow[]; files: FlowFile[]; moreFiles: number;
  /// The new commit's node.
  target: { x: number; y: number } | null;
  /// The lane that merged into main, if one did.
  merged: number | null;
  /// Branches not drawn, counted in the frame's top line.
  older: number;
  done: string;
  commit: RepoCommit | null;
}

const laneTone = (name: string, you: boolean): FlowTone => you ? "you" : name.startsWith("drive/") ? "drive" : "other";
export const laneText = (name: string) => name;
/// "Foundry assembles a page (#339)" reads "#339 Foundry assembles a page".
export function commitWords(subject: string) {
  const pr = /\s*\(#(\d+)\)\s*$/.exec(subject);
  return pr ? `#${pr[1]} ${subject.slice(0, pr.index)}` : subject;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/// Lays out the tree from git before and after the step. Pure, so the
/// layout is tested on its own.
/// How far apart things sit.
interface Spacing { step: number; laneStep: number; bend: number; laneGap: number; labels: number }
/// All text lives outside the graph; only a small trailing margin remains.
const LABELS = 0;
/// Fit the graph to its container. Settled and playing use identical geometry;
/// files and full branch labels wrap independently below it.
export function repoScene(flow: RepoFlow, { settled = false, width = 0, roomy = false } = {}): FlowScene {
  const labels = LABELS;
  const at = (k: number) => layout(flow, settled, { step: STEP * k, laneStep: LANE_STEP * k, bend: BEND * Math.min(2, k), laneGap: roomy ? 84 : LANE_GAP, labels });
  let scene = at(1);
  if (!width || Math.abs(width - scene.width) < 1) return scene;
  // Narrower than its own size, it closes up (to under half).
  let low = .05, high = Math.max(8, width / STEP);
  scene = at(low);
  for (let round = 0; round < 14; round++) {
    const k = (low + high) / 2, next = at(k);
    if (next.width <= width) { low = k; scene = next; } else high = k;
  }
  return scene;
}

function layout(flow: RepoFlow, settled: boolean, { step, laneStep, bend, laneGap, labels }: Spacing): FlowScene {
  const { before, after } = flow;
  const known = new Set(before.commits.map((commit) => commit.sha));
  const head = after.head ?? before.head;
  const onMain = !head || head === after.main;
  // Lanes: the branches before, then any new one (a branch's first commit).
  const names: string[] = [];
  // The branch you're on always shows, even on its first commit.
  const all = [...before.lanes, ...after.lanes];
  for (const lane of [...all.filter((lane) => lane.name === head), ...all]) if (!names.includes(lane.name)) names.push(lane.name);
  const lanes = names.slice(0, 3).map((name) => {
    const was = before.lanes.find((lane) => lane.name === name), now = after.lanes.find((lane) => lane.name === name);
    const lane = (now ?? was)!;
    const seen = new Set(was?.commits.map((commit) => commit.sha) ?? []);
    return { lane, isNew: !was, merged: flow.command === "merge" && onMain && Boolean(was) && !now && (!flow.result || flow.result.commit.parents?.includes(was!.commits.at(-1)!.sha) || flow.result.commit.sha === was!.commits.at(-1)!.sha), fresh: lane.commits.map((commit) => !seen.has(commit.sha)) };
  });
  // main: the commits before the step keep their places; new ones go to
  // the right of every branch tip, so a merge bends forward into main.
  const xOf = new Map<string, number>();
  const old = after.commits.filter((commit) => known.has(commit.sha));
  old.forEach((commit, index) => xOf.set(commit.sha, LEFT + 20 + index * step));
  const lastOld = Math.max(LEFT + 20, ...[...xOf.values()]);
  const forkX = (lane: RepoLane) => lane.base && xOf.has(lane.base) ? xOf.get(lane.base)! : LEFT + 4;
  const laneX = lanes.map(({ lane }) => lane.commits.map((_, index) => forkX(lane) + bend + 12 + index * laneStep));
  const tips = laneX.map((xs) => xs.at(-1) ?? 0);
  const mergedTips = lanes.flatMap((item, index) => item.merged ? [tips[index]!] : []);
  let nextX = Math.max(lastOld + step, ...mergedTips.map((x) => x + step + 6));
  const freshMain = after.commits.filter((commit) => !known.has(commit.sha));
  for (const commit of freshMain) { xOf.set(commit.sha, nextX); nextX += step; }
  // Rows: main, then branches nearest first (the latest fork), so a farther
  // branch bends down before a nearer one starts and no pipes cross. Forks
  // from the same commit put your branch nearest.
  const mine = (index: number) => lanes[index]!.lane.name === head ? 0 : 1;
  const order = lanes.map((_, index) => index).sort((a, b) => forkX(lanes[b]!.lane) - forkX(lanes[a]!.lane) || mine(a) - mine(b));
  // The active branch: -1 is main.
  const headLane = lanes.findIndex((item) => item.lane.name === head);
  const active = flow.command !== "commit" ? -2 : onMain ? -1 : headLane >= 0 ? headLane : -3;
  const rowY = new Map<number, number>();
  let y = MAIN_Y;
  rowY.set(-1, y);
  for (const index of order) { y += laneGap; rowY.set(index, y); }
  const bottom = y;
  const xs = [...xOf.values(), ...laneX.flat()];
  const right = Math.max(...xs, lastOld) + 18;
  const labelX = right + 22;
  const paths: FlowPath[] = [], nodes: FlowNode[] = [];
  const lastOldMain = old.length ? lastOld + 18 : LEFT + 40;
  paths.push({ d: `M${LEFT} ${MAIN_Y}H${Math.max(lastOldMain, ...lanes.map(({ lane }) => forkX(lane) + 6))}`, tone: "main", part: "main", lane: -1 });
  if (freshMain.length) paths.push({ d: `M${lastOldMain} ${MAIN_Y}H${right}`, tone: "main", part: "main-new", lane: -1 });
  for (const commit of after.commits) nodes.push({ x: xOf.get(commit.sha)!, y: MAIN_Y, tone: freshMain.includes(commit) && flow.command === "merge" ? "you" : "main", merge: commit.merge, fresh: !known.has(commit.sha), lane: -1, sha: commit.sha, subject: commit.subject });
  let merged: number | null = null, target: FlowScene["target"] = null;
  lanes.forEach((item, index) => {
    const ly = rowY.get(index)!, fx = forkX(item.lane), tone = laneTone(item.lane.name, item.lane.name === head || item.merged);
    const firstFresh = item.fresh.indexOf(true);
    const stable = item.isNew ? -1 : firstFresh === -1 ? laneX[index]!.length - 1 : firstFresh - 1;
    const end = stable >= 0 ? laneX[index]![stable]! : fx + bend + 6;
    paths.push({ d: item.lane.base && xOf.has(item.lane.base) ? `M${fx} ${MAIN_Y}C${fx + bend * .7} ${MAIN_Y} ${fx + bend * .3} ${ly} ${fx + bend} ${ly}H${end}` : `M${LEFT} ${ly}H${end}`, tone, part: item.isNew ? "lane-new" : "lane", lane: index });
    if (firstFresh !== -1 || item.isNew) paths.push({ d: `M${end} ${ly}H${tips[index]!}`, tone, part: "lane-new", lane: index });
    item.lane.commits.forEach((commit, at) => nodes.push({ x: laneX[index]![at]!, y: ly, tone, merge: commit.merge, fresh: item.fresh[at]!, lane: index, sha: commit.sha, subject: commit.subject }));
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
    after: freshMain.length ? newest(-1)!.subject : null }];
  order.forEach((index) => {
    const item = lanes[index]!, tone = laneTone(item.lane.name, item.lane.name === head || item.merged);
    rows.push({ y: rowY.get(index)!, text: laneText(item.lane.name), tone, lane: index,
      after: item.lane.name === head && item.fresh.includes(true) ? newest(index)!.subject : null });
  });
  const evidence = flow.result;
  const files = evidence?.files ?? (flow.command === "commit" ? before.files : []);
  const moreFiles = evidence?.moreFiles ?? (flow.command === "commit" ? before.moreFiles : 0);
  const commit = evidence?.commit ?? [...after.commits, ...after.lanes.flatMap(lane => lane.commits)].find(commit => commit.sha === after.tip)
    ?? (onMain ? freshMain.at(-1) : after.lanes.find(lane => lane.name === head)?.commits.at(-1)) ?? null;
  // A merge into a feature branch joins a known parent on main to that branch.
  if (flow.command === "merge" && !onMain && headLane >= 0 && commit?.parents) {
    const parent = commit.parents.slice(1).find(sha => xOf.has(sha));
    if (parent) {
      const px = xOf.get(parent)!, tx = tips[headLane]!, ty = rowY.get(headLane)!;
      paths.push({ d: `M${px} ${MAIN_Y}C${px + (tx - px) * .55} ${MAIN_Y} ${tx - (tx - px) * .55} ${ty} ${tx} ${ty}`, tone: "you", part: "join", lane: headLane });
    }
  }
  const older = before.older + (lanes.length < names.length ? names.length - lanes.length : 0);
  // Old truncated snapshots cannot supply a complete line total.
  const totals = evidence?.totals ?? before.fileTotals ?? (before.moreFiles ? null : before.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }));
  const committed = files.length + moreFiles;
  const branch = onMain ? after.main : head!;
  const done = flow.command === "commit"
    ? `Committed ${committed ? `${plural(committed, "file")} ` : ""}to ${laneText(branch)}${committed && totals ? `  +${totals.added} −${totals.removed}` : ""}`
    : merged !== null ? `Merged ${laneText(lanes[merged]!.lane.name)} into ${laneText(branch)}` : `Merged into ${laneText(branch)}`;
  return {
    width: labelX + labels, height: bottom + 30, labelX, paths, nodes, rows,
    files, moreFiles, target, merged,
    older, done, commit,
  };
}

const NS = "http://www.w3.org/2000/svg";
const FRAME_PAD = 14;
const DURATION = 3200;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - (1 - clamp(n)) ** 3;
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.append(node);
  return node;
}
function html<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, words: string, parent: Element): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = words;
  parent.append(node);
  return node;
}

/// Main-line hashes have their own band above every path. Reserve actual
/// label-sized intervals, prioritizing the new commit, even in a narrow pane.
export function repoHashLabels(scene: FlowScene) {
  const chosen: { node: FlowNode; x: number }[] = [];
  for (const node of scene.nodes.filter(node => node.lane === -1).sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.x - a.x)) {
    const x = Math.max(0, Math.min(node.x - 20, scene.width - 60));
    if (chosen.every(label => x + 60 < label.x || label.x + 60 < x)) chosen.push({ node, x });
  }
  return chosen;
}

/// The whole scene plays after Git succeeds. Files are an expandable receipt,
/// never waiting objects or flying particles. Resize and history stay settled.
export class RepoFlowView {
  readonly element = document.createElement("div");
  private played = false;
  private playing = false;
  private raf = 0;
  private filesOpen = false;
  private openLanes = new Set<string>();
  constructor(readonly flow: RepoFlow, private readonly command: string, private spread: { width?: number; roomy?: boolean; repo?: string } = {}) {
    this.element.className = "repo-flow";
  }
  private scene() { return repoScene(this.flow, { width: this.spread.width ? this.spread.width - FRAME_PAD * 2 : 0, settled: true, roomy: this.spread.roomy }); }
  render(live: boolean) {
    if (this.element.childElementCount) return;
    this.draw(live && !this.played && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  fit(width: number) {
    if (!width || Math.abs(width - (this.spread.width ?? 0)) < 2) return;
    this.spread = { ...this.spread, width };
    if (this.playing || !this.element.childElementCount) return;
    this.draw(false);
  }
  replay() {
    if (this.playing || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.draw(true);
  }
  private draw(playing: boolean) {
    cancelAnimationFrame(this.raf);
    const refocus = this.element.querySelector(".rf-replay") === document.activeElement;
    this.element.replaceChildren();
    const scene = this.scene();
    this.playing = playing;
    this.element.dataset.playing = String(playing);
    if (playing) this.played = true;
    const head = html("div", "rf-head", "", this.element);
    html("span", "rf-repo", this.flow.result?.repository || this.spread.repo || "Repository", head);
    if (scene.older) html("span", "rf-more", `+${scene.older} other branches`, head);
    const body = html("div", "rf-body", "", this.element);
    const svg = el("svg", { viewBox: `0 0 ${scene.width} ${scene.height}`, width: scene.width, height: scene.height, role: "img", "aria-label": scene.done }, body);
    const mainLabel = el("text", { x: LEFT, y: 13, class: "rf-main-label" }, svg);
    // Full branch names are always available in the wrapping legend below.
    const main = this.flow.after.main;
    const maxChars = Math.max(8, Math.floor((scene.width - 20) / 7));
    mainLabel.textContent = main.length > maxChars ? `${main.slice(0, maxChars - 1)}…` : main;
    const pathsGroup = el("g", {}, svg);
    const paths = scene.paths.map(path => {
      const node = el("path", { d: path.d, pathLength: 1, class: `rf-pipe rf-${path.tone}`, "data-part": path.part, "data-lane": path.lane }, pathsGroup);
      return { path, node };
    });
    const nodes = scene.nodes.map(node => {
      const circle = el("circle", { cx: node.x, cy: node.y, r: node.fresh ? 4.5 : 3, class: `rf-node rf-${node.fresh ? "you" : node.tone}${node.merge ? " rf-ring" : ""}${node.fresh ? " rf-fresh" : " rf-history"}`, "data-sha": node.sha }, svg);
      el("title", {}, circle).textContent = `${node.sha.slice(0, 7)} · ${node.subject}`;
      return { node, circle };
    });
    const focus = scene.nodes.find(node => node.sha === scene.commit?.sha) ?? scene.nodes.find(node => node.fresh);
    const halo = focus ? el("circle", { cx: focus.x, cy: focus.y, r: 7, class: "rf-halo rf-you" }, svg) : null;
    const hashes = repoHashLabels(scene).map(({ node, x }) => {
      const label = el("text", { x, y: 30, class: "rf-hash" }, svg);
      label.textContent = node.sha.slice(0, 7);
      return { node, label };
    });
    // Wrapping HTML keeps branch names and commit words clear of every path,
    // including during the opening motion and at the narrowest pane width.
    const legend = html("div", "rf-legend", "", this.element);
    for (const row of scene.rows) {
      const lane = html("details", `rf-lane rf-${row.tone}`, "", legend);
      lane.open = this.openLanes.has(row.text);
      lane.addEventListener("toggle", () => { if (lane.isConnected) { if (lane.open) this.openLanes.add(row.text); else this.openLanes.delete(row.text); } });
      const summary = html("summary", "", "", lane);
      html("span", "rf-row", row.text, summary);
      const commits = scene.nodes.filter(node => node.lane === row.lane);
      html("code", "rf-lane-tip", commits.at(-1)?.sha.slice(0, 7) ?? "", summary);
      const log = html("div", "rf-lane-log", "", lane);
      for (const commit of commits) {
        const item = html("div", "", "", log);
        html("code", "", commit.sha.slice(0, 7), item);
        html("span", "", commit.subject, item);
      }
    }
    const result = html("div", "rf-details", "", this.element);
    html("div", "rf-status", this.flow.command === "merge" ? `Merged into ${this.flow.after.head ?? main}` : "Commit created", result);
    html("div", "rf-title", scene.commit?.subject ?? this.command, result);
    html("div", "rf-meta", `${(scene.commit?.sha ?? this.flow.after.tip ?? "").slice(0, 7)} · ${this.flow.after.head ?? "detached HEAD"}`, result);
    // Keep the outcome in normal flow, so even very long branch names wrap.
    html("div", "rf-outcome", scene.done, result);
    const footer = html("div", "rf-footer", "", this.element);
    const files = html("details", "rf-files", "", footer);
    files.open = this.filesOpen;
    files.addEventListener("toggle", () => { if (files.isConnected) this.filesOpen = files.open; });
    const totals = this.flow.result?.totals ?? (this.flow.command === "commit" ? this.flow.before.fileTotals : undefined);
    const sum = totals ?? (!scene.moreFiles ? scene.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }) : null);
    html("summary", "", this.flow.command === "merge" && !this.flow.result ? "File details unavailable for this older merge" : `${plural(scene.files.length + scene.moreFiles, "file")} changed${sum ? ` · +${sum.added} −${sum.removed}` : ""}`, files);
    const list = html("div", "rf-file-list", "", files);
    for (const file of scene.files) {
      const item = html("div", "rf-file-entry", "", list);
      html("span", "rf-file-path", file.path, item);
      html("span", "rf-file-count", file.binary ? "binary" : `+${file.added} −${file.removed}`, item);
    }
    if (scene.moreFiles) html("div", "rf-more", `${scene.moreFiles} more files not shown`, list);
    const replay = html("button", "rf-replay", "Replay the scene", footer);
    replay.type = "button";
    replay.disabled = playing;
    replay.addEventListener("click", () => this.replay());
    if (refocus && !playing) replay.focus();
    const paint = (progress: number) => {
      const open = ease((progress - .12) / .43), reveal = ease((progress - .83) / .17);
      pathsGroup.setAttribute("transform", `translate(0 ${MAIN_Y}) scale(1 ${Math.max(.001, open)}) translate(0 ${-MAIN_Y})`);
      for (const { path, node } of paths) {
        const fresh = path.part === "join" || path.part === "main-new" || path.part === "lane-new";
        const start = path.part === "main" ? 0 : fresh ? .45 : .16;
        const drawn = ease((progress - start) / (fresh ? .34 : .36));
        node.style.strokeDasharray = "1";
        node.style.strokeDashoffset = String(1 - drawn);
        node.style.opacity = String(path.lane === scene.merged && path.part !== "join" ? 1 - .45 * reveal : .9);
      }
      for (const { node, circle } of nodes) {
        const at = node.fresh ? .73 : .05 + node.x / scene.width * .25 + (node.lane === -1 ? 0 : .2);
        const arrive = clamp((progress - at) / .16);
        circle.setAttribute("cy", String(MAIN_Y + (node.y - MAIN_Y) * open));
        circle.setAttribute("r", String((node.fresh ? 4.5 : node.merge ? 3.6 : 3) * (ease(arrive) + .16 * Math.sin(arrive * Math.PI))));
        circle.style.opacity = String(arrive * (node.lane === scene.merged ? 1 - .45 * reveal : 1));
      }
      for (const { node, label } of hashes) label.style.opacity = String(ease((progress - (node.fresh ? .82 : .24)) / .14));
      if (halo && focus) {
        const pulse = progress > .73 && progress < 1 ? Math.sin((progress - .73) / .27 * Math.PI) : 0;
        halo.setAttribute("cy", String(MAIN_Y + (focus.y - MAIN_Y) * open));
        halo.setAttribute("r", String(7 + 11 * pulse));
        halo.style.opacity = String(pulse * .45);
      }
      legend.style.opacity = String(ease((progress - .45) / .2));
      result.style.opacity = String(reveal);
      result.style.transform = `translateY(${4 * (1 - reveal)}px)`;
    };
    if (!playing) { paint(1); return; }
    paint(0);
    let start: number | undefined;
    const frame = (time: number) => {
      start ??= time;
      const progress = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : clamp((time - start) / DURATION);
      paint(progress);
      if (progress < 1) { this.raf = requestAnimationFrame(frame); return; }
      this.playing = false;
      this.element.dataset.playing = "false";
      replay.disabled = false;
      if (Math.abs(scene.width - this.scene().width) > 1) this.draw(false);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
