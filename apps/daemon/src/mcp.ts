import type { ProviderToolDefinition } from "@demesne/providers";
import type { McpServerConfig } from "@demesne/config";
import type { AgentTool, ToolRegistry } from "./tools.ts";
import type { StructuredToolResult, ImageOutput } from "./artifacts.ts";

/// Model Context Protocol client for stdio servers.
///
/// Each configured server is spawned, initialized, and asked for its tools;
/// tools are registered as `mcp__<server>__<tool>` with per-call approval. A
/// server that fails to start or exits is restarted lazily on its next call,
/// and shutdown terminates every child process.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MCP_RESULT_LIMIT_BYTES = 256 * 1024;
const MCP_IMAGE_FRAME_LIMIT = 32 * 1024 * 1024;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/// Narrow view of the spawned child; Bun's spawn option types widen stdio to
/// `number | FileSink` even when pipes were requested.
interface McpProcess {
  stdin: { write(data: string): void; flush(): void };
  stdout: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export class McpStdioClient {
  private child: McpProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private tools: ProviderToolDefinition[] = [];
  private exited = false;
  private readonly timeoutMs: number;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.timeoutMs = config.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<boolean> {
    if (this.child && !this.exited) return true;
    try {
      this.child = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      }) as unknown as McpProcess;
    } catch (error) {
      this.log(`MCP server ${this.name} could not start: ${messageOf(error)}`);
      return false;
    }
    this.exited = false;
    const child = this.child;
    void this.readLoop();
    void child.exited.then(() => {
      // Ignore the exit of a superseded process; otherwise a restarted server
      // would be marked dead by its predecessor.
      if (this.child === child) this.handleExit();
    });
    try {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "demesne", version: "0.1.0" },
      });
      this.notify("notifications/initialized", {});
      const listed = await this.request("tools/list", {});
      this.tools = parseToolList(listed);
      return true;
    } catch (error) {
      this.log(`MCP server ${this.name} failed to initialize: ${messageOf(error)}`);
      this.stop();
      return false;
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.exited || !this.child) {
      this.tools = [];
      const started = await this.start();
      if (!started) throw new Error(`MCP server ${this.name} is unavailable`);
    }
  }

  listTools(): ProviderToolDefinition[] {
    return this.tools;
  }

  async callTool(tool: string, args: unknown): Promise<string> {
    const result = await this.request("tools/call", { name: tool, arguments: args ?? {} });
    return flattenToolResult(this.name, result);
  }

  async callToolWithImages(tool: string, args: unknown): Promise<string | StructuredToolResult> {
    const result = await this.request("tools/call", { name: tool, arguments: args ?? {} });
    const text = flattenToolResult(this.name, result);
    const images: ImageOutput[] = [];
    if (isRecord(result) && Array.isArray(result.content)) for (const block of result.content) {
      if (!isRecord(block) || block.type !== "image") continue;
      if (typeof block.data !== "string" || typeof block.mimeType !== "string" || block.data.length > 28 * 1024 * 1024
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw new Error("Invalid MCP image payload");
      images.push({ data: Buffer.from(block.data, "base64"), mimeType: block.mimeType });
    }
    return images.length ? { text, images } : text;
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${this.name} stopped`));
    }
    this.pending.clear();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // The process may already be gone.
      }
      this.child = null;
    }
    this.exited = true;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || this.exited) throw new Error(`MCP server ${this.name} is not running`);
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(line);
        child.stdin.flush();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      this.child?.stdin.flush();
    } catch {
      // A dead server is handled by the next request.
    }
  }

  private async readLoop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        this.buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          if (Buffer.byteLength(line) > MCP_IMAGE_FRAME_LIMIT) { this.stop(); return; }
          this.buffer = this.buffer.slice(index + 1);
          if (line) this.handleLine(line);
        }
        if (Buffer.byteLength(this.buffer) > MCP_IMAGE_FRAME_LIMIT) {
          this.log(`MCP server ${this.name} exceeded the output limit`);
          this.stop();
          return;
        }
      }
    } catch {
      // The stream ends when the process exits; handleExit resolves pending calls.
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(typeof error?.message === "string" ? error.message : "MCP request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id !== null && typeof message.method === "string") {
      // Server-initiated requests (sampling, roots) are not supported.
      try {
        this.child?.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not supported by Demesne" },
        })}\n`);
        this.child?.stdin.flush();
      } catch {
        // Ignore; the connection is already unhealthy.
      }
    }
  }

  private handleExit(): void {
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${this.name} exited`));
    }
    this.pending.clear();
  }
}

export interface McpManagerOptions {
  servers: Record<string, McpServerConfig>;
  log?: (message: string) => void;
}

export class McpManager {
  private readonly clients = new Map<string, McpStdioClient>();
  private readonly log: (message: string) => void;

  constructor(options: McpManagerOptions) {
    this.log = options.log ?? (() => {});
    for (const [name, config] of Object.entries(options.servers)) {
      this.clients.set(name, new McpStdioClient(name, config, this.log));
    }
  }

  get serverCount(): number {
    return this.clients.size;
  }

  /// Starts every server and registers its tools. Servers that fail are
  /// skipped; the daemon keeps running with the remaining tools.
  async start(registry: ToolRegistry): Promise<void> {
    await Promise.all([...this.clients.values()].map(async (client) => {
      const started = await client.start();
      if (!started) {
        this.log(`MCP server ${client.name} is unavailable`);
        return;
      }
      for (const definition of client.listTools()) {
        registry.register(buildAgentTool(client, definition));
      }
    }));
  }

  stop(): void {
    for (const client of this.clients.values()) client.stop();
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function buildAgentTool(client: McpStdioClient, definition: ProviderToolDefinition): AgentTool {
  const name = mcpToolName(client.name, definition.name);
  return {
    definition: {
      name,
      description: `[${client.name}] ${definition.description ?? definition.name}`,
      inputSchema: definition.inputSchema,
    },
    permission: () => ({ kind: "execute", summary: `${name} ${summarizeInput(definition.inputSchema)}` }),
    execute: async (input) => {
      await client.ensureStarted();
      return client.callTool(definition.name, input);
    },
    executeWithArtifacts: async (input) => {
      await client.ensureStarted();
      return client.callToolWithImages(definition.name, input);
    },
  };
}

function summarizeInput(inputSchema: Record<string, unknown>): string {
  const properties = inputSchema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const keys = Object.keys(properties);
    if (keys.length > 0) return `(${keys.join(", ")})`;
  }
  return "";
}

function parseToolList(result: unknown): ProviderToolDefinition[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) return [];
  const tools: ProviderToolDefinition[] = [];
  for (const value of result.tools) {
    if (!isRecord(value) || typeof value.name !== "string" || !value.name) continue;
    tools.push({
      name: value.name,
      description: typeof value.description === "string" ? value.description : value.name,
      inputSchema: isRecord(value.inputSchema) ? value.inputSchema : { type: "object", properties: {} },
    });
  }
  return tools;
}

function flattenToolResult(server: string, result: unknown): string {
  if (!isRecord(result)) throw new Error(`MCP server ${server} returned an invalid result`);
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  const text = parts.join("\n");
  if (result.isError === true) throw new Error(text || `MCP tool on ${server} failed`);
  const bounded = text.length > MCP_RESULT_LIMIT_BYTES ? `${text.slice(0, MCP_RESULT_LIMIT_BYTES)}\n[truncated]` : text;
  return bounded || "(no output)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
