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
  "A mockup is the working thing at real size, not a poster of it: no headline or notes above it, it fills the page, and every control does something (tabs and links go somewhere, inputs take typing, buttons change what shows).",
  "It reads and works about 620px wide, and at phone width with no horizontal scroll. Text has 4.5:1 contrast on what is behind it (3:1 from 24px up), and on a phone anything to tap is at least 44px each way.",
  "Options: two or three genuinely different directions (never more than three), each named, in one <d-compare> with recommended set on the one you would pick; say in the chat which and why.",
  "Motion with anime.js: things arrive once (300 to 600ms, staggered), respond fast (140 to 220ms), nothing loops; none under prefers-reduced-motion: reduce.",
  "Avoid stock AI looks: purple-on-white gradients, glassmorphism, emoji bullets, a generic hero over three cards.",
  "Every state it can be in is designed, not only the happy one: a control has hover, pressed, focused and disabled; a list or a screen has empty, loading and error. Show the ones the ask touches, and make them reachable by using the page.",
  "Words are part of the design. A button starts with a verb and says what happens (\"Save changes\", never \"Submit\" or \"OK\"). An error says what happened, why, and how to fix it. An empty state says what goes here and how to start. A confirmation names the thing (\"Delete 3 files?\", never \"Are you sure?\") and its buttons say the two outcomes. One word for one thing throughout.",
];

/// How Demesne itself looks, for a mockup of Demesne (docs/interface-design.md).
export const DEMESNE_LOOK = "Something that exists (the person's app, site or screen, Demesne included) is mocked from the real thing, never from memory. "
  + "Look first: capture_window its window, or read its real stylesheet and that screen's markup in the project; a picture the person attached counts. "
  + "Then draw that screen as it is today, with its real colours, type sizes, spacing, radii and words, and change only what the ask is about. "
  + "Show it as options on one page: \"Today\" first, exactly as it is, then the change, so the change is the only difference. It has failed if it does not read as their app with one thing changed, however good it looks. "
  + "Demesne itself: capture_window with application Demesne, then build on <d-demesne> with views for its tabs and chats: it is drawn with the app's own markup and styles, so change only the piece the ask is about (foundry_read id \"kit:parts\" names its pieces); "
  + "no side panels and no menus where a direct action on the row fits; everything lives in the sidebar, the conversation column and the composer; "
  + "add as little surface as possible (fold a new fact into an existing row, chip or tooltip before adding anything); "
  + "blue is the primary action and new replies, amber needs you, green success, red failure, pink where you are; the Mac's own window buttons stay.";

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
export function designGuideBlock(guides: readonly DesignGuide[], where = DESIGN_GUIDE_FILES[0] as string): string {
  const theirs = guides.map((guide) => `From ${guide.path}:\n${guide.content}${guide.truncated ? "\n[cut at 8 KB; keep the guide to rules]" : ""}`).join("\n\n");
  return "# Design guide\n\nEvery Foundry page you design (kind html or svg) follows these rules. Check your page against them by number before you answer, and fix what breaks one.\n"
    + DESIGN_RULES.map((rule, index) => `${index + 1}. ${rule}`).join("\n")
    + `\n${DEMESNE_LOOK}\n`
    + (theirs
      ? `\nThe person's own design rules. They win over every rule above where the two differ, and they are not suggestions:\n\n${theirs}\n`
      : "")
    + `\nWhen the person gives a lasting rule about how things should look ("never…", "always…", "I don't like…" said as a standing preference), keep it with the remember tool and design: true: it is added to ${where} and holds for every later mockup. A one-off ask about this page is not a rule.`;
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
