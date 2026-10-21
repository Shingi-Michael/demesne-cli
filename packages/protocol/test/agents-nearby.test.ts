import { describe, expect, test } from "bun:test";
import { nearbyAgents, projectSlug } from "../src/agents-nearby.ts";

describe("agents nearby", () => {
  test("project labels follow the Heartbeat CLI", () => {
    expect(projectSlug("/Users/mike/projects/demesne-cli")).toBe("demesne-cli");
    expect(projectSlug("/home/me/My Site/")).toBe("my-site");
    expect(projectSlug("/")).toBe("session");
  });

  test("places other agents in their projects and leaves Demesne's chats out", () => {
    const agents = nearbyAgents([
      { agent_id: "claude@mac/demesne-cli-k3x7a", node: "mac" },
      { agent_id: "claude@mac/demesne-cli", node: "mac" },
      { agent_id: "codex@air/heartbeat-q2m7c", node: "air" },
      { agent_id: "codex@air/heartbeat", node: "air" },
      { agent_id: "gemini@air/heartbeat", node: "air" },
      { agent_id: "demesne@mac/demesne-cli-abcde", node: "mac" },
      { agent_id: "not an address" },
    ], "mac");
    expect(agents).toEqual([
      { address: "claude@mac/demesne-cli-k3x7a", provider: "claude", name: "Claude Code", node: "mac", local: true, project: "demesne-cli" },
      { address: "codex@air/heartbeat-q2m7c", provider: "codex", name: "Codex", node: "air", local: false, project: "heartbeat" },
      { address: "gemini@air/heartbeat", provider: "gemini", name: "Gemini", node: "air", local: false, project: "heartbeat" },
    ]);
  });
});
