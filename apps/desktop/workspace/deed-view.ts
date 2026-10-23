/// The Deed page: a project's plain sentences, each with a mark for its state
/// and, under the one you're on, a single line of what you can do with it.
import type { Deed, DeedSentence, DeedValue } from "@demesne/protocol";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

/// What the window holds about the page: the sentence you're on, the words
/// you're typing into it, and a live word you're changing but haven't made so.
export interface DeedUi { focus: string | null; editing: string | null; live?: { sentence: string; value: string; to: number | string } | null }

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
      return `<div class="dz-under"><span class="shine dz-shine">Making it true</span>${chat}</div>`;
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
      return ui.focus === sentence.id ? `<div class="dz-under"><span class="dz-quiet">${sentence.values?.length ? "Drag or click an underlined word, or click the words to change them; the code follows." : "Click the words to change them; the code follows."}</span>${sentence.tests?.length ? btn("deed-prove", "Prove it", { id: sentence.id }, "dz-quiet") : ""}</div>` : "";
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

const MARK: Record<string, string> = { check: "amber", false: "amber", checking: "amber", working: "blue", failed: "red", wish: "ghost" };

function sentenceHTML(sentence: DeedSentence, ui: DeedUi): string {
  // A word being changed sets the old proof aside until Enter.
  const proof = sentence.state === "true" && ui.live?.sentence !== sentence.id ? sentence.proof?.state : undefined;
  const living = ui.live?.sentence === sentence.id;
  const tone = living || proof === "running" ? "blue" : proof === "failed" ? "red" : proof === "passed" || (sentence.state === "true" && sentence.madeAt) ? "green" : MARK[sentence.state] ?? "";
  const on = ui.focus === sentence.id;
  const cls = ["dz-s", `st-${sentence.state}`, proof ? `pr-${proof}` : "", on ? "on" : "", living ? "living" : "", sentence.madeAt && sentence.state === "true" ? "fresh" : ""].filter(Boolean).join(" ");
  const anchors = where(sentence);
  const margin = anchors.length ? `<span class="dz-anc">${anchors.map((anchor) => h(anchor)).join("<br>")}</span>` : "";
  const words = sentence.was && sentence.state === "working" ? wordDiff(sentence.was, sentence.text) : liveWords(sentence, ui);
  if (ui.editing === sentence.id)
    return `<div class="${cls} editing" data-deed="${h(sentence.id)}"><span class="dz-mk blue"></span><textarea class="dz-edit" rows="1" spellcheck="true" aria-label="Change this sentence">${h(sentence.text)}</textarea>${margin}</div><div class="dz-under" id="deed-edit-line">${editLine(sentence, sentence.text)}</div>`;
  return `<div class="${cls}" data-deed="${h(sentence.id)}" tabindex="0" title="${h([STATE_WORDS[sentence.state], ...anchors].filter(Boolean).join("\n"))}"><span class="dz-mk ${tone}"></span><span class="dz-words">${words}</span>${margin}</div>${on || ui.live?.sentence === sentence.id || sentence.state === "working" || sentence.state === "false" || (sentence.state === "true" && (sentence.madeAt || (sentence.proof && (sentence.proof.state !== "passed" || sentence.undo)))) ? under(sentence, ui) : ""}`;
}
const STATE_WORDS: Record<string, string> = { true: "True of the code", check: "Its code changed: check it", checking: "Checking", false: "No longer true", working: "Being made true", failed: "Not made true", wish: "A wish: not true yet" };

/// The whole page, from the empty one to the written deed.
export function deedPage(deed: Deed | null, ui: DeedUi, name: string): string {
  if (!deed) return `<div class="deed-lead">Opening the Deed…</div>`;
  const writing = deed.writing;
  if (!deed.writtenAt || (writing && !deed.sentences.some((sentence) => sentence.state !== "wish"))) {
    const body = writing?.status === "running"
      ? `<p class="deed-lead"><span class="shine dz-shine">Reading the code and writing down what ${h(name)} does…</span> ${btn("select-session", "Watch", { id: writing.sessionId }, "dz-quiet")}</p>`
      : `<p class="deed-lead">The Deed says what ${h(name)} does, in plain sentences, each held true by the code beneath it. Change a sentence and the code follows. Change the code and the sentence it breaks lights up.</p>${writing?.status === "failed" ? `<p class="deed-lead dz-bad">${h(writing.error ?? "Writing it stopped.")}</p>` : ""}<p>${btn("deed-write", writing?.status === "failed" ? "Try again" : "Write the deed", {}, "dz-go")}</p>`;
    return `<div class="deed-empty">${body}</div>${deed.sentences.length ? sections(deed, ui) : ""}`;
  }
  const rewriting = writing?.status === "running" ? ` <span class="shine dz-shine">rewriting…</span>` : writing?.status === "failed" ? ` <span class="dz-bad">${h(writing.error ?? "")}</span>` : "";
  const proving = deed.proving?.running
    ? `<p class="deed-lead">Proving each sentence by running the tests that hold it. <span class="dz-count">${deed.proving.done} of ${deed.proving.total}</span></p><div class="dz-prog"><i style="width:${Math.round(deed.proving.done / Math.max(1, deed.proving.total) * 100)}%"></i></div>`
    : "";
  const live = deed.sentences.some((sentence) => sentence.values?.length || sentence.tests?.length);
  const lead = proving || `<p class="deed-lead">What ${h(name)} does, in plain words. ${live ? "The underlined words are live: drag a number or click a word, and the code follows." : `Every sentence is held true by the code beneath it. ${writing ? "" : btn("deed-write", "Read the code again", {}, "dz-quiet dz-inline")}${writing ? "" : " to find the words you can change in place."}`}${rewriting}</p>`;
  return `${lead}${sections(deed, ui)}`;
}

function sections(deed: Deed, ui: DeedUi): string {
  const names = [...deed.sections, ...new Set(deed.sentences.map((sentence) => sentence.section).filter((section) => !deed.sections.includes(section)))];
  return names.map((section) => {
    const items = deed.sentences.filter((sentence) => sentence.section === section);
    return items.length ? `<h3>${h(section)}</h3><div class="dz-p">${items.map((sentence) => sentenceHTML(sentence, ui)).join("")}</div>` : "";
  }).join("");
}

/// The title bar's quiet count.
export function deedSummary(deed: Deed | null): string {
  if (!deed?.writtenAt) return "";
  const written = deed.sentences.filter((sentence) => sentence.state !== "wish");
  const held = written.filter((sentence) => sentence.state === "true").length, wishes = deed.sentences.length - written.length;
  const proved = written.filter((sentence) => sentence.proof?.state === "passed").length;
  if (deed.proving?.running) return `Proving · ${deed.proving.done} of ${deed.proving.total}`;
  return [plural(written.length, "sentence"), proved ? `${proved} proved` : `${held} true`, wishes ? plural(wishes, "wish").replace("wishs", "wishes") : ""].filter(Boolean).join(" · ");
}

/// The title bar's one action: Prove it, or Stop while it runs.
export function deedProve(deed: Deed | null): string {
  if (!deed?.writtenAt || !deed.sentences.some((sentence) => sentence.tests?.length)) return "";
  return deed.proving?.running ? btn("deed-stop", "Stop", {}, "deed-prove") : btn("deed-prove", "Prove it", {}, "deed-prove");
}
