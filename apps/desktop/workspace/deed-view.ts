/// The Deed page: a project's plain sentences, each with a mark for its state
/// and, under the one you're on, a single line of what you can do with it.
import type { Deed, DeedChange, DeedPeek, DeedSentence, DeedValue } from "@demesne/protocol";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

/// What the window holds about the page: the sentence you're on, the words
/// you're typing into it, and a live word you're changing but haven't made so.
export type DeedFilter = "proved" | "check" | "wish" | "unproved";
export interface DeedUi {
  focus: string | null; editing: string | null; live?: { sentence: string; value: string; to: number | string } | null;
  /// Only these sentences, and the page as it read at the start of this day (ms).
  filter?: DeedFilter | null; since?: number | null;
  /// What the composer is finding, and the code unfolded under a sentence.
  find?: string; peek?: { id: string; at: string; data: DeedPeek | null } | null;
}

const findWords = (find: string | undefined) => (find ?? "").toLowerCase().split(/\s+/).filter(Boolean);
/// Sentences that say every word of what is being typed.
export const findHits = (deed: Deed, find: string | undefined) => {
  const want = findWords(find);
  return want.length ? deed.sentences.filter((sentence) => want.every((word) => sentence.text.toLowerCase().includes(word))) : [];
};
const markFound = (html: string, find: string | undefined) => {
  const pattern = findWords(find).map((word) => h(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!pattern.length) return html;
  const found = new RegExp(`(${pattern.join("|")})`, "gi");
  // Only the text between tags, so a live word keeps its marks.
  return html.split(/(<[^>]*>)/).map((part, index) => index % 2 ? part : part.replace(found, "<mark>$1</mark>")).join("");
};

/// The lines of code under a sentence, its live values marked and, while one
/// is being changed, showing the new value.
export function peekHTML(sentence: DeedSentence, peek: DeedPeek, ui: DeedUi): string {
  const tests = sentence.tests?.length ? `proved by ${sentence.tests.map((file) => file.split("/").at(-1)).join(", ")}` : "no test holds it";
  const lines = peek.lines.map((line) => {
    const value = sentence.values?.find((item) => item.path === peek.path && item.code.trim() === line.text.trim());
    let body = h(line.text);
    if (value) {
      const at = line.text.search(new RegExp(`(?<![\\w.])${escape(value.literal)}(?![\\w])`));
      if (at >= 0) {
        const live = ui.live?.sentence === sentence.id && ui.live.value === value.id ? liveWord(value, ui.live.to).literal : null;
        body = `${h(line.text.slice(0, at))}<span class="tok${live && live !== value.literal ? " on" : ""}">${live && live !== value.literal ? `‹ ${h(live)} ›` : h(value.literal)}</span>${h(line.text.slice(at + value.literal.length))}`;
      }
    }
    return `<div class="pk-l${line.n === peek.line ? " at" : ""}"><i>${line.n}</i>${body}</div>`;
  }).join("");
  return `<div class="peek"><div class="pk-h"><span>${h(peek.path)}</span><span class="pk-dim">line ${peek.line} · ${h(tests)}</span></div>${lines}</div>`;
}

/// Sentences that need the person: their code changed, they're no longer
/// true, or making one true failed.
export const toCheck = (deed: Deed) => deed.sentences.filter((sentence) => ["check", "false", "failed"].includes(sentence.state)).length;

/// The old words struck and the new ones in their place, word by word.
export function wordDiff(before: string, after: string): string {
  const a = before.split(/(\s+)/).filter(Boolean), b = after.split(/(\s+)/).filter(Boolean);
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0, del = "", ins = "";
  // Spaces around a change stay outside its marks.
  const flush = () => {
    const edge = ins.trim() ? ins : del;
    if (edge.trim()) out.push(h(edge.match(/^\s*/)![0]), del.trim() ? `<del>${h(del.trim())}</del>` : "", ins.trim() ? `<ins>${h(ins.trim())}</ins>` : "", h(edge.match(/\s*$/)![0]));
    del = ins = "";
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); out.push(h(a[i])); i++; j++; }
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ins += b[j++];
    else del += a[i++];
  }
  flush();
  return out.join("").replace(/\s+$/, "");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordAt = (text: string, word: string) => text.search(new RegExp(`(?<![\\w])${escape(word)}(?![\\w])`));
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
/// A live number's value, and how the sentence would say another one.
export const numberOf = (text: string) => /^\d+(\.\d+)?$/.test(text) ? Number(text) : NUMBER_WORDS.indexOf(text.toLowerCase());
export function numberText(value: number, like: string): string {
  return /^\d/.test(like) || !NUMBER_WORDS.includes(like.toLowerCase()) || !NUMBER_WORDS[value] ? String(value)
    : like[0] === like[0]!.toUpperCase() ? NUMBER_WORDS[value]![0]!.toUpperCase() + NUMBER_WORDS[value]!.slice(1) : NUMBER_WORDS[value]!;
}
/// The word a live value would say, and the code token it would put on its line.
export function liveWord(value: DeedValue, to: number | string): { word: string; literal: string } {
  if (value.kind === "number") return { word: numberText(Number(to), value.text), literal: String(to) };
  return value.choices?.find((choice) => choice.word === to) ?? { word: value.text, literal: value.literal };
}
/// Live words can change while the sentence holds and nothing runs on it.
export const isLive = (sentence: DeedSentence) => sentence.state === "true" && sentence.proof?.state !== "running" && Boolean(sentence.values?.length);

