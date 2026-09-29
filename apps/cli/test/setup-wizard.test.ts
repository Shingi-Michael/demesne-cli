import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter } from "@demesne/brand";
import type { ProbeResult } from "../src/provider-probe.ts";
import { initialWizard, reduceWizard, renderWizard, selectedModel, wizardAuthenticated, wizardCustomProbed, wizardProbed, wizardSaved, type WizardKey, type WizardState } from "../src/setup-wizard.ts";

const llama: ProbeResult = { target: { id: "llama.cpp", label: "llama.cpp", url: "http://127.0.0.1:11436/v1" }, reachable: true,
  models: [{ id: "small", provider: "llama.cpp", contextWindow: 32_768 }, { id: "large", provider: "llama.cpp", contextWindow: 100_096 }] };
const ollama: ProbeResult = { target: { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434/v1" }, reachable: false, models: [] };
const screen = (state: WizardState, width = 100, height = 30) => stripVTControlCharacters(renderWizard(state, width, height, createPainter(true)).join("\n"));
function press(state: WizardState, ...keys: Array<string | WizardKey>) {
  let effect;
  for (const key of keys) {
    // Like readline: letters and digits carry their name as well as the text.
    const named = typeof key === "string" && key.length === 1 ? (/^[0-9a-z]$/i.test(key) ? { name: key.toLowerCase() } : {}) : undefined;
    const next = typeof key === "string" ? reduceWizard(state, named ?? { name: key }, key.length === 1 ? key : "") : reduceWizard(state, key);
    state = next.state; effect = next.effect;
  }
  return { state, effect };
}

describe("setup wizard", () => {
  test("browser sign-in stays within Provider, can cancel/retry, and discovers model limits without credentials in state", () => {
    let { state, effect } = press(wizardProbed(initialWizard("/c"), [llama]), "up", "return");
    expect(effect).toEqual({ kind: "login" }); expect(state.step).toBe("auth");
    expect(screen(state)).toContain("Connect OpenRouter");
    expect(press(state, "escape").effect).toEqual({ kind: "cancel-login" });
    expect(press(state, "return").effect).toBeUndefined();
    state = { ...state, auth: { url: "", status: "failed", message: "Authorization declined" } };
    expect(press(state, "r").effect).toEqual({ kind: "login" });
    state = wizardAuthenticated(state, { ...llama, models: [{ id: "hosted", provider: "OpenRouter", contextWindow: 262144, maxOutputTokens: 131072 }] });
    ({ state } = press(state, "return"));
    expect(state.review.maxOutputTokens).toBe(131072);
    expect(screen(state)).toContain("131,072");
    const compact = wizardProbed(initialWizard("/c"), [llama, ollama, ollama]);
    expect(screen(press(compact, "up").state, 60, 14)).toContain("OpenRouter");
  });
  test("lists reachable servers first, blocks unreachable ones and picks the largest-context model", () => {
    let state = wizardProbed(initialWizard("/home/me/.demesne/config.toml"), [ollama, llama]);
    expect(screen(state)).toContain("Found 1 local server");
    expect(screen(state).indexOf("llama.cpp")).toBeLessThan(screen(state).indexOf("Ollama"));
    expect(screen(state)).toContain("detected");
    ({ state } = press(state, "down", "return"));
    expect(state.step).toBe("provider");
    expect(state.error).toContain("Ollama is not reachable");
    ({ state } = press(state, "up", "return"));
    expect(state.step).toBe("model");
    expect(selectedModel(state)).toBe("large");
    expect(screen(state)).toContain("recommended");
    const tied = { ...llama, models: [...llama.models, { id: "twin", provider: "llama.cpp", contextWindow: 100_096 }] };
    expect(screen({ ...state, provider: tied }).match(/recommended/g)).toHaveLength(1);
  });

  test("rejects remote cleartext URLs and continues with a typed model when a custom server does not answer", () => {
    let state = wizardProbed(initialWizard("/c"), [llama]);
    ({ state } = press(state, "down", "return"));
    expect(state.step).toBe("custom");
    let result = press(state, ..."http://10.0.0.5:8000/v1".split(""), "return");
    expect(result.effect).toBeUndefined();
    expect(result.state.custom.error).toContain("HTTPS");
    ({ state } = press(result.state, ...Array(23).fill("backspace")));
    result = press(state, ..."http://127.0.0.1:8000/v1".split(""), "return");
    expect(result.effect).toEqual({ kind: "probe", url: "http://127.0.0.1:8000/v1" });
    state = wizardCustomProbed(result.state, { target: { id: "custom", label: "Custom", url: "http://127.0.0.1:8000/v1" }, reachable: false, models: [] });
    expect(state.step).toBe("model");
    expect(screen(state)).toContain("did not answer");
    ({ state } = press(state, "return"));
    expect(state.error).toBe("Enter a model id.");
    ({ state } = press(state, ..."my-model".split(""), "return"));
    expect(state.step).toBe("review");
    expect(state.review.contextWindow).toBe(32_768);
  });

  test("review edits values, cycles the theme, validates output and writes", () => {
    let { state } = press(wizardProbed(initialWizard("/c"), [llama]), "return", "return");
    expect(state.step).toBe("review");
    expect(state.review).toMatchObject({ contextWindow: 100_096, maxOutputTokens: 1_536, detected: true });
    expect(screen(state)).toContain("detected");
    ({ state } = press(state, "e", ...Array(6).fill("backspace"), ..."2048".split(""), "return"));
    expect(state.review.contextWindow).toBe(2048);
    ({ state } = press(state, "down", "e", ...Array(4).fill("backspace"), ..."4096".split(""), "return"));
    let result = press(state, "return");
    expect(result.effect).toBeUndefined();
    expect(result.state.error).toContain("smaller than the context window");
    ({ state } = press(result.state, "e", ...Array(4).fill("backspace"), ..."512".split(""), "return", "down", "e"));
    expect(state.review.theme).toBe("dark");
    result = press(state, "return");
    expect(result.effect).toEqual({ kind: "write" });
    state = wizardSaved(result.state, "/c.bak");
    expect(screen(state)).toContain("demesne is ready");
    expect(screen(state)).toContain("/c.bak");
    expect(press(state, "return").effect).toEqual({ kind: "finish" });
  });

  test("escape and Ctrl+C cancel without writing, and every step fits a small terminal", () => {
    const state = wizardProbed(initialWizard("/c"), [llama]);
    expect(press(state, "escape").effect).toEqual({ kind: "cancel" });
    expect(reduceWizard(state, { name: "c", ctrl: true }).effect).toEqual({ kind: "cancel" });
    expect(press(state, "r").effect).toEqual({ kind: "rescan" });
    const rows = renderWizard(state, 60, 14, createPainter(false));
    expect(rows).toHaveLength(14);
    expect(rows.at(-1)).toContain("Enter continue");
  });
});
