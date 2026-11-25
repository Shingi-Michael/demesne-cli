/// The design guide every Foundry page follows. Three layers, later ones
/// winning: Demesne's own rules (below), your guide for every chat
/// (~/.demesne/design.md) and the project's (.demesne/design.md, or a
/// DESIGN.md at its root). It rides in the system prompt from the moment a
/// chat has Foundry's tools, as numbered rules a model can hold and be held
/// to; it used to be one paragraph inside foundry_save's description, read
/// like API notes and with nowhere for the person's own rules to go.
/// A rule said in a chat ("never purple", "always hairlines") is kept with
/// the remember tool (design: true), so it holds from the next mockup on.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectLook } from "@demesne/protocol";
import { projectLookBlock } from "./project-look.ts";

/// Where a project keeps its guide; the first that exists is read.
export const DESIGN_GUIDE_FILES = [".demesne/design.md", "DESIGN.md"] as const;
/// A guide is rules, not a book: past this it is cut, and says so.
export const DESIGN_GUIDE_MAX_BYTES = 8 * 1024;
export const DESIGN_RULES_HEADING = "## Rules";

/// Demesne's rules, in the order a designer would check them. Each is one
/// thing to do and can be pointed at by its number.
export const DESIGN_RULES: readonly string[] = [
  "Direction first: pick who it is for and the mood in a few words, and let that decide the rest. Make it look designed, never like a template; the kit is the floor, not the ceiling. Title of two to four words.",
  "One focal point and a clear hierarchy: one thing leads (an oversized number or headline, a bold colour field, an SVG illustration or a striking chart), dense areas sit against quiet ones.",
  "Type from the kit's scale and nothing else: var(--text-xs|sm|md|lg|xl|display) (12 14 18 24 32 48px; one bigger hero size at most), tight leading and tracking on big text. A display face from Google Fonts when it fits.",
  "Space from the kit's scale and nothing else: var(--space-1…8) (4 8 12 16 24 32 48 64px).",
  "A small palette: the kit's ink tints, --accent and at most two colours of your own (tints of them via color-mix); set --accent (and --ink/--paper for a tinted page) on :root. Small text never lighter than --muted.",
  "Layout is even: one grid whose columns share edges, the same gap between every item in a row, cards side by side the same height (stretch them), padding the same on both sides, centred things truly centred. Break symmetry only on purpose and still on the grid.",
  "Lists and settings are rows with hairline dividers in one rounded box, one line per row; state is a single mark with a word beside it, never colour alone.",
  "Depth and detail where they earn it: layered surfaces, soft shadows only on things that float, hover/selected/empty states, small SVG icons. Write as much CSS of your own as the design needs, on the kit's variables.",
  "Real content, never lorem ipsum: believable names, numbers and dates.",
  "A mockup is the working thing at real size, not a poster of it: no headline or notes above it, it fills the page, and the controls the ask is about work (tabs go somewhere, inputs take typing); the rest are drawn and may stay still. Several screens are one page, in <d-flow> (kit:parts).",
  "It reads and works from about 620px wide up, with no sideways scroll; write no phone layout unless the ask is a phone screen. Text has 4.5:1 contrast on what is behind it (3:1 from 24px up); on a phone screen anything to tap is at least 44px each way.",
  "Offer options: unless the ask fixes one exact thing (\"make this button blue\"), show two to five different variants (different shapes, never more than five), each named, in one <d-compare> with recommended on your pick; say in the chat which and why. Asked for styles or looks, or a first page with no look to start from: one page in <d-styles> instead (kit:parts).",
  "Motion: parts arrive once by data-move (kit:parts), controls respond by CSS transition (140 to 220ms), nothing loops; none under prefers-reduced-motion: reduce.",
  "Avoid stock AI looks: purple-on-white gradients, glassmorphism, emoji bullets, a generic hero over three cards.",
  "Every state it can be in is designed, not only the happy one: a control has hover, pressed, focused and disabled; a list or a screen has empty, loading and error. Show the ones the ask touches, reached by using the page; never a state switcher in it.",
  "Words are part of the design. A button starts with a verb and says what happens (\"Save changes\", never \"Submit\" or \"OK\"). An error says what happened, why, and how to fix it. An empty state says what goes here and how to start. A confirmation names the thing (\"Delete 3 files?\", never \"Are you sure?\") and its buttons say the two outcomes. One word for one thing throughout.",
];