/// The sentence's words, its live ones marked; the one being changed shows
/// its new value in place: ‹ 10 › to drag, or its choices laid inline.
export function liveWords(sentence: DeedSentence, ui: DeedUi): string {
  if (!isLive(sentence)) return h(sentence.text);
  const spots = sentence.values!.map((value) => ({ value, at: wordAt(sentence.text, value.text) })).filter((spot) => spot.at >= 0).sort((a, b) => a.at - b.at);
  let out = "", from = 0;
  for (const { value, at } of spots) {
    if (at < from) continue;
    out += h(sentence.text.slice(from, at));
    const live = ui.live?.sentence === sentence.id && ui.live.value === value.id ? ui.live : null;
    const data = `data-sentence="${h(sentence.id)}" data-value="${h(value.id)}"`;
    if (live && value.kind === "number")
      out += `<span class="lv scrub" ${data} tabindex="0" aria-label="${h(`${value.text}, drag or press up and down`)}"><i>‹</i>${h(liveWord(value, live.to).word)}<i>›</i></span>`;
    else if (live)
      out += `<span class="lv pick" ${data}><b>${h(live.to)}</b><span class="alts">${value.choices!.filter((choice) => choice.word !== live.to).map((choice) => btn("deed-choose", h(choice.word), { id: sentence.id, value: value.id, to: choice.word }, "lv-alt")).join("")}</span></span>`;
    else
      out += `<span class="lv${value.kind === "number" ? " num" : ""}" ${data} tabindex="0" title="${h(value.kind === "number" ? `Drag, or ↑↓ · ${value.path}:${value.line}` : `Click for its choices · ${value.path}:${value.line}`)}">${h(value.text)}</span>`;
    from = at + value.text.length;
  }
  return out + h(sentence.text.slice(from));
}

/// The line under a live word being changed: what it will touch, and the line of code.
export function liveLine(sentence: DeedSentence, ui: DeedUi): string {
  const value = sentence.values?.find((item) => item.id === ui.live?.value);
  if (!value || !ui.live) return "";
  const next = liveWord(value, ui.live.to), same = next.literal === value.literal;
  const tests = sentence.tests?.length ? `, then its tests in ${sentence.tests.map((file) => `<b>${h(file.split("/").at(-1))}</b>`).join(", ")}` : ", with no tests to prove it";
  const keys = value.kind === "number" ? "drag or ↑↓" : "← → to choose";
  const code = (line: string) => h(line.trim().length > 90 ? `${line.trim().slice(0, 89)}…` : line.trim());
  const after = value.code.replace(new RegExp(`(?<![\\w.])${escape(value.literal)}(?![\\w])`), next.literal);
  return `<div class="dz-under" id="deed-live-line">${same ? `<span class="dz-quiet">${keys}</span>` : `<span class="dz-go">Make it so <kbd>↵</kbd></span>`}<span class="dz-quiet">one line in <b>${h(value.path.split("/").at(-1))}</b>${tests}</span><span class="dz-quiet">Esc puts it back</span></div>${same ? "" : `<div class="dz-code"><div class="rm"><i>${value.line}</i>− ${code(value.code)}</div><div class="ad"><i>${value.line}</i>+ ${code(after)}</div></div>`}`;
}

