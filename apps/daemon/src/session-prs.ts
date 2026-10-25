import { type SessionPullRequest, pullRequestFromGh } from "@demesne/protocol";
import { homedir } from "node:os";
import { run } from "./drive-signals.ts";

/// Its pull request on the row (pass 76 D): the daemon asks gh about the
/// pull requests chats opened, now and then. An open one is looked at again
/// after a minute and a half, a merged or closed one after ten minutes;
/// `fresh` asks again now (the row was just unfolded).

/// gh where the shell would find it, and where Homebrew puts it for a Mac
/// app started from the Dock (whose PATH leaves those out).
const gh = () => Bun.which("gh", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? "gh";
const FIELDS = "number,title,url,state,isDraft,createdAt,mergedAt,closedAt,reviews,comments,statusCheckRollup";
const OPEN_AGE = 90_000, SETTLED_AGE = 600_000;

export class SessionPullRequests {
  private readonly known = new Map<string, { pr: SessionPullRequest | null; at: number }>();
  private readonly asking = new Map<string, Promise<SessionPullRequest | null>>();

  constructor(private readonly exec: (argv: string[], cwd: string) => Promise<string | null> = run, private readonly now = () => Date.now()) {}

  async get(url: string, cwd: string | null, fresh = false): Promise<SessionPullRequest | null> {
    const known = this.known.get(url);
    const age = known?.pr && known.pr.state !== "open" ? SETTLED_AGE : OPEN_AGE;
    if (known && !fresh && this.now() - known.at < age) return known.pr;
    const pending = this.asking.get(url);
    if (pending) return pending;
    const ask = (async () => {
      const out = await this.exec([gh(), "pr", "view", url, "--json", FIELDS], cwd ?? homedir());
      let pr: SessionPullRequest | null = null;
      try { pr = out ? pullRequestFromGh(JSON.parse(out)) : null; } catch { /* gh printed something else */ }
      // A failed look keeps what we knew.
      this.known.set(url, { pr: pr ?? known?.pr ?? null, at: this.now() });
      return pr ?? known?.pr ?? null;
    })().finally(() => this.asking.delete(url));
    this.asking.set(url, ask);
    return ask;
  }
}