/// How Demesne itself looks, for a mockup of Demesne (docs/interface-design.md).
export const DEMESNE_LOOK = "Something that exists (the person's app, site or screen, Demesne included) is mocked from the real thing, never from memory. "
  + "Look first, once: a capture or picture already in this chat counts; otherwise capture_window its window, or read its real stylesheet and that screen's markup in the project. "
  + "Then draw that screen as it is today, with its real colours, type sizes, spacing, radii and words, and change only what the ask is about. "
  + "Show it as options on one page: \"Today\" first, exactly as it is, then the change, so the change is the only difference. It has failed if it does not read as their app with one thing changed, however good it looks. "
  + "Demesne itself: capture_window with application Demesne, then build on <d-demesne> with views for its tabs and chats: it is drawn with the app's own markup and styles, so change only the piece the ask is about (foundry_read id \"kit:parts\" names its pieces); "
  + "no side panels and no menus where a direct action on the row fits; everything lives in the sidebar, the conversation column and the composer; "
  + "add as little surface as possible (fold a new fact into an existing row, chip or tooltip before adding anything); "
  + "blue is the primary action and new replies, amber needs you, green success, red failure, pink where you are; the Mac's own window buttons stay.";

/// Pass 223 A: asked to look at a design that exists and show what needs
/// work, the model reviews before it draws and mocks only the parts that
/// matter, each with options and a pick.
export const REVIEW_HOW = "Asked to look at something that exists and show what needs work (or to redesign it with no piece named): review before you draw. "
  + "Critique the real screen as you do your own pages, rate each problem, and keep the two or three parts that most need work, most important first (one only if nothing else comes close). "
  + "A part is the smallest piece that holds the problem (a bar, a card, a row), never the whole page. "
  + "Start from a real picture (one in this chat, else capture_window, the browser's, or an attached one; else ask for a screenshot). "
  + "Save one <d-review> page (foundry_read id \"kit:parts\"): the picture with those pieces boxed, then each cut from it as \"Today\" beside two or three options and your pick, and one plain line on what is wrong. "
  + "Redraw nothing else. A named piece skips the ranking.";

export interface DesignGuide {
  /// Shown to the model so it knows where a rule came from and where to add one.
  path: string;
  content: string;
  truncated: boolean;
}

const cache = new Map<string, { mtimeMs: number; size: number; guide: DesignGuide | null }>();

function read(absolute: string, shown: string): DesignGuide | null {
  if (!existsSync(absolute)) { cache.delete(absolute); return null; }
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(absolute); } catch { return null; }
  if (!stat.isFile()) return null;
  const cached = cache.get(absolute);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.guide;
  let buffer: Buffer;
  try { buffer = readFileSync(absolute); } catch { return null; }
  const truncated = buffer.byteLength > DESIGN_GUIDE_MAX_BYTES;
  const content = (truncated ? buffer.subarray(0, DESIGN_GUIDE_MAX_BYTES) : buffer).toString("utf8").trim();
  const guide = content ? { path: shown, content, truncated } : null;
  cache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, guide });
  return guide;
}

/// The person's guides for this chat: theirs for every chat, then the
/// project's. In a chat outside a project the two are the same file.
export function loadDesignGuides(workspaceRoot: string | undefined, home = homedir()): DesignGuide[] {
  const guides: DesignGuide[] = [];
  const everywhere = join(home, DESIGN_GUIDE_FILES[0]);
  const own = read(everywhere, `~/${DESIGN_GUIDE_FILES[0]}`);
  if (own) guides.push(own);
  if (workspaceRoot && resolve(workspaceRoot) !== resolve(home)) {
    for (const name of DESIGN_GUIDE_FILES) {
      const project = read(join(workspaceRoot, name), name);
      if (project) { guides.push(project); break; }
    }
  }
  return guides;
}

/// The guide as the model reads it: Demesne's numbered rules, then the
/// person's own, which win.
export function designGuideBlock(guides: readonly DesignGuide[], where = DESIGN_GUIDE_FILES[0] as string, look: ProjectLook | null = null): string {
  const theirs = guides.map((guide) => `From ${guide.path}:\n${guide.content}${guide.truncated ? "\n[cut at 8 KB; keep the guide to rules]" : ""}`).join("\n\n");
  return "# Design guide\n\nEvery Foundry page you design (kind html or svg) follows these rules. Check your page against them by number before you answer, and fix what breaks one.\n"
    + DESIGN_RULES.map((rule, index) => `${index + 1}. ${rule}`).join("\n")
    + `\n${DEMESNE_LOOK}\n${REVIEW_HOW}\n`
    + (theirs
      ? `\nThe person's own design rules. They win over every rule above where the two differ, and they are not suggestions:\n\n${theirs}\n`
      : "")
    + `\nWhen the person gives a lasting rule about how things should look ("never…", "always…", "I don't like…" said as a standing preference), keep it with the remember tool and design: true: it is added to ${where} and holds for every later mockup. A one-off ask about this page is not a rule.`
    + (guides.some((guide) => learnedRules(guide.content).length) ? `\n${LEARNED_HOW}` : "")
    + (guides.some((guide) => pickedStyle(guide.content)) ? `\n${STYLE_HOW}` : "")
    // Piece 1 of pass 274: the project's own look, read from its code. A style they picked wins over it.
    + (look ? `\n\n${projectLookBlock(look)}` : "");
}