/// The line under a sentence whose tests ran or are running.
function proofLine(sentence: DeedSentence): string {
  const proof = sentence.proof!, names = proof.files.map((file) => `<b>${h(file.split("/").at(-1))}</b>`).join(", ");
  const undo = sentence.undo ? btn("deed-undo", "Undo", { id: sentence.id }, "dz-quiet") : "";
  if (proof.state === "running") return `<div class="dz-under"><span class="shine dz-shine">Proving</span><span class="dz-quiet">${names}</span>${undo}</div>`;
  if (proof.state === "passed") {
    const ticks = Math.min(proof.passed ?? 0, 24);
    return `<div class="dz-under made"><span class="dz-ok">✓ Proved</span><span class="dz-quiet">${ticks ? `<span class="dz-ticks">${"<i></i>".repeat(ticks)}</span>` : ""}${proof.passed ? plural(proof.passed, "test") : "its tests"} in ${names}${proof.ms && proof.ms >= 100 ? ` · ${(proof.ms / 1000).toFixed(1)}s` : ""}</span>${undo}${btn("deed-seen", "×", { id: sentence.id }, "dz-quiet dz-x")}</div>`;
  }
  // A chat that wrote no test is no failure: the sentence is as true as before.
  if (!proof.files.length) return `<div class="dz-under"><span class="dz-quiet">No test yet.</span><span class="dz-why">${h(proof.detail ?? "")}</span>${btn("deed-cover", "Have Drive try again", { id: sentence.id }, "dz-alt")}</div>`;
  return `<div class="dz-under drifted bad"><span class="dz-bad">${proof.putBack ? "Not proved, so it went back." : "Not proved."}</span><span class="dz-why">${h(proof.detail ?? "Its tests failed.")}</span><div class="dz-pick">${proof.putBack ? "" : btn("deed-fix", "Fix the code", { id: sentence.id }, "dz-go")}${btn("deed-prove", "Prove again", { id: sentence.id }, "dz-alt")}</div></div>`;
}

