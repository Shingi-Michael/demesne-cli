import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const live = readFileSync(new URL("../live.ts", import.meta.url), "utf8");
const renderStart = live.indexOf("function renderPage() {"), renderEnd = live.indexOf("// Glass follows the slider", renderStart);
if (renderStart < 0 || renderEnd < renderStart) throw new Error("Missing production page renderer");
const renderScript = new Bun.Transpiler({ loader: "ts" }).transformSync(`
const GoogleAIForm = window.GoogleAIForm;
let pageOpen = 'settings', state = { workspace: '/fixture', processes: [], runs: [], approvals: [], questions: [] }, googleAIForm = null, revision = 0;
const el = id => document.getElementById(id), follow = false, stepOpen = new Set(), overlay = null, currentMode = () => 'ask';
${live.slice(live.indexOf("function clearGoogleAIForm()"), live.indexOf('window.addEventListener("pagehide", clearGoogleAIForm);'))}
function renderSettingsNav() {}
function settingsView() { return {}; }
function settingsPage() { return '<p>Revision '+revision+'</p><div data-google-provider="new:google"></div>'; }
${live.slice(live.indexOf("const recentRequests:"), live.indexOf("function notice("))}
${live.slice(renderStart, renderEnd)}
${live.slice(live.indexOf("window.demesneInspect ="), live.indexOf("const stateReceiver ="))}
window.fixture = { render() { revision++; renderPage(); }, leave() { pageOpen = ''; renderPage(); }, open() { pageOpen = 'settings'; revision++; renderPage(); } };
renderPage();
`);

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Google key form DOM", () => {
  let browser: Browser, page: Page, bundle: string;
  let errors: string[];
  beforeAll(async () => {
    const result = await Bun.build({ entrypoints: [new URL("../google-ai-form.ts", import.meta.url).pathname], target: "browser", format: "esm" });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    bundle = await result.outputs[0]!.text();
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined });
  }, 20_000);
  beforeEach(async () => {
    page = await browser.newPage(); errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<!doctype html><div id="page"></div><div id="notice" hidden></div><div id="stage"></div><div id="approval"></div>');
    await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      (window as any).GoogleAIForm = (await import(url)).GoogleAIForm; URL.revokeObjectURL(url);
      const w = window as any; w.calls = []; w.delay = false; w.failure = false;
      w.request = async (method: string, args: Record<string, unknown>) => {
        w.calls.push({ method, args });
        if (method === "google-ai-cancel") return;
        if (w.delay) await new Promise(resolve => { w.resolve = resolve; });
        if (w.failure) throw new Error(`Failed with ${args.apiKey}`);
        if (method === "google-ai-check") return { models: [{ id: "gemini-test", contextWindow: 32768, maxOutputTokens: 8192 }] };
        return { message: method === "google-ai-test" ? "Test passed; key not saved." : "Connected." };
      };
      w.demesne = { request: w.request };
    }, bundle);
    await page.addScriptTag({ content: renderScript });
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });
  // Password inputs intentionally have no implicit textbox role in ARIA.
  const password = () => page.getByLabel("Google AI Studio API key", { exact: true });
  const calls = () => page.evaluate(() => (window as any).calls);
  async function checked() {
    await password().fill("fake-key-only-in-memory");
    await page.getByRole("button", { name: "Check key", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Key accepted"));
  }

  test("a stable password field survives unrelated Settings redraws without caching its value in HTML", async () => {
    await password().fill("fake-key-only-in-memory");
    const retained = await page.evaluate(() => {
      const node = document.activeElement;
      (window as any).fixture.render();
      return node === document.activeElement && node?.isConnected;
    });
    expect(retained).toBe(true);
    expect(await password().inputValue()).toBe("fake-key-only-in-memory");
    expect(await page.locator("#page").innerHTML()).not.toContain("fake-key-only-in-memory");
    expect(await page.locator("#page").getAttribute("data-html")).not.toContain("fake-key-only-in-memory");
    expect(await password().getAttribute("type")).toBe("password");
    expect(await password().getAttribute("value")).toBeNull();
    const inspection = await page.evaluate(() => (window as any).demesneInspect());
    expect(inspection.controls.find((c: any) => c.name === "google-key").value).toBe("[redacted]");
    expect(JSON.stringify(inspection)).not.toContain("fake-key-only-in-memory");
    await page.getByRole("button", { name: "Clear / cancel" }).click();
    await page.evaluate(() => (window as any).fixture.render());
    expect(await password().inputValue()).toBe("");
  });

  test("Test & forget never saves, clears the key, and requires explicit storage consent to connect", async () => {
    await checked();
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
    expect(await page.getByRole("button", { name: "Save & connect" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Test & forget" }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Test passed"));
    expect(await password().inputValue()).toBe("");
    expect((await calls()).map((c: any) => c.method)).toEqual(["google-ai-check", "google-ai-test"]);
    expect(await page.getByRole("button", { name: "Save & connect" }).isDisabled()).toBe(true);
    await checked();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Save & connect" }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Connected.");
    expect((await calls()).at(-1)).toMatchObject({ method: "google-ai-save", args: { remember: true, model: "gemini-test", key: "new:google" } });
    expect(await password().inputValue()).toBe("");
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
  });

  test("editing a checked key invalidates the selected models and consent", async () => {
    await checked();
    await page.getByRole("checkbox").check();
    await password().fill("different-fixture-key");
    expect(await page.getByRole("combobox").inputValue()).toBe("");
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
    expect(await page.getByRole("button", { name: "Save & connect" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Test & forget" }).isDisabled()).toBe(true);
  });

  test("Clear and leaving Settings cancel in-flight checks and ignore late results", async () => {
    await page.evaluate(() => { (window as any).delay = true; });
    await password().fill("fake-key-only-in-memory");
    await page.getByRole("button", { name: "Check key", exact: true }).click();
    await page.getByRole("button", { name: "Clear / cancel" }).click();
    await page.evaluate(() => (window as any).resolve());
    expect(await password().inputValue()).toBe("");
    expect(await page.getByRole("combobox").inputValue()).toBe("");
    expect(await page.getByRole("status").textContent()).toContain("Key cleared");
    await password().fill("another-fake-key");
    await page.getByRole("button", { name: "Check key", exact: true }).click();
    await page.evaluate(() => { (window as any).fixture.leave(); (window as any).resolve(); (window as any).fixture.open(); });
    expect(await password().inputValue()).toBe("");
    expect((await calls()).filter((c: any) => c.method === "google-ai-cancel")).toHaveLength(2);
  });

  test("an unexpected bridge error is redacted and clears the input", async () => {
    await page.evaluate(() => { (window as any).failure = true; });
    await password().fill("fake-key-only-in-memory");
    await page.getByRole("button", { name: "Check key", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("redacted"));
    expect(await page.locator("#page").textContent()).not.toContain("fake-key-only-in-memory");
    const inspection = await page.evaluate(() => (window as any).demesneInspect());
    expect(JSON.stringify(inspection)).not.toContain("fake-key-only-in-memory");
    expect(inspection.host.requests[0]).toContain("details omitted");
    expect(await password().inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Save & connect" }).isDisabled()).toBe(true);
  });
});