/// Pass 246 A, a range of styles: the style the person picked from a page of
/// styles is kept in the project's design guide under this heading, one per
/// project, so every later mockup there is drawn in it.
export const STYLE_HEADING = "## Style";
export const STYLE_HOW = `Under "${STYLE_HEADING.slice(3)}" is the look they picked for this project: draw new pages in its values (set them on :root) and name it in why.followed, unless they ask for other styles; then it is one of the styles you show.`;

/// The name of the style a guide holds, or "" when it holds none.
export function pickedStyle(content: string): string {
  const lines = content.split("\n"), section = sectionOf(lines, STYLE_HEADING);
  if (!section) return "";
  const first = lines.slice(section.start + 1, section.end).find((text) => text.trim());
  return first ? first.trim().replace(/\s+\([^()]*\)\.?.*$/, "").replace(/[.\s]+$/, "") : "";
}

/// The guide with its Style section set to this style (made at the end when
/// missing; the one before it is replaced, since a project has one style).
export function withStyle(content: string, name: string, from: string, styleLines: readonly string[]): string {
  const block = [STYLE_HEADING, "", `${name}${from ? ` (${from})` : ""}. Foundry draws new mockups here in it. Edit any line, or pick another style to replace it.`, "", ...styleLines];
  if (!content.trim()) return `# Design guide\n\n${block.join("\n")}\n`;
  const lines = content.split("\n"), section = sectionOf(lines, STYLE_HEADING);
  if (!section) return `${content.replace(/\s+$/, "")}\n\n${block.join("\n")}\n`;
  const rest = lines.slice(section.end);
  return [...lines.slice(0, section.start), ...block, ...(rest.length ? ["", ...rest] : [""])].join("\n");
}

/// Keeps a picked style in the guide of the chat's folder.
export function saveStyle(workspaceRoot: string, name: string, from: string, styleLines: readonly string[]): { path: string; saved: boolean } {
  const file = DESIGN_GUIDE_FILES.find((known) => existsSync(join(workspaceRoot, known))) ?? DESIGN_GUIDE_FILES[0];
  const path = join(workspaceRoot, file);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = withStyle(before, name, from, styleLines);
  if (after === before) return { path: file, saved: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after, "utf8");
  return { path: file, saved: true };
}

/// Pass 245 A, taste that carries over: what the person kept, picked and
/// asked for twice on this project's mockups, kept as short lines in its
/// design guide under this heading, so the next mockup starts from them.
export const LEARNED_HEADING = "## Learned from your notes";
const LEARNED_INTRO = "Foundry adds these from what you keep, pick and ask for twice on mockups here. Edit or delete any line.";
/// Twelve lines a project: past that the oldest goes.
export const LEARNED_MAX = 12;
export const LEARNED_HOW = `Lines under "${LEARNED_HEADING.slice(3)}" are this person's taste from earlier mockups here: follow each one that applies, and name the ones a page follows in why.followed. When they say to forget one, remember {design: true, forget: true, rule: some of its words}.`;

const sectionOf = (lines: string[], heading: string): { start: number; end: number } | null => {
  const start = lines.findIndex((text) => text.trim() === heading);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  return { start, end };
};
/// A learned line without its bullet and without where it came from.
const ruleOf = (line: string) => line.trim().replace(/^[-*]\s+/, "").replace(/\s+\([^()]*\)$/, "").trim();
const same = (a: string, b: string) => a.replace(/[.\s]+$/, "").toLowerCase() === b.replace(/[.\s]+$/, "").toLowerCase();

/// The learned lines of a guide, oldest first, as they are written (with where each came from).
export function learnedRules(content: string): string[] {
  const lines = content.split("\n"), section = sectionOf(lines, LEARNED_HEADING);
  if (!section) return [];
  return lines.slice(section.start + 1, section.end).filter((text) => /^\s*[-*]\s+\S/.test(text)).map((text) => text.trim().replace(/^[-*]\s+/, ""));
}