const where = (sentence: DeedSentence) => sentence.anchors.map((anchor) => `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`);
const files = (sentence: DeedSentence) => [...new Set(sentence.anchors.map((anchor) => anchor.path.split("/").at(-1)!))];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/// The line under the sentence you're on: what it can do next.
function under(sentence: DeedSentence, ui: DeedUi): string {
  const chat = sentence.sessionId ? btn("select-session", "Open its chat", { id: sentence.sessionId }, "dz-quiet") : "";
  switch (sentence.state) {
    case "working":
      return `<div class="dz-under"><span class="shine dz-shine">${sentence.covering ? "Writing a test that proves it" : "Making it true"}</span>${chat}</div>`;
    case "checking":
      return `<div class="dz-under"><span class="shine dz-shine">Reading the code under it</span></div>`;
    case "false":
      return `<div class="dz-under drifted"><span class="dz-am">No longer true.</span><span class="dz-why">${h(sentence.why ?? "")}</span><div class="dz-pick">${btn("deed-fix", "Fix the code", { id: sentence.id }, "dz-go")}${sentence.words ? btn("deed-words", "Fix the words", { id: sentence.id }, "dz-alt") : ""}${sentence.words ? `<span class="dz-quiet dz-words">“${h(sentence.words)}”</span>` : ""}</div></div>`;
    case "check":
      return `<div class="dz-under"><span class="dz-am">Its code changed.</span>${sentence.why ? `<span class="dz-why">${h(sentence.why)}</span>` : ""}${btn("deed-check", "Check it", { id: sentence.id }, "dz-alt")}</div>`;
    case "failed":
      return `<div class="dz-under drifted bad"><span class="dz-bad">Not made true.</span><span class="dz-why">${h(sentence.why ?? "")}</span><div class="dz-pick">${btn("deed-fix", "Try again", { id: sentence.id }, "dz-alt")}${chat}${btn("deed-remove", "Remove it", { id: sentence.id }, "dz-quiet")}</div></div>`;
    case "wish":
      return `<div class="dz-under">${btn("deed-build", `Build it <kbd>↵</kbd>`, { id: sentence.id }, "dz-go")}<span class="dz-quiet">not true yet</span>${btn("deed-leave", "Leave it as a wish", {}, "dz-quiet")}${btn("deed-remove", "Remove", { id: sentence.id }, "dz-quiet")}</div>`;
    default:
      if (ui.live?.sentence === sentence.id) return liveLine(sentence, ui);
      if (sentence.proof && (sentence.proof.state !== "passed" || ui.focus === sentence.id || sentence.undo)) return proofLine(sentence);
      if (sentence.madeAt) return `<div class="dz-under made"><span class="dz-ok">✓ Made true</span><span class="dz-quiet">${h(files(sentence).join(", "))}</span>${chat}${btn("deed-seen", "×", { id: sentence.id }, "dz-quiet dz-x")}</div>`;
      return ui.focus === sentence.id ? `<div class="dz-under"><span class="dz-quiet">${sentence.values?.length ? "Drag or click an underlined word, or click the words to change them; the code follows." : "Click the words to change them; the code follows."} Space shows its code.</span>${sentence.tests?.length ? btn("deed-prove", "Prove it", { id: sentence.id }, "dz-quiet") : `<span class="dz-quiet">No test holds it yet.</span>${btn("deed-cover", "Have Drive prove it", { id: sentence.id }, "dz-go")}`}</div>` : "";
  }
}

/// The line under a sentence being edited.
export function editLine(sentence: DeedSentence, text: string): string {
  const next = text.replace(/\s+/g, " ").trim();
  if (!next) return `<span class="dz-go">Remove it <kbd>↵</kbd></span><span class="dz-quiet">Esc keeps the old words</span>`;
  if (next === sentence.text) return `<span class="dz-quiet">Change the words, then Enter. Esc keeps the old words.</span>`;
  const touches = files(sentence);
  return `<span class="dz-go">Make it so <kbd>↵</kbd></span><span class="dz-diff">${wordDiff(sentence.text, next)}</span>${touches.length ? `<span class="dz-quiet">from ${touches.map((file) => `<b>${h(file)}</b>`).join(", ")}</span>` : ""}<span class="dz-quiet">Esc keeps the old words</span>`;
}

const MARK: Record<string, string> = { check: "amber", false: "amber", checking: "amber", working: "blue", failed: "red", wish: "hol" };

