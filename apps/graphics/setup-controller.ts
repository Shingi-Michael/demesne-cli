import { assertProviderUrl } from "@demesne/config";
import {
  initialWizard,
  reduceWizard,
  wizardAuthenticated,
  wizardCustomProbed,
  wizardProbed,
  wizardSaved,
  selectedModel,
  type WizardState,
  type WizardEffect,
} from "../cli/src/setup-wizard.ts";
import {
  probeTargets,
  probeProvider,
  targetForUrl,
  type ProbeResult,
} from "../cli/src/provider-probe.ts";
import {
  beginOpenRouterLogin,
  discoverOpenRouter,
  OPENROUTER_URL,
} from "../cli/src/openrouter-auth.ts";
import { writeSetupConfig } from "../cli/src/setup.ts";

export type SetupSnapshot = WizardState & {
  customResult: ProbeResult | null;
  checkedAt: number | null;
  saving: boolean;
};
export class GraphicsSetup {
  private state: WizardState;
  private apiKey: string | undefined;
  private login: ReturnType<typeof beginOpenRouterLogin> | undefined;
  private loginAbort: AbortController | undefined;
  private epoch = 0;
  private probeEpoch = 0;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private customResult: ProbeResult | null = null;
  private checkedAt: number | null = null;
  private saving = false;
  constructor(
    private options: {
      configPath: string;
      changed: () => void;
      copy: (text: string) => Promise<void>;
      open: (url: string) => Promise<void>;
      finish: (open: boolean) => Promise<void>;
      fetch?: typeof fetch;
      env?: Record<string, string | undefined>;
    },
  ) {
    this.state = initialWizard(options.configPath);
  }
  snapshot(): SetupSnapshot {
    return {
      ...this.state,
      customResult: this.customResult,
      checkedAt: this.checkedAt,
      saving: this.saving,
    };
  }
  async start() {
    await this.effect({ kind: "rescan" });
  }
  private publish() {
    if (!this.closed) this.options.changed();
  }
  async action(args: Record<string, unknown>) {
    if (this.closed || this.saving) return;
    const field = args.field;
    if (typeof args.value === "string") {
      if (args.value.length > 8000) throw new Error("Setup value is too long");
      if (field === "url" && this.state.step === "custom") {
        this.state.custom = { text: args.value, error: null, checking: false };
        this.customResult = null;
        this.checkedAt = null;
        this.probeEpoch++;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.checkCustom(false), 400);
        this.publish();
        return;
      }
      if (field === "model" && this.state.step === "model")
        this.state.modelText = args.value;
      if (field === "review" && this.state.editing)
        this.state.editing.text = args.value;
    }
    if (Number.isSafeInteger(args.index) && Number(args.index) >= 0) {
      if (this.state.step === "provider")
        this.state.providerIndex = Number(args.index);
      if (this.state.step === "model")
        this.state.modelIndex = Number(args.index);
      if (this.state.step === "review")
        this.state.reviewIndex = Math.min(4, Number(args.index));
    }
    const key = typeof args.key === "string" ? args.key : "";
    if (this.state.step === "custom" && key === "escape") {
      this.probeEpoch++;
      clearTimeout(this.debounce);
      this.state.custom.checking = false;
    }
    if (this.state.step === "custom" && key === "return") {
      if (this.customResult) {
        this.state = wizardCustomProbed(this.state, this.customResult);
        this.publish();
        return;
      }
      await this.checkCustom(true);
      return;
    }
    const result = reduceWizard(
      this.state,
      { name: key },
      typeof args.text === "string" ? args.text : "",
    );
    this.state = result.state;
    this.publish();
    if (result.effect) await this.effect(result.effect);
  }
  private async checkCustom(advance: boolean) {
    if (this.closed || this.state.step !== "custom") return;
    clearTimeout(this.debounce);
    const url = this.state.custom.text.trim(),
      epoch = ++this.probeEpoch;
    try {
      assertProviderUrl(url, "provider URL");
    } catch (error) {
      this.state.custom.error =
        error instanceof Error ? error.message : String(error);
      this.publish();
      return;
    }
    this.state.custom.checking = true;
    this.publish();
    const result = await probeProvider(targetForUrl(url), {
      fetch: this.options.fetch,
    });
    if (
      this.closed ||
      epoch !== this.probeEpoch ||
      this.state.step !== "custom"
    )
      return;
    this.customResult = result;
    this.checkedAt = Date.now();
    this.state.custom.checking = false;
    if (advance) this.state = wizardCustomProbed(this.state, result);
    this.publish();
  }
  private async effect(effect: WizardEffect) {
    if (effect.kind === "rescan") {
      const epoch = ++this.probeEpoch;
      const results = await probeTargets(undefined, {
        fetch: this.options.fetch,
      });
      if (!this.closed && epoch === this.probeEpoch) {
        this.state = wizardProbed(this.state, results);
        this.publish();
      }
    }
    if (effect.kind === "cancel-login") {
      this.stopLogin();
    }
    if (effect.kind === "login") void this.authenticate();
    if (effect.kind === "copy") await this.options.copy(effect.url);
    if (effect.kind === "open") await this.options.open(effect.url);
    if (effect.kind === "probe") await this.checkCustom(true);
    if (effect.kind === "cancel" || effect.kind === "finish")
      await this.options.finish(effect.kind === "finish" && effect.open);
    if (effect.kind === "write") {
      this.saving = true;
      this.publish();
      try {
        const { backup } = writeSetupConfig(
          this.state.configPath,
          {
            providerUrl: this.state.provider!.target.url,
            providerId: this.state.provider!.target.id,
            model: selectedModel(this.state),
            ...this.state.review,
          },
          this.state.provider?.target.url === OPENROUTER_URL
            ? this.apiKey
            : undefined,
        );
        this.apiKey = undefined;
        this.state = wizardSaved(this.state, backup);
      } catch (error) {
        this.state.error =
          error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
        this.publish();
      }
    }
  }
  private stopLogin() {
    this.epoch++;
    this.loginAbort?.abort();
    void this.login?.close();
    this.login = undefined;
    this.apiKey = undefined;
  }
  private async authenticate() {
    this.stopLogin();
    const epoch = this.epoch,
      controller = (this.loginAbort = new AbortController());
    try {
      let key = (this.options.env ?? process.env).OPENROUTER_API_KEY?.trim();
      if (!key) {
        const login = (this.login = beginOpenRouterLogin({
          fetch: this.options.fetch,
          signal: controller.signal,
        }));
        this.state.auth = {
          url: login.url,
          status: "waiting",
          message: "Finish signing in, then return here.",
          expiresAt: Date.now() + 600000,
        };
        this.publish();
        try {
          await this.options.open(login.url);
        } catch {
          this.state.auth.message = "Open the sign-in link below to continue.";
          this.publish();
        }
        key = await login.key;
      }
      if (epoch !== this.epoch || this.closed) return;
      this.state.auth.status = "loading";
      this.state.auth.message = "Connected · loading models…";
      this.publish();
      const models = await discoverOpenRouter({
        apiKey: key,
        fetch: this.options.fetch,
        signal: controller.signal,
      });
      if (epoch !== this.epoch || this.closed) return;
      this.apiKey = key;
      this.state = wizardAuthenticated(this.state, {
        target: { id: "OpenRouter", label: "OpenRouter", url: OPENROUTER_URL },
        reachable: true,
        models,
      });
      this.publish();
    } catch (error) {
      if (epoch === this.epoch && !this.closed) {
        this.state.auth = {
          url: "",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
        this.publish();
      }
    } finally {
      if (epoch === this.epoch) {
        await this.login?.close();
        this.login = undefined;
      }
    }
  }
  dispose() {
    this.closed = true;
    this.probeEpoch++;
    clearTimeout(this.debounce);
    this.stopLogin();
  }
}
