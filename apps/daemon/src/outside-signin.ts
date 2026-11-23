/// Google won't sign anyone in inside an app's browser ("This browser or app may
/// not be secure"). When a chat's page goes to Google's sign-in, the desktop opens
/// the page in your own browser instead, where "Sign in with Google" works. This
/// watches your browsers for that site's sign-in, brings it into the project's
/// browser once it is there (the same way Settings › Browser does, pass 261 A),
/// and reloads the chat's page signed in.
import { neverBrought, type SigninSite, type SigninSource } from "./browser-signins.ts";

export interface OutsideState { site: string; state: "waiting" | "done" | "failed" | "never"; from?: string; said?: string; at: number }

export interface OutsideDeps {
  sources: () => SigninSource[];
  sites: (from: string) => SigninSite[];
  /// Brings the site's cookies from that browser into the project's profile; how many came in.
  bring: (from: string, site: string, profile: string) => Promise<number>;
  reload: (chat: string) => Promise<void>;
  now?: () => number;
  /// How often your browsers are looked at, and for how long.
  every?: number;
  within?: number;
}

/// How long "Signed in" stays in the bar once it is done.
const SHOWN_MS = 12_000;

export class OutsideSignins {
  private readonly states = new Map<string, OutsideState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly deps: OutsideDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  /// What the chat's bar should say, if anything.
  get(chat: string): OutsideState | undefined {
    const state = this.states.get(chat);
    if (state && state.state !== "waiting" && this.now() - state.at > SHOWN_MS) { this.states.delete(chat); return undefined; }
    return state;
  }
  stop(chat: string) { clearTimeout(this.timers.get(chat)); this.timers.delete(chat); }
  close() { for (const chat of [...this.timers.keys()]) this.stop(chat); }
  /// The chat's page went to Google's sign-in from `site`: watch for that site's sign-in in your browsers.
  start(chat: string, site: string | undefined, profile: string | undefined) {
    this.stop(chat);
    if (!site) { this.states.delete(chat); return; }
    const at = this.now();
    if (neverBrought(site)) { this.states.set(chat, { site, state: "never", at }); return; }
    if (!profile) { this.states.set(chat, { site, state: "failed", said: "Sign-ins come in only for a project’s chats", at }); return; }
    const ready = () => { try { return this.deps.sources().filter((one) => one.state === "ready"); } catch { return []; } };
    const used = (from: string) => { try { return this.deps.sites(from).find((one) => one.site === site)?.lastUsed ?? 0; } catch { return 0; } };
    // Where each browser stands now: a newer use of the site there is you signing in.
    const before = new Map(ready().map((one) => [one.id, used(one.id)]));
    this.states.set(chat, { site, state: "waiting", at });
    const within = this.deps.within ?? 10 * 60_000, every = this.deps.every ?? 4000;
    const look = async () => {
      this.timers.delete(chat);
      if (this.states.get(chat)?.state !== "waiting" || this.states.get(chat)?.site !== site) return;
      const found = ready().find((one) => used(one.id) > (before.get(one.id) ?? 0));
      if (found) {
        try {
          const brought = await this.deps.bring(found.id, site, profile);
          if (!brought) throw new Error(`No sign-in for ${site} in ${found.label} yet`);
          this.states.set(chat, { site, state: "done", from: found.label, at: this.now() });
          await this.deps.reload(chat).catch(() => {});
        } catch (error) { this.states.set(chat, { site, state: "failed", from: found.label, said: error instanceof Error ? error.message : String(error), at: this.now() }); }
        return;
      }
      if (this.now() - at > within) { this.states.delete(chat); return; }
      this.timers.set(chat, setTimeout(() => void look(), every));
    };
    this.timers.set(chat, setTimeout(() => void look(), every));
  }
}