function sentenceHTML(sentence: DeedSentence, ui: DeedUi): string {
  // A word being changed sets the old proof aside until Enter.
  // (A chat that wrote no test left it as true as it was: no red.)
  const proof = sentence.state === "true" && ui.live?.sentence !== sentence.id && !(sentence.proof?.state === "failed" && !sentence.proof.files.length) ? sentence.proof?.state : undefined;
  const living = ui.live?.sentence === sentence.id;
  const tone = living || proof === "running" ? "blue" : proof === "failed" ? "red" : proof === "passed" || (sentence.state === "true" && sentence.madeAt) ? "green" : sentence.state === "true" ? "hol" : MARK[sentence.state] ?? "";
  const on = ui.focus === sentence.id;
  const finding = findWords(ui.find).length > 0 && !ui.since;
  const hit = finding && findHits({ sentences: [sentence] } as Deed, ui.find).length > 0;
  const cls = ["dz-s", `st-${sentence.state}`, proof ? `pr-${proof}` : "", on ? "on" : "", finding && !hit ? "dim" : "", living ? "living" : "", sentence.madeAt && sentence.state === "true" ? "fresh" : ""].filter(Boolean).join(" ");
  const anchors = where(sentence);
  const margin = anchors.length ? `<span class="dz-anc">${anchors.map((anchor) => h(anchor)).join("<br>")}</span>` : "";
  const words = sentence.was && sentence.state === "working" ? wordDiff(sentence.was, sentence.text) : hit ? markFound(liveWords(sentence, ui), ui.find) : liveWords(sentence, ui);
  if (ui.editing === sentence.id)
    return `<div class="${cls} editing" data-deed="${h(sentence.id)}"><span class="dz-mk blue"></span><textarea class="dz-edit" rows="1" spellcheck="true" aria-label="Change this sentence">${h(sentence.text)}</textarea>${margin}</div><div class="dz-under" id="deed-edit-line">${editLine(sentence, sentence.text)}</div>`;
  return `<div class="${cls}" data-deed="${h(sentence.id)}" tabindex="0" title="${h([STATE_WORDS[sentence.state], ...anchors].filter(Boolean).join("\n"))}"><span class="dz-mk ${tone}"></span><span class="dz-words">${words}</span>${margin}</div>${ui.peek?.id === sentence.id && ui.peek.data ? peekHTML(sentence, ui.peek.data, ui) : ""}${on || ui.live?.sentence === sentence.id || sentence.state === "working" || sentence.state === "false" || (sentence.state === "true" && (sentence.madeAt || (sentence.proof && (sentence.proof.state !== "passed" || sentence.undo)))) ? under(sentence, ui) : ""}`;
}
const STATE_WORDS: Record<string, string> = { true: "True of the code", check: "Its code changed: check it", checking: "Checking", false: "No longer true", working: "Being made true", failed: "Not made true", wish: "A wish: not true yet" };

/// The whole page, from the empty one to the written deed.
export function deedPage(deed: Deed | null, ui: DeedUi, name: string, now = Date.now()): string {
  if (!deed) return `<div class="deed-lead">Opening the Deed…</div>`;
  const writing = deed.writing;
  if (!deed.writtenAt || (writing && !deed.sentences.some((sentence) => sentence.state !== "wish"))) {
    const body = writing?.status === "running"
      ? `<p class="deed-lead"><span class="shine dz-shine">Reading the code and writing down what ${h(name)} does…</span> ${btn("select-session", "Watch", { id: writing.sessionId }, "dz-quiet")}</p>`
      : `<p class="deed-lead">The Deed says what ${h(name)} does, in plain sentences, each held true by the code beneath it. Change a sentence and the code follows. Change the code and the sentence it breaks lights up.</p>${writing?.status === "failed" ? `<p class="deed-lead dz-bad">${h(writing.error ?? "Writing it stopped.")}</p>` : ""}<p>${btn("deed-write", writing?.status === "failed" ? "Try again" : "Write the deed", {}, "dz-go")}</p>`;
    return `<div class="deed-empty">${body}</div>${deed.sentences.length ? sections(deed, ui) : ""}`;
  }
  const rewriting = writing?.status === "running" ? ` <span class="shine dz-shine">rewriting…</span>` : writing?.status === "failed" ? ` <span class="dz-bad">${h(writing.error ?? "")}</span>` : "";
  const live = deed.sentences.some((sentence) => sentence.values?.length || sentence.tests?.length);
  const finding = findWords(ui.find).length && !ui.since ? findHits(deed, ui.find).length : null;
  const line = finding !== null ? (finding ? `${plural(finding, "sentence")} say${finding === 1 ? "s" : ""} “${h(ui.find!.trim())}”. Enter adds what you typed as a new one.` : `No sentence says “${h(ui.find!.trim())}”. Enter adds it as a new one.`) : `${plural(deed.sentences.length, "sentence")}, written from the code.${live || writing ? "" : ` ${btn("deed-write", "Read the code again", {}, "dz-quiet dz-inline")} to find the words you can change in place.`}${rewriting}`;
  return `<div class="d4-head"><div class="d3-name">${h(name)}</div><div class="d3-line">${line}</div>${deed.proving?.running ? provingLine(deed) : countsLine(deed, ui)}${weekLine(deed, ui, now)}</div>${sections(deed, ui, now)}`;
}

