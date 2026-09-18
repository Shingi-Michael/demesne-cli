import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextPlan } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";
import { planContextRequest } from "./context-planner.ts";
import { defaultSystemPrompt } from "./engine.ts";
import { ToolRegistry } from "./tools.ts";

export const REPOSITORY_CONTEXT_FIXTURE_VERSION = 2 as const;
export const REPOSITORY_CONTEXT_CAPACITY = 8_192;
export const REPOSITORY_CONTEXT_OUTPUT_RESERVE = 1_536;
export const REPOSITORY_CONTEXT_HARD_INPUT_LIMIT = REPOSITORY_CONTEXT_CAPACITY - REPOSITORY_CONTEXT_OUTPUT_RESERVE;
export const REPOSITORY_TOOL_DEFINITIONS_SHA256 = "27ba5e66b9f1bd12c29bdf712792ca46b4ee5c48066fc7e7e2f1a5b4b5918f25";

const EXPECTED_FIXTURES = {
  "repository-inspection-v1": {
    fixtureSha256: "5841daa99075d16923a42497c241fa232bf92467518257a7fa6ecce66e48f14f",
    manifestSha256: "4d903234a32b03c91c7a2757d259309558796d14219c3762ebafe5f48ea8e606",
    originalEstimate: 5_731,
    reducedEstimate: 4_777,
    actions: [
      "deduplicate_historical_file_content:packages/protocol/src/index.ts",
      "deduplicate_historical_file_content:apps/daemon/src/engine.ts",
      "deduplicate_historical_file_content:package.json",
      "truncate_historical_tool_output:20",
    ],
  },
  "repository-single-file-repair-v1": {
    fixtureSha256: "6014a0b06beea923fff810d0d9ed9365da4bb12cfd208e3175a820833b92181f",
    manifestSha256: "08f32912d837036dc11e5661b61bad7ab4b2482faaf7a36bded4b1edc6a16be7",
    originalEstimate: 6_033,
    reducedEstimate: 3_957,
    actions: ["drop_historical_turn:diagnose"],
  },
  "repository-multi-file-feature-v1": {
    fixtureSha256: "69023592657815441024fab98d84fa3930b17036b6560900bbf82349ce02b7b2",
    manifestSha256: "3055ba5b2cb00ded3579140ba1d37f6bb9eeb71355cb0cf9fc61956b5be69d1f",
    originalEstimate: 6_625,
    reducedEstimate: 5_336,
    actions: [
      "deduplicate_historical_file_content:test/runtime-info.test.ts",
      "drop_historical_turn:feature-inspect",
    ],
  },
} as const;

export type RepositoryFixtureKind = "inspection" | "single_file_repair" | "multi_file_feature";

export interface RepositoryContextFixture {
  id: string;
  version: typeof REPOSITORY_CONTEXT_FIXTURE_VERSION;
  kind: RepositoryFixtureKind;
  workspacePath: string;
  repositoryManifest: Array<{ path: string; bytes: number; sha256: string }>;
  repositoryManifestSha256: string;
  rawMessages: ProviderMessage[];
  reducedMessages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  plan: ContextPlan;
  historicalTurns: HistoricalTurnRange[];
  gold: Record<string, unknown>;
  fixtureSha256: string;
}

type RepositoryFixtureFingerprintInput = Omit<RepositoryContextFixture, "fixtureSha256">;

interface FixtureDraft {
  id: string;
  kind: RepositoryFixtureKind;
  workspacePath: string;
  files: Record<string, string>;
  messages: ProviderMessage[];
  historicalTurns: HistoricalTurnRange[];
  gold: Record<string, unknown>;
}

interface HistoricalTurnRange {
  id: string;
  startMessageIndex: number;
  endMessageIndex: number;
}

