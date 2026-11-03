import type { GoogleAICatalog } from "./google-ai.ts";

/** A stable DOM island: secrets only live in the password input property and
 * the pending IPC call, never in render state, HTML attributes or storage. */
export class GoogleAIForm {
  readonly element = document.createElement("form");
  private generation = 0;
  private busy = false;
  private operationId: string | null = null;
  private readonly keyInput: HTMLInputElement;
  private readonly model: HTMLSelectElement;
  private readonly remember: HTMLInputElement;
  private readonly status: HTMLElement;
  constructor(readonly providerKey: string, private readonly request: <T>(method: string, args?: Record<string, unknown>) => Promise<T>) {
    this.element.className = "st-google";
    this.element.setAttribute("aria-label", "Google AI Studio connection");
    this.element.autocomplete = "off";
    this.element.innerHTML = `<label>API key<input type="password" name="google-key" aria-label="Google AI Studio API key" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="4096" required></label>
      <div class="st-google-actions"><button type="submit" class="st-link">Check key</button><button type="button" class="st-link" data-google-forget>Clear / cancel</button></div>
      <label>Chat model<select aria-label="Google chat model" disabled><option value="">Check a key to discover models</option></select></label>
      <p class="st-hint">Checking lists models only. Testing makes two small, potentially billable model requests with a harmless test tool. Your chats and files are not sent.</p>
      <button type="button" class="st-link" data-google-test disabled>Test &amp; forget</button>
      <label class="st-google-consent"><input type="checkbox">Save this key in my protected local configuration file (not encrypted)</label>
      <p class="st-hint">Nothing is saved by default. Save &amp; connect repeats the model test, then enables only the selected model. To add a different model, manage this connection again. Vision and Google-specific features are not enabled.</p>
      <button type="button" class="st-link" data-google-save disabled>Save &amp; connect</button>
      <p class="st-hint" role="status" aria-live="polite" tabindex="-1">Enter a key here, not in chat. Clear / cancel or leaving this page clears it from this form.</p>`;
    this.keyInput = this.element.querySelector('input[type="password"]')!;
    this.model = this.element.querySelector("select")!;
    this.remember = this.element.querySelector('input[type="checkbox"]')!;
    this.status = this.element.querySelector('[role="status"]')!;
    this.element.addEventListener("submit", event => { event.preventDefault(); event.stopPropagation(); void this.run("check"); });
    this.element.querySelector("[data-google-test]")!.addEventListener("click", () => void this.run("test"));
    this.element.querySelector("[data-google-save]")!.addEventListener("click", () => void this.run("save"));
    this.element.querySelector("[data-google-forget]")!.addEventListener("click", () => { this.clear(); this.keyInput.focus(); });
    this.keyInput.addEventListener("input", () => {
      this.generation++;
      this.model.replaceChildren(new Option("Check this key to discover models", ""));
      this.remember.checked = false;
      this.status.textContent = "Key changed. Check it before testing or connecting.";
      this.controls();
    });
    this.remember.addEventListener("change", () => this.controls());
    this.model.addEventListener("change", () => this.controls());
  }
  focus() { this.keyInput.focus(); }
  clear() {
    this.generation++;
    if (this.busy && this.operationId) void this.request("google-ai-cancel", { operationId: this.operationId }).catch(() => {});
    this.operationId = null;
    this.busy = false;
    this.keyInput.value = "";
    this.remember.checked = false;
    this.model.replaceChildren(new Option("Check a key to discover models", ""));
    this.status.textContent = "Key cleared from this form. No saved connection was removed.";
    this.controls();
  }
  private controls() {
    const ready = Boolean(this.keyInput.value.trim() && this.model.value) && !this.busy;
    this.keyInput.disabled = this.busy;
    this.remember.disabled = this.busy;
    this.model.disabled = this.busy || !this.model.value;
    this.element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = this.busy;
    this.element.querySelector<HTMLButtonElement>("[data-google-test]")!.disabled = !ready;
    this.element.querySelector<HTMLButtonElement>("[data-google-save]")!.disabled = !ready || !this.remember.checked;
    this.element.setAttribute("aria-busy", String(this.busy));
  }
  private async run(action: "check" | "test" | "save") {
    if (this.busy || !this.keyInput.value.trim() || (action !== "check" && !this.model.value) || (action === "save" && !this.remember.checked)) return;
    const generation = ++this.generation;
    const operationId = this.operationId = [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join("-");
    this.busy = true;
    this.status.textContent = action === "check" ? "Checking key and reading Google models…" : "Testing streaming and a tool round trip…";
    this.controls();
    let failed = false;
    try {
      const result = await this.request<GoogleAICatalog & { message: string }>(`google-ai-${action}`, {
        apiKey: this.keyInput.value.trim(), model: this.model.value, key: this.providerKey, operationId,
        ...(action === "save" ? { remember: this.remember.checked } : {}),
      });
      if (generation !== this.generation) return;
      if (action === "check") {
        this.model.replaceChildren(...result.models.map(model => new Option(model.id, model.id)));
        this.status.textContent = "Key accepted. Choose a model, then Test & forget or explicitly save it. Listing does not verify quota or tool support.";
      } else this.status.textContent = result.message;
    } catch (error) {
      if (generation !== this.generation) return;
      failed = true;
      // The privileged handler returns curated, secret-free errors. Redact the
      // input again in case an unexpected bridge failure includes request data.
      const key = this.keyInput.value.trim();
      this.status.textContent = error instanceof Error ? error.message.split(key).join("[redacted]").slice(0, 600) : "Google connection failed. Try again.";
    } finally {
      if (generation === this.generation) {
        if (action !== "check" || failed) { this.keyInput.value = ""; this.remember.checked = false; }
        this.busy = false;
        this.operationId = null;
        this.controls();
        if (action !== "check") this.status.focus({ preventScroll: true });
      }
    }
  }
}