const proved = (sentence: DeedSentence) => sentence.state === "true" && sentence.proof?.state === "passed";
const FILTERS: Record<DeedFilter, (sentence: DeedSentence) => boolean> = {
  proved,
  check: (sentence) => ["check", "false", "failed"].includes(sentence.state),
  wish: (sentence) => sentence.state === "wish",
  unproved: (sentence) => sentence.state === "true" && !proved(sentence),
};
const COUNT_WORDS: Record<DeedFilter, [string, string]> = { proved: ["proved", "ok"], check: ["to check", "am"], wish: ["wish", "wish"], unproved: ["unproved", "hol"] };

/// What holds, and what needs you: each count is a filter on the page.
function countsLine(deed: Deed, ui: DeedUi): string {
  const counts = (Object.keys(COUNT_WORDS) as DeedFilter[]).map((name) => ({ name, n: deed.sentences.filter(FILTERS[name]).length })).filter(({ n }) => n);
  const parts = counts.map(({ name, n }) => btn("deed-filter", `${n} ${name === "wish" && n > 1 ? "wishes" : COUNT_WORDS[name][0]}`, { f: ui.filter === name ? null : name }, `ct ${COUNT_WORDS[name][1]}${ui.filter === name ? " on" : ""}`));
  const prove = deed.sentences.some((sentence) => sentence.tests?.length) ? btn("deed-prove", "Prove it", {}, "ct act") : "";
  return `<div class="d4-counts">${parts.join("")}<span class="ct-sp"></span>${prove}</div>`;
}

/// Prove it running: how far, which sentence, and Stop.
function provingLine(deed: Deed): string {
  const p = deed.proving!, now = deed.sentences.find((sentence) => sentence.proof?.state === "running");
  return `<div class="d4-counts"><span class="ct t1">${p.done} of ${p.total}</span>${now ? `<span class="ct run">${h(now.section)} · ${h(now.proof!.files.map((file) => file.split("/").at(-1)).join(", "))}</span>` : ""}<span class="ct-sp"></span>${btn("deed-stop", "Stop", {}, "ct act")}</div><div class="d4-prog"><i style="width:${Math.round(p.done / Math.max(1, p.total) * 100)}%"></i></div>`;
}

const DAY = 86_400_000;
const dayStart = (time: number) => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
const dayName = (time: number) => new Date(time).toLocaleDateString("en", { weekday: "short" });

/// The last six days, a dot on each one the Deed changed, and what changed.
export function weekDays(deed: Deed, now: number): { start: number; label: string; changes: DeedChange[] }[] {
  const today = dayStart(now);
  return [5, 4, 3, 2, 1, 0].map((back) => {
    const start = today - back * DAY;
    const changes = (deed.log ?? []).filter((change) => { const at = Date.parse(change.at); return at >= start && at < start + DAY; });
    return { start, label: back === 0 ? "Today" : dayName(start), changes };
  });
}
const SAYS: Record<DeedChange["kind"], string> = { added: "added", words: "reworded", broke: "broke", mended: "came back", removed: "removed" };
function dayCaption(label: string, changes: DeedChange[]): string {
  if (!changes.length) return `${label} · nothing changed`;
  const by = (kind: DeedChange["kind"]) => changes.filter((change) => change.kind === kind).length;
  return `${label} · ${(Object.keys(SAYS) as DeedChange["kind"][]).filter(by).map((kind) => `${by(kind)} ${SAYS[kind]}`).join(", ")}`;
}

