/// Pass 263 A, every variant explained: when the model saves a mockup it
/// writes a walkthrough for each variant (each tab), the way Claude Code
/// explains what it made: what it is, its parts by number (each pinned to the
/// piece of the page it names), why it is shaped so, how it differs from the
/// other variants, and what it would do next. Foundry shows the shown tab's
/// walkthrough under the mockup and numbers the parts on the page itself.

export interface FoundryWalkPart {
  name: string;
  says: string;
  /// A CSS selector for the piece of the page the part names, numbered there.
  at?: string;
}

export interface FoundryWalk {
  /// The variant (data-option or style name) it explains; absent on a page with one.
  option?: string;
  what: string;
  parts: FoundryWalkPart[];
  why: string;
  differs?: string;
  next?: string;
}

/// At most this many variants (tabs) on one mockup.
export const FOUNDRY_MAX_VARIANTS = 5;
export const FOUNDRY_MAX_WALK_PARTS = 6;

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/// A walkthrough as given (to a save, or read back from storage), cleaned:
/// undefined when there is none. Parts without a name or words are dropped.
export function cleanWalk(value: unknown): FoundryWalk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const walk = value.filter(isRecord).slice(0, FOUNDRY_MAX_VARIANTS).map((item): FoundryWalk => {
    const option = text(item.option, 120), differs = text(item.differs, 400), next = text(item.next, 400);
    const parts = (Array.isArray(item.parts) ? item.parts : []).filter(isRecord).map((part): FoundryWalkPart => {
      const at = text(part.at, 200);
      return { name: text(part.name, 80), says: text(part.says, 300), ...(at ? { at } : {}) };
    }).filter((part) => part.name && part.says).slice(0, FOUNDRY_MAX_WALK_PARTS);
    return { ...(option ? { option } : {}), what: text(item.what, 500), parts, why: text(item.why, 500), ...(differs ? { differs } : {}), ...(next ? { next } : {}) };
  }).filter((item) => item.what || item.parts.length);
  return walk.length ? walk : undefined;
}

/// The walkthrough for one variant: the one naming it (exactly, or the start
/// of its name, as "B" names "B · Yearly first"), else the only one there is.
export function walkFor(walk: readonly FoundryWalk[] | undefined, option: string | undefined): FoundryWalk | undefined {
  if (!walk?.length) return undefined;
  if (!option) return walk[0];
  {
    const said = option.trim().toLowerCase();
    const found = walk.find((item) => item.option?.toLowerCase() === said)
      ?? walk.find((item) => !!item.option && (said.startsWith(item.option.toLowerCase()) || item.option.toLowerCase().startsWith(said)));
    if (found) return found;
  }
  return walk.length === 1 && !walk[0]!.option ? walk[0] : undefined;
}

/// What a walkthrough lacks for a page with these variants, as a refusal; "" when it is whole.
export function walkProblem(walk: readonly FoundryWalk[] | undefined, variants: readonly string[]): string {
  const how = "Hint: why.walkthrough, one entry per variant: {option, what, parts: [{name, says, at}], why, differs, next}; what is a sentence on what it is and who it is for, each part names a piece of the page and says what it does (at is its CSS selector so Foundry numbers it on the page), why is why it is shaped so";
  if (!walk?.length) return `[invalid_input] Explain what you made: why.walkthrough. ${how}`;
  const named = variants.filter((name) => !/^today\b/i.test(name));
  if (named.length > 1) {
    const missing = named.filter((name) => !walkFor(walk.filter((item) => item.option), name));
    if (missing.length) return `[invalid_input] The walkthrough has no entry for ${missing.map((name) => `"${name}"`).join(", ")}. ${how}; differs says how each variant differs from the others`;
    const flat = walk.filter((item) => item.option && !item.differs);
    if (flat.length) return `[invalid_input] Say how ${flat.map((item) => `"${item.option}"`).join(", ")} differs from the other variants: differs. ${how}`;
  }
  const thin = walk.filter((item) => !item.what || item.parts.length < 2 || !item.why);
  if (thin.length) return `[invalid_input] Each walkthrough needs what, why and at least two parts${thin[0]!.option ? ` (${thin.map((item) => `"${item.option}"`).join(", ")})` : ""}. ${how}`;
  return "";
}
