/// Agents nearby: the other coding agents Heartbeat can see, each placed in
/// the project it works in. An agent's address names its project the way the
/// Heartbeat CLI does (`claude@node/demesne-cli-k3x9a`: the project folder's
/// name, then a five-letter session suffix), so the sidebar can put it on
/// that project's line without asking the agent.

export interface NearbyAgent {
  address: string;
  /// The client that runs it, as Heartbeat names it: claude, codex, gemini…
  provider: string;
  /// The client as a person names it: Claude Code, Codex, Gemini…
  name: string;
  node: string;
  /// On this machine, rather than a paired one.
  local: boolean;
  /// The project label, matching projectSlug of the project's folder.
  project: string;
}

const NAMES: Record<string, string> = {
  claude: "Claude Code", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", antigravity: "Antigravity", hermes: "Hermes",
};

/// A project folder as an address label: its name, lowercased, with anything
/// outside [a-z0-9_.-] turned into dashes (the Heartbeat CLI's convention).
export function projectSlug(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}

/// Heartbeat's agent list as agents nearby: Demesne's own chats are left out,
/// and a session that also holds its project's address shows once.
export function nearbyAgents(agents: readonly { agent_id?: unknown; node?: unknown }[], localNode: string | null): NearbyAgent[] {
  const parsed = agents.flatMap((agent) => {
    const match = /^([a-zA-Z0-9_.-]+)@([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(String(agent.agent_id ?? ""));
    if (!match || match[1] === "demesne") return [];
    const [, provider, node, label] = match as unknown as [string, string, string, string];
    const session = /-[a-z2-7]{5}$/.test(label);
    return [{ address: match[0], provider, name: NAMES[provider] ?? provider, node, local: node === localNode, project: session ? label.slice(0, -6) : label, session }];
  });
  return parsed
    .filter((agent) => agent.session || !parsed.some((other) => other.session && other.provider === agent.provider && other.node === agent.node && other.project === agent.project))
    .map(({ session: _session, ...agent }) => agent);
}

/// Where an agent runs, in words.
export function agentPlace(agent: NearbyAgent): string {
  return agent.local ? "on this computer" : `on ${agent.node}`;
}
