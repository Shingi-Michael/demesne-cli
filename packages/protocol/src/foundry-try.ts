/// Foundry tries its own page (pass 164 E): the steps the model writes for
/// foundry_try, checked here so the daemon (which refuses bad steps) and the
/// app (which runs them, apps/desktop/electron/foundry-try.ts) agree.
export type TryStep =
  | { click: string } | { hover: string } | { type: string; into?: string }
  | { key: string } | { scroll: number } | { wait: number };
export const TRY_MAX_STEPS = 12;
export const TRY_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

const short = (text: string, n = 40) => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean; };
/// A step as the result names it: click “Add”, type “Milk” into “Item”.
export function stepName(step: TryStep): string {
  if ("click" in step) return `click “${short(step.click)}”`;
  if ("hover" in step) return `hover “${short(step.hover)}”`;
  if ("type" in step) return `type “${short(step.type)}”${step.into ? ` into “${short(step.into)}”` : ""}`;
  if ("key" in step) return `press ${step.key}`;
  if ("scroll" in step) return `scroll ${step.scroll >= 0 ? "down" : "up"} ${Math.abs(step.scroll)}px`;
  return `wait ${step.wait}ms`;
}

/// The model's steps, checked: anything unknown is an error the model can fix.
export function parseSteps(value: unknown): TryStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error("steps must be a list of one to 12 steps");
  if (value.length > TRY_MAX_STEPS) throw new Error(`At most ${TRY_MAX_STEPS} steps`);
  const text = (v: unknown, what: string) => { if (typeof v !== "string" || !v.trim() || v.length > 500) throw new Error(`${what} must be text of up to 500 characters`); return v; };
  return value.map((raw, index): TryStep => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Step ${index + 1} must be an object`);
    const step = raw as Record<string, unknown>;
    if ("click" in step) return { click: text(step.click, "click") };
    if ("hover" in step) return { hover: text(step.hover, "hover") };
    if ("type" in step) {
      if (typeof step.type !== "string" || step.type.length > 2000) throw new Error("type must be text of up to 2000 characters");
      return step.into === undefined ? { type: step.type } : { type: step.type, into: text(step.into, "into") };
    }
    if ("key" in step) {
      const key = TRY_KEYS.find((name) => name.toLowerCase() === String(step.key).toLowerCase());
      if (!key) throw new Error(`key must be one of ${TRY_KEYS.join(", ")}`);
      return { key };
    }
    if ("scroll" in step) { const n = Number(step.scroll); if (!Number.isFinite(n) || Math.abs(n) > 20000) throw new Error("scroll is pixels down (negative for up)"); return { scroll: Math.round(n) }; }
    if ("wait" in step) { const n = Number(step.wait); if (!Number.isFinite(n) || n < 0) throw new Error("wait is milliseconds"); return { wait: Math.min(Math.round(n), 2000) }; }
    throw new Error(`Step ${index + 1} needs one of click, type, key, scroll, hover or wait`);
  });
}