/// The guide with a learned line added under its heading (file and heading
/// made when missing): `rule (from)`. A line that says the same is left as it
/// is; `replaces` names an older line (some of its words) this one takes the
/// place of; past twelve the oldest goes. Unchanged when nothing changes.
export function withLearnedRule(content: string, rule: string, from: string, replaces = ""): string {
  const line = `- ${rule}${from ? ` (${from})` : ""}`;
  const block = `${LEARNED_HEADING}\n\n${LEARNED_INTRO}\n\n${line}\n`;
  if (!content.trim()) return `# Design guide\n\n${block}`;
  const lines = content.split("\n"), section = sectionOf(lines, LEARNED_HEADING);
  if (!section) return `${content.replace(/\s+$/, "")}\n\n${block}`;
  const bullets = () => { const at: number[] = []; for (let i = section.start + 1; i < section.end; i++) if (/^\s*[-*]\s+\S/.test(lines[i]!)) at.push(i); return at; };
  const old = replaces.trim().toLowerCase();
  const replaced = old ? bullets().find((index) => ruleOf(lines[index]!).toLowerCase().includes(old)) : undefined;
  if (bullets().some((index) => index !== replaced && same(ruleOf(lines[index]!), rule))) return content;
  if (replaced !== undefined) lines[replaced] = line;
  else {
    let at = section.end;
    while (at > section.start + 1 && !lines[at - 1]!.trim()) at--;
    lines.splice(at, 0, ...(at === section.start + 1 ? ["", line] : [line]));
    section.end += at === section.start + 1 ? 2 : 1;
    for (let over = bullets(); over.length > LEARNED_MAX; over = bullets()) { lines.splice(over[0]!, 1); section.end--; }
  }
  return lines.join("\n");
}

/// The guide without the learned line that holds `words` (the newest such line). Unchanged when none does.
export function withoutLearnedRule(content: string, words: string): string {
  const lines = content.split("\n"), section = sectionOf(lines, LEARNED_HEADING), wanted = words.replace(/[.\s]+$/, "").trim().toLowerCase();
  if (!section || !wanted) return content;
  for (let index = section.end - 1; index > section.start; index--) {
    if (!/^\s*[-*]\s+\S/.test(lines[index]!) || !lines[index]!.toLowerCase().includes(wanted)) continue;
    lines.splice(index, 1);
    return lines.join("\n");
  }
  return content;
}

/// The learned lines of the guide in a chat's folder (the project's, or the person's own outside a project).
export function learnedIn(workspaceRoot: string): string[] {
  const name = DESIGN_GUIDE_FILES.find((file) => existsSync(join(workspaceRoot, file)));
  if (!name) return [];
  try { return learnedRules(readFileSync(join(workspaceRoot, name), "utf8")); } catch { return []; }
}

/// Adds a learned line to the guide of the chat's folder.
export function saveLearnedRule(workspaceRoot: string, rule: string, from: string, replaces = ""): { path: string; saved: boolean } {
  const name = DESIGN_GUIDE_FILES.find((file) => existsSync(join(workspaceRoot, file))) ?? DESIGN_GUIDE_FILES[0];
  const path = join(workspaceRoot, name);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = withLearnedRule(before, rule, from, replaces);
  if (after === before) return { path: name, saved: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after, "utf8");
  return { path: name, saved: true };
}

/// The guide file with `rule` added under "## Rules" (the file and the
/// heading are made when missing). Unchanged when the rule is already there.
export function withDesignRule(content: string, rule: string): string {
  const line = `- ${rule}`;
  if (!content.trim()) return `# Design guide\n\nRules every mockup follows. One per line; edit freely.\n\n${DESIGN_RULES_HEADING}\n\n${line}\n`;
  const lines = content.split("\n");
  if (lines.some((text) => text.trim().toLowerCase() === line.toLowerCase())) return content;
  const heading = lines.findIndex((text) => text.trim() === DESIGN_RULES_HEADING);
  if (heading === -1) return `${content.replace(/\s+$/, "")}\n\n${DESIGN_RULES_HEADING}\n\n${line}\n`;
  let end = heading + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  let at = end;
  while (at > heading + 1 && !lines[at - 1]!.trim()) at--;
  lines.splice(at, 0, ...(at === heading + 1 ? ["", line] : [line]));
  return lines.join("\n");
}

/// Adds a rule to the guide of the chat's folder: the project's, or the
/// person's own when the chat is outside a project (its folder is home).
export function saveDesignRule(workspaceRoot: string, rule: string): { path: string; saved: boolean } {
  const name = DESIGN_GUIDE_FILES.find((file) => existsSync(join(workspaceRoot, file))) ?? DESIGN_GUIDE_FILES[0];
  const path = join(workspaceRoot, name);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = withDesignRule(before, rule);
  if (after === before) return { path: name, saved: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after, "utf8");
  return { path: name, saved: true };
}

/// Test hook: forget what was read.
export function clearDesignGuideCache(): void { cache.clear(); }

/// Drops a learned line the person asked to forget. `left` is what is still learned.
export function forgetLearnedRule(workspaceRoot: string, words: string): { path: string; forgotten: boolean; left: string[] } {
  const name = DESIGN_GUIDE_FILES.find((file) => existsSync(join(workspaceRoot, file))) ?? DESIGN_GUIDE_FILES[0];
  const path = join(workspaceRoot, name);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = withoutLearnedRule(before, words);
  if (after !== before) writeFileSync(path, after, "utf8");
  return { path: name, forgotten: after !== before, left: learnedRules(after) };
}
