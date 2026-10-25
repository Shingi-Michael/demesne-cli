import { expect, test } from "bun:test";
import { planLimitsFromEvent, planLimitsFromHeaders, planUsed, planWindows, windowName } from "../src/plan-limits.ts";

const now = Date.parse("2026-10-25T12:00:00Z");

test("reads the plan's windows from the response headers", () => {
  const limits = planLimitsFromHeaders("ChatGPT", new Headers({
    "x-codex-primary-used-percent": "78.4", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600",
    "x-codex-secondary-used-percent": "41", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(now / 1000 + 86_400 * 3),
    "x-codex-plan-type": "Plus",
  }), now);
  expect(limits).toEqual({ provider: "ChatGPT", plan: "plus", at: new Date(now).toISOString(),
    primary: { usedPercent: 78.4, windowMinutes: 300, resetsAt: "2026-10-25T13:00:00.000Z" },
    secondary: { usedPercent: 41, windowMinutes: 10080, resetsAt: "2026-10-28T12:00:00.000Z" } });
  expect(planUsed(limits!, now)).toMatchObject({ name: "5-hour", window: { usedPercent: 78.4 } });
  expect(planLimitsFromHeaders("ChatGPT", new Headers({ "content-type": "text/event-stream" }), now)).toBeNull();
  expect(planLimitsFromHeaders("ChatGPT", new Headers({ "x-codex-primary-used-percent": "nope" }), now)).toBeNull();
});

test("reads the same numbers from a rate-limit stream event", () => {
  const limits = planLimitsFromEvent("ChatGPT", { type: "codex.rate_limits", plan_type: "pro",
    rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 60 }, secondary: { used_percent: 93, window_minutes: 10080 } } }, now);
  expect(limits?.plan).toBe("pro");
  expect(planUsed(limits!, now)).toMatchObject({ name: "weekly", window: { usedPercent: 93 } });
  expect(planLimitsFromEvent("ChatGPT", { type: "codex.rate_limits" }, now)).toBeNull();
});

test("a window whose reset has passed starts over", () => {
  const limits = planLimitsFromHeaders("ChatGPT", new Headers({ "x-codex-primary-used-percent": "95", "x-codex-primary-reset-after-seconds": "60", "x-codex-secondary-used-percent": "30" }), now)!;
  expect(planUsed(limits, now)!.window.usedPercent).toBe(95);
  expect(planWindows(limits, now + 120_000).map((item) => item.name)).toEqual(["weekly"]);
  expect(planUsed(limits, now + 120_000)!.window.usedPercent).toBe(30);
});

test("names windows by their length", () => {
  expect([windowName(300, "x"), windowName(10080, "x"), windowName(1440, "x"), windowName(null, "weekly"), windowName(45, "x")]).toEqual(["5-hour", "weekly", "1-day", "weekly", "45-minute"]);
});