export async function createRepositoryContextFixtures(
  signal: AbortSignal = new AbortController().signal,
): Promise<RepositoryContextFixture[]> {
  const root = mkdtempSync(join(tmpdir(), "demesne-repository-context-"));
  try {
    const registry = new ToolRegistry();
    const tools = registry.definitions();
    if (Bun.CryptoHasher.hash("sha256", stableJson(tools), "hex") !== REPOSITORY_TOOL_DEFINITIONS_SHA256) {
      throw new Error("Repository fixture tool definitions changed without a fixture version change");
    }
    const drafts = [
      await inspectionDraft(root, registry, signal),
      await repairDraft(root, registry, signal),
      await featureDraft(root, registry, signal),
    ];
    return drafts.map((draft) => finalizeFixture(draft, tools));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function inspectionDraft(root: string, registry: ToolRegistry, signal: AbortSignal): Promise<FixtureDraft> {
  const workspacePath = "/benchmark/parcel-agent";
  const files = {
    "package.json": `${JSON.stringify({
      name: "parcel-agent",
      private: true,
      type: "module",
      workspaces: ["apps/*", "packages/*"],
      scripts: {
        daemon: "bun apps/daemon/src/main.ts",
        cli: "bun apps/cli/src/main.ts",
        test: "bun test",
      },
    }, null, 2)}\n`,
    "apps/cli/src/main.ts": 'import "./client";\n',
    "apps/daemon/src/main.ts": 'import "./server";\n',
    "apps/daemon/src/engine.ts": generatedFile(36, "engine", {
      1: 'import type { ContextPlan } from "@parcel/protocol";',
      2: 'import { ToolRegistry } from "./tools";',
      3: "export class AgentEngine {",
      4: "  constructor(private tools: ToolRegistry) {}",
      5: "  async run(): Promise<ContextPlan> {",
      6: "    const definitions = this.tools.definitions();",
      7: "    return planContextRequest({",
      8: "      messages: [], tools: definitions, historicalTurns: [],",
      9: "      capacityTokens: 8192, outputReserveTokens: 1536,",
      10: "    }).plan;",
      11: "  }",
      12: "}",
      33: "export const CONTEXT_SCHEMA_VERSION = 3;",
      34: "export const TOOL_COUNT = 13;",
      35: "export const OUTPUT_RESERVE = 1536;",
      36: "export const CONTEXT_CAPACITY = 8192;",
    }),
    "packages/protocol/src/index.ts": generatedFile(34, "protocol", {
      1: "export interface RuntimeInfo {",
      2: "  provider: string;",
      3: "  model: string;",
      4: "}",
      5: "export interface ContextPlan {",
      6: "  schemaVersion: 3;",
      7: "  capacityTokens: number;",
      8: "  outputReserveTokens: number;",
      31: 'export const DAEMON_ENTRY = "apps/daemon/src/main.ts";',
      32: 'export const CLI_ENTRY = "apps/cli/src/main.ts";',
      33: 'export const WORKSPACES = ["apps/*", "packages/*"] as const;',
      34: 'export const PACKAGE_MANAGER = "bun";',
    }),
  };
  const workspace = materializeWorkspace(root, "inspection", files);
  const paths = ["package.json", "apps/daemon/src/engine.ts", "packages/protocol/src/index.ts"];
  const resultA = await executeReadFiles(registry, workspace, paths, signal);
  const resultB = await executeReadFiles(registry, workspace, paths, signal);
  const args = readArguments(paths);
  return {
    id: "repository-inspection-v1",
    kind: "inspection",
    workspacePath,
    files,
    messages: [
      { role: "system", content: defaultSystemPrompt(workspacePath) },
      { role: "user", content: "Inspect the repository architecture and context ownership." },
      { role: "assistant", content: null, toolCalls: [{ id: "inspect_a", name: "read_files", arguments: args }] },
      { role: "tool", toolCallId: "inspect_a", content: resultA },
      { role: "assistant", content: "I found the defining files and will reread them before answering." },
      { role: "user", content: "Re-read the defining files and verify exact entrypoints and context constants." },
      { role: "assistant", content: null, toolCalls: [{ id: "inspect_b", name: "read_files", arguments: args }] },
      { role: "tool", toolCallId: "inspect_b", content: resultB },
      { role: "assistant", content: "The defining files are consistent; I have enough evidence to answer without further tools." },
      { role: "user", content: "No tools. Return one JSON object with exactly these keys: packageManager, workspaceGlobs, entrypoints, context. entrypoints must contain exactly cli and daemon. context must contain exactly schemaVersion, capacityTokens, outputReserveTokens, toolDefinitionCount. Facts only; no Markdown or prose." },
    ],
    historicalTurns: [
      { id: "inspect-initial", startMessageIndex: 1, endMessageIndex: 5 },
      { id: "inspect-verify", startMessageIndex: 5, endMessageIndex: 9 },
    ],
    gold: {
      packageManager: "bun",
      workspaceGlobs: ["apps/*", "packages/*"],
      entrypoints: { cli: "apps/cli/src/main.ts", daemon: "apps/daemon/src/main.ts" },
      context: { schemaVersion: 3, capacityTokens: 8192, outputReserveTokens: 1536, toolDefinitionCount: 13 },
    },
  };
}

async function repairDraft(root: string, registry: ToolRegistry, signal: AbortSignal): Promise<FixtureDraft> {
  const workspacePath = "/benchmark/cache-key-service";
  const before = [
    "export interface CacheKeyOptions {",
    "  namespace: string;",
    "  port?: number;",
    "}",
    "function normalizeNamespace(namespace: string): string {",
    "  return namespace.trim().toLowerCase();",
    "}",
    "function normalizeKey(key: string): string {",
    "  return key.trim();",
    "}",
    "function resolvePort(port: number | undefined): number {",
    "  return port ?? 3000;",
    "}",
    "export function buildCacheKey(options: CacheKeyOptions, key: string): string {",
    "  const namespace = normalizeNamespace(options.namespace);",
    "  const port = resolvePort(options.port);",
    "  return `${namespace}:${port}:${normalizeKey(key)}`;",
    "}",
    "export function cacheKeyNamespace(value: string): string {",
    '  return value.split(":", 1)[0] ?? "";',
    "}",
    "export function cacheKeyPort(value: string): number | null {",
    '  const segment = value.split(":", 3)[1];',
    "  if (!segment) return null;",
    "  const parsed = Number(segment);",
    "  return Number.isSafeInteger(parsed) ? parsed : null;",
    "}",
  ].join("\n") + "\n";
  const after = before.replace("return port ?? 3000", "return port ?? 7337");
  const testFile = [
    'import { expect, test } from "bun:test";',
    'import { buildCacheKey, cacheKeyNamespace, cacheKeyPort } from "../src/cache-key";',
    'test("default port", () => expect(buildCacheKey({ namespace: "API" }, "x")).toBe("api:7337:x"));',
    'test("explicit port", () => expect(buildCacheKey({ namespace: "API", port: 9000 }, "x")).toBe("api:9000:x"));',
    'test("namespace", () => expect(buildCacheKey({ namespace: " API " }, "x")).toStartWith("api:"));',
    'test("key", () => expect(buildCacheKey({ namespace: "api" }, "a:b")).toEndWith(":a:b"));',
    'test("empty namespace", () => expect(buildCacheKey({ namespace: " " }, "x")).toBe(":7337:x"));',
    'test("uppercase namespace", () => expect(buildCacheKey({ namespace: "WORKER" }, "x")).toBe("worker:7337:x"));',
    'test("trimmed key", () => expect(buildCacheKey({ namespace: "api" }, " x ")).toBe("api:7337:x"));',
    'test("zero port", () => expect(buildCacheKey({ namespace: "api", port: 0 }, "x")).toBe("api:0:x"));',
    'test("maximum port", () => expect(buildCacheKey({ namespace: "api", port: 65535 }, "x")).toBe("api:65535:x"));',
    'test("numeric key", () => expect(buildCacheKey({ namespace: "api" }, "42")).toBe("api:7337:42"));',
    'test("hyphenated namespace", () => expect(buildCacheKey({ namespace: "job-queue" }, "x")).toStartWith("job-queue:"));',
    'test("namespace extraction", () => expect(cacheKeyNamespace("api:7337:x")).toBe("api"));',
    'test("empty namespace extraction", () => expect(cacheKeyNamespace(":7337:x")).toBe(""));',
    'test("port extraction", () => expect(cacheKeyPort("api:7337:x")).toBe(7337));',
    'test("explicit port extraction", () => expect(cacheKeyPort("api:9000:x")).toBe(9000));',
    'test("missing port extraction", () => expect(cacheKeyPort("api")).toBeNull());',
    'test("invalid port extraction", () => expect(cacheKeyPort("api:none:x")).toBeNull());',
    'test("negative port extraction", () => expect(cacheKeyPort("api:-1:x")).toBe(-1));',
    'test("key separators preserved", () => expect(buildCacheKey({ namespace: "api" }, "a:b:c")).toEndWith(":a:b:c"));',
    'test("dotted key preserved", () => expect(buildCacheKey({ namespace: "api" }, "cache.v1")).toEndWith(":cache.v1"));',
  ].join("\n") + "\n";
  const files = {
    "package.json": `${JSON.stringify({ name: "cache-key-service", type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
    "src/cache-key.ts": after,
    "test/cache-key.test.ts": testFile,
  };
  const workspace = materializeWorkspace(root, "repair", { ...files, "src/cache-key.ts": before });
  const beforeRead = await executeReadFiles(registry, workspace, ["src/cache-key.ts", "test/cache-key.test.ts"], signal);
  writeFileSync(join(workspace, "src/cache-key.ts"), after, "utf8");
  const afterRead = await executeReadFiles(registry, workspace, ["src/cache-key.ts"], signal);
  const failingOutput = [
    "test/cache-key.test.ts:",
    "3 | test default port",
    "expect(received).toBe(expected)",
    "Expected: api:7337:x",
    "Received: api:3000:x",
    "at test/cache-key.test.ts:3:89",
    "1 fail, 19 pass",
    "Ran 20 tests across 1 file",
  ].join("\n");
  return {
    id: "repository-single-file-repair-v1",
    kind: "single_file_repair",
    workspacePath,
    files,
    messages: [
      { role: "system", content: defaultSystemPrompt(workspacePath) },
      { role: "user", content: "Diagnose the cache-key failure without editing." },
      { role: "assistant", content: null, toolCalls: [{ id: "read_bug", name: "read_files", arguments: readArguments(["src/cache-key.ts", "test/cache-key.test.ts"]) }] },
      { role: "tool", toolCallId: "read_bug", content: beforeRead },
      { role: "assistant", content: null, toolCalls: [{ id: "test_fail", name: "run_command", arguments: JSON.stringify({ argv: ["bun", "test", "test/cache-key.test.ts"] }) }] },
      { role: "tool", toolCallId: "test_fail", content: commandResult(["bun", "test", "test/cache-key.test.ts"], 1, failingOutput) },
      { role: "assistant", content: "The focused failure has one source-level cause; I can make a one-line repair without changing the public function signature." },
      { role: "user", content: "Repair only src/cache-key.ts, reread it, and run the focused test." },
      { role: "assistant", content: null, toolCalls: [{ id: "edit_fix", name: "edit_file", arguments: JSON.stringify({ path: "src/cache-key.ts", edits: [{ oldText: "  return port ?? 3000;", newText: "  return port ?? 7337;" }] }) }] },
      { role: "tool", toolCallId: "edit_fix", content: JSON.stringify({ path: "src/cache-key.ts", created: false, bytes: Buffer.byteLength(after), strategy: "exact", replacements: 1 }) },
      { role: "assistant", content: null, toolCalls: [{ id: "read_fixed", name: "read_files", arguments: readArguments(["src/cache-key.ts"]) }] },
      { role: "tool", toolCallId: "read_fixed", content: afterRead },
      { role: "assistant", content: null, toolCalls: [{ id: "test_pass", name: "run_command", arguments: JSON.stringify({ argv: ["bun", "test", "test/cache-key.test.ts"] }) }] },
      { role: "tool", toolCallId: "test_pass", content: commandResult(["bun", "test", "test/cache-key.test.ts"], 0, "20 pass, 0 fail\nRan 20 tests across 1 file") },
      { role: "assistant", content: "The requested edit and focused validation are complete; the retained tool evidence contains the exact scope and result." },
      { role: "user", content: "No tools. Return one JSON object with exactly these keys: changedFiles, publicFunction, defaultPort, validation. defaultPort must contain exactly before and after. validation must contain exactly argv, exitCode, passed, failed. Facts only; no Markdown or prose." },
    ],
    historicalTurns: [
      { id: "diagnose", startMessageIndex: 1, endMessageIndex: 7 },
      { id: "repair", startMessageIndex: 7, endMessageIndex: 15 },
    ],
    gold: {
      changedFiles: ["src/cache-key.ts"],
      publicFunction: "buildCacheKey",
      defaultPort: { before: 3000, after: 7337 },
      validation: { argv: ["bun", "test", "test/cache-key.test.ts"], exitCode: 0, passed: 20, failed: 0 },
    },
  };
}

async function featureDraft(root: string, registry: ToolRegistry, signal: AbortSignal): Promise<FixtureDraft> {
  const workspacePath = "/benchmark/runtime-feature";
  const protocolBefore = generatedFile(12, "protocol", {
    1: 'const RUNTIME_INFO_TYPE = "RuntimeInfo";',
    2: "export interface RuntimeInfo {",
    3: "  provider: string;",
    4: "  model: string;",
    5: "  verified: boolean;",
    6: "}",
  });
  const protocolAfter = protocolBefore.replace("const RUNTIME_INFO_TYPE", "export const RUNTIME_INFO_TYPE");
  const appBefore = generatedFile(12, "daemon", {
    1: 'import type { RuntimeInfo } from "@runtime/protocol";',
    2: "export function route(method: string, path: string): RuntimeInfo | null {",
    3: '  if (method === "GET" && path === "/v1/run") return runtimeInfo();',
    4: "  return null;",
    5: "}",
    6: "function runtimeInfo(): RuntimeInfo {",
    7: '  return { provider: "ollama", model: "qwen3.8", verified: true };',
    8: "}",
  });
  const appAfter = appBefore.replace('/v1/run"', '/v1/runtime"');
  const cliBefore = generatedFile(12, "cli", {
    1: 'export const commands = ["/sessions", "/models", "/runtim"] as const;',
    2: "export type Command = typeof commands[number];",
  });
  const cliAfter = cliBefore.replace('"/runtim"', '"/runtime"');
  const testFile = generatedFile(30, "test", {
    1: 'import { expect, test } from "bun:test";',
    2: 'import { route } from "../apps/daemon/src/app";',
    3: 'import { commands } from "../apps/cli/src/main";',
    4: 'import { RUNTIME_INFO_TYPE, type RuntimeInfo } from "../packages/protocol/src/index";',
    5: 'test("GET /v1/runtime", () => expect(route("GET", "/v1/runtime")).toEqual({ provider: "ollama", model: "qwen3.8", verified: true } satisfies RuntimeInfo));',
    6: 'test("CLI /runtime", () => expect(commands).toContain("/runtime"));',
    7: 'test("runtime type export", () => expect(RUNTIME_INFO_TYPE).toBe("RuntimeInfo"));',
    29: "// 3 feature tests",
    30: "// expected: 3 pass, 0 fail",
  });
  const beforeFiles = {
    "packages/protocol/src/index.ts": protocolBefore,
    "apps/daemon/src/app.ts": appBefore,
    "apps/cli/src/main.ts": cliBefore,
    "test/runtime-info.test.ts": testFile,
  };
  const files = {
    "packages/protocol/src/index.ts": protocolAfter,
    "apps/daemon/src/app.ts": appAfter,
    "apps/cli/src/main.ts": cliAfter,
    "test/runtime-info.test.ts": testFile,
  };
  const workspace = materializeWorkspace(root, "feature", beforeFiles);
  const paths = Object.keys(beforeFiles);
  const beforeRead = await executeReadFiles(registry, workspace, paths.slice(0, 3), signal);
  const testContractRead = await executeReadFiles(registry, workspace, ["test/runtime-info.test.ts"], signal);
  for (const [path, content] of Object.entries(files)) writeWorkspaceFile(workspace, path, content);
  const afterRead = await executeReadFiles(registry, workspace, paths, signal);
  return {
    id: "repository-multi-file-feature-v1",
    kind: "multi_file_feature",
    workspacePath,
    files,
    messages: [
      { role: "system", content: defaultSystemPrompt(workspacePath) },
      { role: "user", content: "Inspect the failing runtime-information feature without editing." },
      { role: "assistant", content: null, toolCalls: [{ id: "read_baseline", name: "read_files", arguments: readArguments(paths.slice(0, 3)) }] },
      { role: "tool", toolCallId: "read_baseline", content: beforeRead },
      { role: "assistant", content: "The failing feature spans the protocol, daemon route, and CLI command; I will verify the test contract before editing." },
      { role: "user", content: "Read the focused test contract before making changes." },
      { role: "assistant", content: null, toolCalls: [{ id: "read_test_contract", name: "read_files", arguments: readArguments(["test/runtime-info.test.ts"]) }] },
      { role: "tool", toolCallId: "read_test_contract", content: testContractRead },
      { role: "assistant", content: "The focused test contract covers the route response, CLI command, and runtime type export." },
      { role: "user", content: "Implement the three-file runtime feature, reread all defining files, and run the focused test." },
      { role: "assistant", content: null, toolCalls: [
        { id: "edit_protocol", name: "edit_file", arguments: JSON.stringify({ path: "packages/protocol/src/index.ts", edits: [{ oldText: "const RUNTIME_INFO_TYPE", newText: "export const RUNTIME_INFO_TYPE" }] }) },
        { id: "edit_app", name: "edit_file", arguments: JSON.stringify({ path: "apps/daemon/src/app.ts", edits: [{ oldText: 'path === "/v1/run"', newText: 'path === "/v1/runtime"' }] }) },
        { id: "edit_cli", name: "edit_file", arguments: JSON.stringify({ path: "apps/cli/src/main.ts", edits: [{ oldText: '"/runtim"', newText: '"/runtime"' }] }) },
      ] },
      { role: "tool", toolCallId: "edit_protocol", content: editResult("packages/protocol/src/index.ts", protocolAfter) },
      { role: "tool", toolCallId: "edit_app", content: editResult("apps/daemon/src/app.ts", appAfter) },
      { role: "tool", toolCallId: "edit_cli", content: editResult("apps/cli/src/main.ts", cliAfter) },
      { role: "assistant", content: null, toolCalls: [{ id: "read_feature", name: "read_files", arguments: readArguments(paths) }] },
      { role: "tool", toolCallId: "read_feature", content: afterRead },
      { role: "assistant", content: null, toolCalls: [{ id: "test_feature", name: "run_command", arguments: JSON.stringify({ argv: ["bun", "test", "test/runtime-info.test.ts"] }) }] },
      { role: "tool", toolCallId: "test_feature", content: commandResult(["bun", "test", "test/runtime-info.test.ts"], 0, "3 pass, 0 fail\nRan 3 tests across 1 file") },
      { role: "assistant", content: "The three requested edits and focused validation are complete; the retained tool evidence contains the exact contract." },
      { role: "user", content: "No tools. Return one JSON object with exactly these keys: changedFiles, http, cliCommand, validation. http must contain exactly method, path, responseType. validation must contain exactly argv, exitCode, passed, failed. Facts only; no Markdown or prose." },
    ],
    historicalTurns: [
      { id: "feature-inspect", startMessageIndex: 1, endMessageIndex: 5 },
      { id: "feature-contract", startMessageIndex: 5, endMessageIndex: 9 },
      { id: "feature-implement", startMessageIndex: 9, endMessageIndex: 19 },
    ],
    gold: {
      changedFiles: ["apps/cli/src/main.ts", "apps/daemon/src/app.ts", "packages/protocol/src/index.ts"],
      http: { method: "GET", path: "/v1/runtime", responseType: "RuntimeInfo" },
      cliCommand: "/runtime",
      validation: { argv: ["bun", "test", "test/runtime-info.test.ts"], exitCode: 0, passed: 3, failed: 0 },
    },
  };
}

function finalizeFixture(draft: FixtureDraft, tools: ProviderToolDefinition[]): RepositoryContextFixture {
  const rawMessages = structuredClone(draft.messages);
  const original = stableJson(rawMessages);
  const planned = planContextRequest({
    messages: rawMessages,
    tools,
    historicalTurns: draft.historicalTurns,
    capacityTokens: REPOSITORY_CONTEXT_CAPACITY,
    outputReserveTokens: REPOSITORY_CONTEXT_OUTPUT_RESERVE,
  });
  if (stableJson(rawMessages) !== original) throw new Error(`Planner mutated fixture ${draft.id}`);
  const repositoryManifest = Object.entries(draft.files).sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: Bun.CryptoHasher.hash("sha256", content, "hex"),
  }));
  const repositoryManifestSha256 = Bun.CryptoHasher.hash("sha256", stableJson(repositoryManifest), "hex");
  const fingerprintInput: RepositoryFixtureFingerprintInput = {
    id: draft.id,
    version: REPOSITORY_CONTEXT_FIXTURE_VERSION,
    kind: draft.kind,
    workspacePath: draft.workspacePath,
    repositoryManifest,
    repositoryManifestSha256,
    rawMessages,
    reducedMessages: planned.messages,
    tools,
    plan: planned.plan,
    historicalTurns: draft.historicalTurns,
    gold: draft.gold,
  };
  const fixture: RepositoryContextFixture = {
    ...fingerprintInput,
    fixtureSha256: calculateRepositoryFixtureSha256(fingerprintInput),
  };
  validateFixtureContract(fixture);
  return fixture;
}

export function calculateRepositoryFixtureSha256(fixture: RepositoryFixtureFingerprintInput): string {
  return Bun.CryptoHasher.hash("sha256", stableJson({
    id: fixture.id,
    version: fixture.version,
    kind: fixture.kind,
    workspacePath: fixture.workspacePath,
    repositoryManifest: fixture.repositoryManifest,
    repositoryManifestSha256: fixture.repositoryManifestSha256,
    historicalTurns: fixture.historicalTurns,
    toolDefinitionsSha256: REPOSITORY_TOOL_DEFINITIONS_SHA256,
    rawMessages: fixture.rawMessages,
    reducedMessages: fixture.reducedMessages,
    plan: fixture.plan,
    gold: fixture.gold,
  }), "hex");
}

function validateFixtureContract(fixture: RepositoryContextFixture): void {
  const expected = EXPECTED_FIXTURES[fixture.id as keyof typeof EXPECTED_FIXTURES];
  const actionKeys = fixture.plan.actions.map((action) => {
    if (action.kind === "deduplicate_historical_file_content") return `${action.kind}:${action.path}`;
    if (action.kind === "truncate_historical_tool_output") return `${action.kind}:${action.removedLines}`;
    return `${action.kind}:${action.turnId}`;
  });
  if (!expected || fixture.fixtureSha256 !== expected.fixtureSha256
    || fixture.repositoryManifestSha256 !== expected.manifestSha256
    || fixture.plan.originalEstimatedInputTokens !== expected.originalEstimate
    || fixture.plan.estimatedInputTokens !== expected.reducedEstimate
    || stableJson(actionKeys) !== stableJson(expected.actions)
    || fixture.plan.hardInputLimitTokens !== REPOSITORY_CONTEXT_HARD_INPUT_LIMIT
    || fixture.plan.maximumPlannedInputTokens !== 5_376
    || fixture.plan.budgetStatus !== "within_soft_limit"
    || fixture.plan.originalEstimatedInputTokens > REPOSITORY_CONTEXT_HARD_INPUT_LIMIT) {
    throw new Error(`Repository context fixture contract changed: ${fixture.id} ${JSON.stringify({
      fixtureSha256: fixture.fixtureSha256,
      manifestSha256: fixture.repositoryManifestSha256,
      originalEstimate: fixture.plan.originalEstimatedInputTokens,
      reducedEstimate: fixture.plan.estimatedInputTokens,
      actions: actionKeys,
    })}`);
  }
}

function materializeWorkspace(root: string, name: string, files: Record<string, string>): string {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files)) writeWorkspaceFile(workspace, path, content);
  return workspace;
}

function writeWorkspaceFile(workspace: string, path: string, content: string): void {
  const absolute = join(workspace, path);
  mkdirSync(join(absolute, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600 });
}

async function executeReadFiles(
  registry: ToolRegistry,
  workspaceRoot: string,
  paths: string[],
  signal: AbortSignal,
): Promise<string> {
  const tool = registry.get("read_files");
  if (!tool) throw new Error("read_files tool is unavailable");
  return tool.execute({ files: paths.map((path) => ({ path, offset: 1, limit: 200 })) }, { workspaceRoot, signal });
}

function readArguments(paths: string[]): string {
  return JSON.stringify({ files: paths.map((path) => ({ path, offset: 1, limit: 200 })) });
}

function commandResult(argv: string[], exitCode: number, stdout: string): string {
  void argv;
  return JSON.stringify({ exitCode, stdout, stderr: "", timedOut: false });
}

function editResult(path: string, content: string): string {
  return JSON.stringify({ path, created: false, bytes: Buffer.byteLength(content), strategy: "exact", replacements: 1 });
}

function generatedFile(length: number, tag: string, significant: Record<number, string>): string {
  return Array.from({ length }, (_, index) => significant[index + 1] ?? `// ${tag} ${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
