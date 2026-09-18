import { describe, expect, test } from "bun:test";
import { McpManager, mcpToolName } from "../src/mcp.ts";
import { ToolRegistry } from "../src/tools.ts";

/// Minimal MCP server over stdio: newline-delimited JSON-RPC with one `echo`
/// tool. It proves the handshake, discovery, call, and lifecycle paths without
/// any external dependency.
const STUB_SERVER = `
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo: " + message.params.arguments.text }] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
    }
  }
});
`;

const stubConfig = { command: process.execPath, args: ["-e", STUB_SERVER] };
const context = { workspaceRoot: "/tmp", signal: new AbortController().signal };

describe("McpManager", () => {
  test("discovers and calls tools from a stdio server", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({ servers: { stub: stubConfig } });
    await manager.start(registry);

    const tool = registry.get(mcpToolName("stub", "echo"));
    expect(tool).toBeDefined();
    expect(tool!.definition.description).toContain("[stub]");
    expect(tool!.definition.description).toContain("Echo text");
    expect(tool!.permission({})).toMatchObject({ kind: "execute" });
    expect(await tool!.execute({ text: "hello" }, context)).toBe("echo: hello");
    manager.stop();
  });

  test("skips servers that cannot start without failing the daemon", async () => {
    const registry = new ToolRegistry();
    const messages: string[] = [];
    const manager = new McpManager({
      servers: { broken: { command: "definitely-not-a-real-mcp-binary-xyz" } },
      log: (message) => messages.push(message),
    });
    await manager.start(registry);
    expect(registry.definitions().some((definition) => definition.name.startsWith("mcp__"))).toBe(false);
    expect(messages.some((message) => message.includes("broken"))).toBe(true);
    manager.stop();
  });

  test("restarts a stopped server on the next call", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({ servers: { stub: stubConfig } });
    await manager.start(registry);
    const tool = registry.get(mcpToolName("stub", "echo"))!;
    expect(await tool.execute({ text: "first" }, context)).toBe("echo: first");

    manager.stop();
    expect(await tool.execute({ text: "second" }, context)).toBe("echo: second");
    manager.stop();
  });

  test("namespaces tool names per server", () => {
    expect(mcpToolName("files", "read_file")).toBe("mcp__files__read_file");
  });
});
