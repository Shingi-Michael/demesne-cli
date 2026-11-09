/// Which agents you let work, and where (pass 206 A). One switch turns every
/// agent off; each agent then works everywhere, in some projects, or nowhere.
/// An agent that's off here isn't offered for side work or hand-offs (those
/// fall back to the chat's own model), drops out of the sidebar's Agents
/// list, and doesn't post on Today. Its old chats stay as they were.
/// Kept in <data>/agent-choice.json; nothing saved means every agent on.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentId } from "./agent-cli.ts";

export type AgentMode = "every" | "some" | "off";
export interface AgentChoiceRecord {
  off: boolean;
  agents: Partial<Record<AgentId, { mode: AgentMode; projects: string[] }>>;
}

const MODES: readonly AgentMode[] = ["every", "some", "off"];
const same = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

export class AgentChoice {
  constructor(private readonly path: string) {}

  read(): AgentChoiceRecord {
    try {
      if (existsSync(this.path)) {
        const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<AgentChoiceRecord>;
        const agents: AgentChoiceRecord["agents"] = {};
        for (const [id, item] of Object.entries(value.agents ?? {})) {
          if (!item || !MODES.includes(item.mode)) continue;
          agents[id as AgentId] = { mode: item.mode, projects: Array.isArray(item.projects) ? item.projects.filter((root): root is string => typeof root === "string") : [] };
        }
        return { off: value.off === true, agents };
      }
    } catch { /* start over: every agent on */ }
    return { off: false, agents: {} };
  }

  /// Whether an agent may work: anywhere (no root), or in this project.
  allows(id: AgentId, root?: string | null, record = this.read()): boolean {
    if (record.off) return false;
    const choice = record.agents[id];
    if (!choice || choice.mode === "every") return true;
    if (choice.mode === "off") return false;
    return root ? choice.projects.some((project) => same(project, root)) : choice.projects.length > 0;
  }

  /// The agents from `ids` that may work here.
  filter<T extends AgentId>(ids: readonly T[], root?: string | null): T[] {
    const record = this.read();
    return ids.filter((id) => this.allows(id, root, record));
  }

  /// The one switch for every agent.
  setOff(off: boolean): AgentChoiceRecord {
    return this.write({ ...this.read(), off });
  }

  /// One agent's place: everywhere, some projects, or off. Leaving out
  /// `projects` keeps the ones it had, so going back to Some projects
  /// remembers them.
  set(id: AgentId, mode: AgentMode, projects?: string[]): AgentChoiceRecord {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
    const record = this.read();
    const kept = projects ?? record.agents[id]?.projects ?? [];
    record.agents[id] = { mode, projects: [...new Set(kept.map((root) => root.replace(/[\\/]+$/, "")))] };
    return this.write(record);
  }

  private write(record: AgentChoiceRecord): AgentChoiceRecord {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2));
    renameSync(temporary, this.path);
    return record;
  }
}
