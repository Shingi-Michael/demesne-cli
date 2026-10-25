/// Your plan's limit (pass 75 D). A subscription provider (ChatGPT) reports
/// how much of its short and weekly windows is used. The provider reads it
/// off each response, the daemon serves it at GET /v1/limits, the composer
/// shows it once it passes half, and Drive pauses its own runs near the end.

export interface PlanWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /// When the window starts over (ISO); null when not reported.
  resetsAt: string | null;
}
export interface PlanLimits {
  provider: string;
  /// "plus", "pro"…, when the provider names it.
  plan: string | null;
  /// The short window (5 hours) and the long one (a week).
  primary: PlanWindow | null;
  secondary: PlanWindow | null;
  /// When it was read.
  at: string;
}
export interface PlanLimitsResponse { limits: PlanLimits[] }

/// Under this nothing shows; from AMBER it turns amber; at DRIVE_PAUSE Drive
/// stops starting runs of its own, so it never spends the last of a window.
export const PLAN_LIMIT_SHOWN = 50;
export const PLAN_LIMIT_AMBER = 75;
export const PLAN_LIMIT_DRIVE_PAUSE = 90;

const percent = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(100, n) : null;
};
const positive = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
/// A reset given as unix seconds (or ms), or as seconds from now.
function resetTime(at: unknown, after: unknown, now: number): string | null {
  const absolute = positive(at);
  if (absolute !== null) return new Date(absolute < 1e12 ? absolute * 1000 : absolute).toISOString();
  const relative = positive(after);
  return relative !== null ? new Date(now + relative * 1000).toISOString() : null;
}
const plan = (value: unknown) => typeof value === "string" && /^[a-z0-9_-]{1,32}$/i.test(value) ? value.toLowerCase() : null;

/// The x-codex-{primary,secondary}-* headers the ChatGPT plan route sends.
export function planLimitsFromHeaders(provider: string, headers: Headers, now = Date.now()): PlanLimits | null {
  const window = (name: "primary" | "secondary"): PlanWindow | null => {
    const used = percent(headers.get(`x-codex-${name}-used-percent`));
    if (used === null) return null;
    return { usedPercent: used, windowMinutes: positive(headers.get(`x-codex-${name}-window-minutes`)),
      resetsAt: resetTime(headers.get(`x-codex-${name}-reset-at`), headers.get(`x-codex-${name}-reset-after-seconds`), now) };
  };
  const primary = window("primary"), secondary = window("secondary");
  if (!primary && !secondary) return null;
  return { provider, plan: plan(headers.get("x-codex-plan-type")), primary, secondary, at: new Date(now).toISOString() };
}

/// The same numbers as a stream event: { type: "codex.rate_limits", plan_type, rate_limits: { primary, secondary } }.
export function planLimitsFromEvent(provider: string, event: Record<string, unknown>, now = Date.now()): PlanLimits | null {
  const limits = event.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const window = (value: unknown): PlanWindow | null => {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const used = percent(item.used_percent);
    if (used === null) return null;
    return { usedPercent: used, windowMinutes: positive(item.window_minutes),
      resetsAt: resetTime(item.resets_at ?? item.reset_at, item.resets_in_seconds ?? item.reset_after_seconds, now) };
  };
  const { primary, secondary } = limits as Record<string, unknown>;
  const read = { primary: window(primary), secondary: window(secondary) };
  if (!read.primary && !read.secondary) return null;
  return { provider, plan: plan(event.plan_type), ...read, at: new Date(now).toISOString() };
}

/// The windows still counting: one whose reset has passed starts over at 0.
export function planWindows(limits: PlanLimits, now = Date.now()): { name: string; window: PlanWindow }[] {
  return ([["primary", limits.primary], ["secondary", limits.secondary]] as const).flatMap(([key, window]) =>
    window && !(window.resetsAt && Date.parse(window.resetsAt) <= now)
      ? [{ name: windowName(window.windowMinutes, key === "primary" ? "5-hour" : "weekly"), window }] : []);
}

/// The fuller of the windows, which is the one that bites first.
export function planUsed(limits: PlanLimits, now = Date.now()): { name: string; window: PlanWindow } | null {
  return planWindows(limits, now).reduce<{ name: string; window: PlanWindow } | null>((top, item) => !top || item.window.usedPercent > top.window.usedPercent ? item : top, null);
}

export function windowName(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes >= 10_080 - 60 && minutes <= 10_080 + 60) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}
