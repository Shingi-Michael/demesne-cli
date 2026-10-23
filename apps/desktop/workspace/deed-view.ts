/// The Deed page: a project's plain sentences, each with a mark for its state
/// and, under the one you're on, a single line of what you can do with it.
import type { Deed, DeedSentence } from "@demesne/protocol";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

/// What the window holds about the page: the sentence you're on, and the
/// words you're typing into it.
export interface DeedUi { focus: string | null; editing: string | null }

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
      if (sentence.madeAt) return `<div class="dz-under made"><span class="dz-ok">✓ Made true</span><span class="dz-quiet">${h(files(sentence).join(", "))}</span>${chat}${btn("deed-seen", "×", { id: sentence.id }, "dz-quiet dz-x")}</div>`;
      return ui.focus === sentence.id ? `<div class="dz-under"><span class="dz-quiet">Click the words to change them; the code follows.</span></div>` : "";
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
  const tone = sentence.state === "true" && sentence.madeAt ? "green" : MARK[sentence.state] ?? "";
  const on = ui.focus === sentence.id;
  const cls = ["dz-s", `st-${sentence.state}`, on ? "on" : "", sentence.madeAt && sentence.state === "true" ? "fresh" : ""].filter(Boolean).join(" ");
  const anchors = where(sentence);
  const margin = anchors.length ? `<span class="dz-anc">${anchors.map((anchor) => h(anchor)).join("<br>")}</span>` : "";
  const words = sentence.was && sentence.state === "working" ? wordDiff(sentence.was, sentence.text) : h(sentence.text);
  if (ui.editing === sentence.id)
    return `<div class="${cls} editing" data-deed="${h(sentence.id)}"><span class="dz-mk blue"></span><textarea class="dz-edit" rows="1" spellcheck="true" aria-label="Change this sentence">${h(sentence.text)}</textarea>${margin}</div><div class="dz-under" id="deed-edit-line">${editLine(sentence, sentence.text)}</div>`;
  return `<div class="${cls}" data-deed="${h(sentence.id)}" tabindex="0" title="${h([STATE_WORDS[sentence.state], ...anchors].filter(Boolean).join("\n"))}"><span class="dz-mk ${tone}"></span><span class="dz-words">${words}</span>${margin}</div>${on || sentence.state === "working" || sentence.state === "false" || (sentence.state === "true" && sentence.madeAt) ? under(sentence, ui) : ""}`;
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
  return `<p class="deed-lead">What ${h(name)} does, in plain words. Every sentence is held true by the code beneath it.${rewriting}</p>${sections(deed, ui)}`;
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
  return [plural(written.length, "sentence"), `${held} true`, wishes ? plural(wishes, "wish").replace("wishs", "wishes") : ""].filter(Boolean).join(" · ");
}