function weekLine(deed: Deed, ui: DeedUi, now: number): string {
  const days = weekDays(deed, now), today = days.at(-1)!.start;
  const items = days.map((day) => {
    const on = ui.since ? ui.since === day.start && day.start !== today : false;
    return `<button type="button" class="wk${on || (!ui.since && day.start === today) ? " on" : ""}" data-action="deed-since" data-args="${h(JSON.stringify({ t: day.start === today ? null : day.start }))}" title="${h(dayCaption(day.label, day.changes))}">${h(day.label)}${day.changes.length ? "<b></b>" : ""}</button>`;
  }).join("");
  const tail = ui.since || ui.filter ? btn("deed-since", "Show all · Esc", { t: null, f: null }, "dz-quiet wk-x") : "";
  return `<div class="d4-days"><span class="wk-l">${ui.since ? "Since" : "This week"}</span>${items}${tail}</div>`;
}

/// How a sentence reads against the start of a day: reworded, added, or broken since.
function sinceMark(change: DeedChange) {
  return `${change.who === "you" && change.kind !== "broke" && change.kind !== "mended" ? "you" : "the code"} · ${dayName(Date.parse(change.at))}`;
}

function sections(deed: Deed, ui: DeedUi, now = Date.now()): string {
  const names = [...deed.sections, ...new Set(deed.sentences.map((sentence) => sentence.section).filter((section) => !deed.sections.includes(section)))];
  const since = ui.since ? (deed.log ?? []).filter((change) => Date.parse(change.at) >= ui.since!) : null;
  const removed = since?.filter((change) => change.kind === "removed" && !since.some((other) => other.id === change.id && other.kind === "added")) ?? [];
  if (since) for (const change of removed) if (!names.includes(change.section)) names.push(change.section);
  const keep = ui.filter ? FILTERS[ui.filter] : null;
  const out = names.map((section) => {
    const all = deed.sentences.filter((sentence) => sentence.section === section), items = keep ? all.filter(keep) : all;
    const gone = removed.filter((change) => change.section === section);
    if (!items.length && !gone.length) return "";
    const count = keep ? `<span class="h-n">${items.length} of ${all.length}</span>` : "";
    const rows = items.map((sentence) => since ? sinceRow(sentence, ui, since) : sentenceHTML(sentence, ui)).join("") + gone.map((change) => `<div class="dz-s x-changed"><span class="dz-mk"></span><span class="dz-words"><del>${h(change.was)}</del></span><span class="dz-anc dz-since">removed · ${h(sinceMark(change))}</span></div>`).join("");
    const quiet = findWords(ui.find).length > 0 && !since && !findHits({ sentences: items } as Deed, ui.find).length;
    return `<h3${quiet ? ' class="dim"' : ""}>${h(section)}${count}</h3><div class="dz-p">${rows}</div>`;
  }).join("");
  return out || `<p class="deed-lead">${since ? "Nothing in the Deed changed since then." : "No sentence fits."}</p>`;
}

/// A sentence as the week changed it; the ones nobody touched fade back.
function sinceRow(sentence: DeedSentence, ui: DeedUi, since: DeedChange[]): string {
  const mine = since.filter((change) => change.id === sentence.id);
  if (!mine.length) return `<div class="dz-s dim" data-deed="${h(sentence.id)}"><span class="dz-mk ${sentence.state === "true" ? "hol" : MARK[sentence.state] ?? ""}"></span><span class="dz-words">${h(sentence.text)}</span></div>`;
  const first = mine.find((change) => change.kind === "words"), added = mine.find((change) => change.kind === "added"), last = mine.at(-1)!;
  const words = added ? `<ins>${h(sentence.text)}</ins>` : first?.was ? wordDiff(first.was, sentence.text) : h(sentence.text);
  const label = added ? `added · ${sinceMark(added)}` : sinceMark(last);
  const tone = sentence.state === "true" ? "green" : MARK[sentence.state] ?? "";
  return `<div class="dz-s x-changed st-${sentence.state}" data-deed="${h(sentence.id)}"><span class="dz-mk ${tone}"></span><span class="dz-words">${words}</span><span class="dz-anc dz-since">${h(label)}</span></div>`;
}
