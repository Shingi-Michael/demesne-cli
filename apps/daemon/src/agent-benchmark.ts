#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  isRecord,
  readServerSentEvents,
  type ContextPlan,
  type ContextCompactionAction,
  type CreateSessionResponse,
  type EventEnvelope,
  type RuntimeProfileStatus,
  type SessionStateResponse,
  type SubmitTurnResponse,
  type TokenUsage,
} from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createDaemonApp } from "./app.ts";
import { defaultSystemPrompt } from "./engine.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
} from "./provider-benchmark.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import type { TurnProcessor } from "./processor.ts";
import { createRuntimeProfileVerifier } from "./ollama-runtime.ts";
import {
  planContextRequest,
  planDelayedHardContextRequest,
  planRawContextRequest,
  type ContextPlanner,
} from "./context-planner.ts";

export const AGENT_BENCHMARK_SCHEMA_VERSION = 12 as const;

interface AgentBenchmarkFixtureFile {
  path: string;
  initialContent: string;
  expectedContent: string;
}

interface AgentBenchmarkFixtureDefinition {
  id: string;
  prompt: string;
  expectedMarker: string;
  files: AgentBenchmarkFixtureFile[];
  requiredTools: string[];
  permissionMode: "ask" | "deny";
  allowedWritePaths: string[];
  allowedCommands: string[][];
  requiresSuccessfulCommand: boolean;
  requiresFailingThenSuccessfulCommand?: boolean;
  turns?: AgentBenchmarkFixtureTurn[];
  maximumToolCalls?: number;
  exactResponse?: boolean;
  requiredContextCapacity?: number;
  requiredMaxOutputTokens?: number;
  requireAllRoundsCalibration?: boolean;
}

interface AgentBenchmarkWorkspaceUpdate {
  path: string;
  expectedBeforeContent: string;
  content: string;
}

interface AgentBenchmarkExpectedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface AgentBenchmarkExpectedContextReduction {
  roundIndex: number;
  actionKinds: ContextCompactionAction["kind"][];
  deduplicatedPaths: string[];
  deduplicatedMessageIndex: number;
  retainedMessageIndex: number;
  truncatedMessageIndex: number;
  truncatedRemovedLines: number;
  droppedTurnIndex: number;
  retainedTurnIndex: number;
  droppedMessageCount: number;
  droppedMessageStartIndex: number;
  requireCalibration: boolean;
}

interface AgentBenchmarkFixtureTurn {
  prompt: string;
  expectedMarker: string;
  requiredTools?: string[];
  maximumToolCalls?: number;
  exactResponse?: boolean;
  roundShapes?: AgentCalibrationShape[];
  requireCompaction?: boolean;
  beforeWorkspaceUpdates?: AgentBenchmarkWorkspaceUpdate[];
  expectedToolCalls?: AgentBenchmarkExpectedToolCall[];
  exactModelRounds?: number;
  expectedContextReduction?: AgentBenchmarkExpectedContextReduction;
}

const CALCULATE_TOTAL_BUG = `export function calculateTotal(prices: number[]): number {
  return prices.reduce((total, price) => total - price, 0);
}
`;
const CALCULATE_TOTAL_FIXED = `export function calculateTotal(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
`;
const GREETING_BUG = `export function greeting(name: string): string {
  return \`Hello, \${name}.\`;
}
`;
const GREETING_FIXED = `export function greeting(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
const CALCULATE_TOTAL_TEST = `import { expect, test } from "bun:test";
import { calculateTotal } from "../src/calculate-total.ts";

test("adds prices", () => {
  expect(calculateTotal([10, 20, 5])).toBe(35);
});
`;
const TEST_PACKAGE = `{
  "name": "demesne-agent-benchmark-fixture",
  "private": true,
  "type": "module"
}
`;
const LARGE_HISTORY_FILE = Array.from(
  { length: 90 },
  (_, index) => `record-${String(index + 1).padStart(3, "0")}: ${"deterministic-history-value ".repeat(3).trim()}`,
).join("\n") + "\n";
const LONG_SESSION_STABLE_FILE = Array.from(
  { length: 90 },
  (_, index) => `S-${String(index + 1).padStart(3, "0")}: ${"s".repeat(8)}`,
).join("\n") + "\n";
const LONG_SESSION_CHANGING_FILE_A = Array.from(
  { length: 20 },
  (_, index) => `A-${String(index + 1).padStart(3, "0")}: ${"a".repeat(10)}`,
).join("\n") + "\n";
const LONG_SESSION_CHANGING_FILE_B = Array.from(
  { length: 20 },
  (_, index) => `B-${String(index + 1).padStart(3, "0")}: ${"b".repeat(10)}`,
).join("\n") + "\n";
const LONG_SESSION_READ_ARGUMENTS = {
  files: [
    { path: "data/stable.txt", offset: 1, limit: 90 },
    { path: "data/changing.txt", offset: 1, limit: 90 },
  ],
};
const FULL_AGENT_ARCHITECTURE = Array.from({ length: 48 }, (_, index) => {
  const component = ["daemon", "cli", "protocol", "storage", "provider", "scheduler"][index % 6]!;
  return `ARCH-${String(index + 1).padStart(2, "0")}: ${component} owns ${component}-specific lifecycle and validation boundaries.`;
}).join("\n") + "\n";
const FULL_AGENT_RUNTIME = `export const RUNTIME_PROFILE = "balanced-32gb";
export const CONTEXT_CAPACITY = 8192;
export const INFERENCE_SLOTS = 1;
export function runtimeSummary(): string {
  return [RUNTIME_PROFILE, CONTEXT_CAPACITY, INFERENCE_SLOTS].join(":");
}
`;
const FULL_AGENT_PACKAGE = `{
  "name": "full-agent-inspection",
  "private": true,
  "type": "module",
  "scripts": { "test": "bun test" }
}
`;
const FULL_AGENT_CACHE_BUG = `export interface CacheOptions {
  namespace: string;
  port?: number;
}
export function cacheKey(options: CacheOptions, key: string): string {
  const namespace = options.namespace.trim().toLowerCase();
  const port = options.port ?? 3000;
  return namespace + ":" + port + ":" + key;
}
`;
const FULL_AGENT_CACHE_FIXED = FULL_AGENT_CACHE_BUG.replace("options.port ?? 3000", "options.port ?? 7337");
const FULL_AGENT_CACHE_TEST = `import { expect, test } from "bun:test";
import { cacheKey } from "../src/cache.ts";
test("default port", () => expect(cacheKey({ namespace: "API" }, "x")).toBe("api:7337:x"));
test("explicit port", () => expect(cacheKey({ namespace: "API", port: 9000 }, "x")).toBe("api:9000:x"));
`;
const FULL_AGENT_DEBUG_LOG = Array.from({ length: 42 }, (_, index) => {
  const port = index === 41 ? 3000 : 7_200 + index;
  return `TRACE-${String(index + 1).padStart(2, "0")}: namespace=api resolved_port=${port} key=job-${index + 1}`;
}).join("\n") + "\n";
const FULL_AGENT_PROTOCOL_BUG = `const RUNTIME_INFO_TYPE = "RuntimeInfo";
export interface RuntimeInfo {
  provider: string;
  model: string;
  verified: boolean;
}
`;
const FULL_AGENT_PROTOCOL_FIXED = FULL_AGENT_PROTOCOL_BUG.replace(
  "const RUNTIME_INFO_TYPE",
  "export const RUNTIME_INFO_TYPE",
);
const FULL_AGENT_APP_BUG = `import type { RuntimeInfo } from "../../packages/protocol/src/index.ts";
export function route(method: string, path: string): RuntimeInfo | null {
  if (method === "GET" && path === "/v1/run") {
    return { provider: "ollama", model: "qwen3.8", verified: true };
  }
  return null;
}
`;
const FULL_AGENT_APP_FIXED = FULL_AGENT_APP_BUG.replace('path === "/v1/run"', 'path === "/v1/runtime"');
const FULL_AGENT_CLI_BUG = `export const commands = ["/sessions", "/models", "/runtim"] as const;
`;
const FULL_AGENT_CLI_FIXED = FULL_AGENT_CLI_BUG.replace('"/runtim"', '"/runtime"');
const FULL_AGENT_FEATURE_TEST = `import { expect, test } from "bun:test";
import { route } from "../apps/daemon/src/app.ts";
import { commands } from "../apps/cli/src/main.ts";
import { RUNTIME_INFO_TYPE } from "../packages/protocol/src/index.ts";
test("runtime route", () => expect(route("GET", "/v1/runtime")).toEqual({ provider: "ollama", model: "qwen3.8", verified: true }));
test("runtime command", () => expect(commands).toContain("/runtime"));
test("runtime type", () => expect(RUNTIME_INFO_TYPE).toBe("RuntimeInfo"));
`;
const FULL_AGENT_FEATURE_SPEC = Array.from({ length: 36 }, (_, index) => {
  const area = ["protocol export", "GET route", "CLI command", "focused validation"][index % 4]!;
  return `REQ-${String(index + 1).padStart(2, "0")}: preserve ${area} while changing only its declared source file.`;
}).join("\n") + "\n";
const FULL_AGENT_QUALITY_LEDGER = Array.from({ length: 80 }, (_, index) => {
  const line = index + 1;
  if (line === 2) return "L002: ALPHA_OWNER=daemon";
  if (line === 40) return "L040: MIDDLE_OUTPUT_RESERVE=1536";
  if (line === 64) return "L064: SUPERSEDED_PORT=3000";
  if (line === 79) return "L079: CURRENT_PORT=7337";
  return `L${String(line).padStart(3, "0")}: archive filler token-${String(line).padStart(3, "0")} remains inert`;
}).join("\n") + "\n";
const FULL_AGENT_BUDGET_BUG = `export interface ContextLimits {
  capacityTokens: number;
  outputReserveTokens: number;
  toolReserveTokens: number;
  safetyReserveTokens: number;
}
export function softInputLimit(limits: ContextLimits): number {
  return limits.capacityTokens - limits.outputReserveTokens;
}
`;
const FULL_AGENT_BUDGET_FIXED = FULL_AGENT_BUDGET_BUG.replace(
  "limits.capacityTokens - limits.outputReserveTokens",
  "limits.capacityTokens - limits.outputReserveTokens - limits.toolReserveTokens - limits.safetyReserveTokens",
);
const FULL_AGENT_ADMISSION_BUG = `import { type ContextLimits } from "./budget.ts";
export function canAdmit(estimatedInputTokens: number, limits: ContextLimits): boolean {
  return estimatedInputTokens <= limits.capacityTokens;
}
`;
const FULL_AGENT_ADMISSION_FIXED = `import { softInputLimit, type ContextLimits } from "./budget.ts";
export function canAdmit(estimatedInputTokens: number, limits: ContextLimits): boolean {
  return estimatedInputTokens <= softInputLimit(limits);
}
`;
const FULL_AGENT_BUDGET_SPEC = `Context admission contract:
- softInputLimit subtracts output, future tool-result, and safety reserves from capacity.
- canAdmit compares estimated input against softInputLimit, not raw capacity.
- preserve the ContextLimits public fields and change only src/budget.ts and src/admission.ts.
`;
const FULL_AGENT_BUDGET_TEST = `import { expect, test } from "bun:test";
import { softInputLimit, type ContextLimits } from "../src/budget.ts";
import { canAdmit } from "../src/admission.ts";
const limits: ContextLimits = {
  capacityTokens: 8192,
  outputReserveTokens: 1536,
  toolReserveTokens: 768,
  safetyReserveTokens: 512,
};
test("soft input limit reserves future capacity", () => expect(softInputLimit(limits)).toBe(5376));
test("admits at the soft limit", () => expect(canAdmit(5376, limits)).toBe(true));
test("rejects above the soft limit", () => expect(canAdmit(5377, limits)).toBe(false));
`;

export const PAIRED_FULL_AGENT_FIXTURE_IDS = [
  "full-agent-repository-inspection-v1",
  "full-agent-single-file-repair-v1",
  "full-agent-multi-file-feature-v1",
  "full-agent-long-context-recall-v1",
  "full-agent-two-file-regression-repair-v1",
] as const;

export const CACHE_TIMING_FULL_AGENT_FIXTURE_IDS = [
  ...PAIRED_FULL_AGENT_FIXTURE_IDS,
  "schema3-long-session-calibration-v1",
] as const;

const AGENT_BENCHMARK_FIXTURES: Record<string, AgentBenchmarkFixtureDefinition> = {
  "full-agent-repository-inspection-v1": {
    id: "full-agent-repository-inspection-v1",
    prompt: "Read docs/architecture.txt and reply with exactly this line:\nHISTORY: architecture loaded",
    expectedMarker: "HISTORY: architecture loaded",
    files: [
      { path: "docs/architecture.txt", initialContent: FULL_AGENT_ARCHITECTURE, expectedContent: FULL_AGENT_ARCHITECTURE },
      { path: "src/runtime.ts", initialContent: FULL_AGENT_RUNTIME, expectedContent: FULL_AGENT_RUNTIME },
      { path: "package.json", initialContent: FULL_AGENT_PACKAGE, expectedContent: FULL_AGENT_PACKAGE },
    ],
    requiredTools: ["read_file", "read_files"],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 3,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: "Use read_file exactly once on docs/architecture.txt with offset 1 and limit 48. Then reply with exactly this line:\nHISTORY: architecture loaded",
        expectedMarker: "HISTORY: architecture loaded",
        requiredTools: ["read_file"],
        maximumToolCalls: 1,
        exactResponse: true,
      },
      {
        prompt: "Use read_files exactly once to read src/runtime.ts and package.json. Do not use other tools. Then reply with exactly this line:\nINSPECTION: balanced-32gb uses 8192 context and one inference slot",
        expectedMarker: "INSPECTION: balanced-32gb uses 8192 context and one inference slot",
        requiredTools: ["read_files"],
        maximumToolCalls: 1,
        exactResponse: true,
      },
    ],
  },
  "full-agent-single-file-repair-v1": {
    id: "full-agent-single-file-repair-v1",
    prompt: "Run the focused test, read src/cache.ts and docs/cache-debug.log, then reply exactly:\nDIAGNOSIS: default cache port is wrong",
    expectedMarker: "DIAGNOSIS: default cache port is wrong",
    files: [
      { path: "src/cache.ts", initialContent: FULL_AGENT_CACHE_BUG, expectedContent: FULL_AGENT_CACHE_FIXED },
      { path: "test/cache.test.ts", initialContent: FULL_AGENT_CACHE_TEST, expectedContent: FULL_AGENT_CACHE_TEST },
      { path: "docs/cache-debug.log", initialContent: FULL_AGENT_DEBUG_LOG, expectedContent: FULL_AGENT_DEBUG_LOG },
      { path: "package.json", initialContent: TEST_PACKAGE, expectedContent: TEST_PACKAGE },
    ],
    requiredTools: ["run_command", "read_files", "edit_file"],
    permissionMode: "ask",
    allowedWritePaths: ["src/cache.ts"],
    allowedCommands: [["bun", "test", "test/cache.test.ts"]],
    requiresSuccessfulCommand: true,
    requiresFailingThenSuccessfulCommand: true,
    maximumToolCalls: 5,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: "First call run_command exactly once with [\"bun\",\"test\",\"test/cache.test.ts\"]. Then call read_files exactly once for src/cache.ts and docs/cache-debug.log. Do not edit. Reply with exactly this line:\nDIAGNOSIS: default cache port is wrong",
        expectedMarker: "DIAGNOSIS: default cache port is wrong",
        requiredTools: ["run_command", "read_files"],
        maximumToolCalls: 2,
        exactResponse: true,
      },
      {
        prompt: "Use edit_file to change only src/cache.ts so the default port is 7337 instead of 3000. Then call run_command exactly once with [\"bun\",\"test\",\"test/cache.test.ts\"]. Reply with exactly this line:\nREPAIR: cache tests pass",
        expectedMarker: "REPAIR: cache tests pass",
        requiredTools: ["edit_file", "run_command"],
        maximumToolCalls: 2,
        exactResponse: true,
      },
    ],
  },
  "full-agent-multi-file-feature-v1": {
    id: "full-agent-multi-file-feature-v1",
    prompt: "Run the focused feature test and inspect the feature specification and three source files.",
    expectedMarker: "DIAGNOSIS: runtime feature needs three source edits",
    files: [
      { path: "packages/protocol/src/index.ts", initialContent: FULL_AGENT_PROTOCOL_BUG, expectedContent: FULL_AGENT_PROTOCOL_FIXED },
      { path: "apps/daemon/src/app.ts", initialContent: FULL_AGENT_APP_BUG, expectedContent: FULL_AGENT_APP_FIXED },
      { path: "apps/cli/src/main.ts", initialContent: FULL_AGENT_CLI_BUG, expectedContent: FULL_AGENT_CLI_FIXED },
      { path: "test/runtime-info.test.ts", initialContent: FULL_AGENT_FEATURE_TEST, expectedContent: FULL_AGENT_FEATURE_TEST },
      { path: "docs/runtime-feature.txt", initialContent: FULL_AGENT_FEATURE_SPEC, expectedContent: FULL_AGENT_FEATURE_SPEC },
      { path: "package.json", initialContent: TEST_PACKAGE, expectedContent: TEST_PACKAGE },
    ],
    requiredTools: ["run_command", "read_files", "edit_file"],
    permissionMode: "ask",
    allowedWritePaths: [
      "packages/protocol/src/index.ts",
      "apps/daemon/src/app.ts",
      "apps/cli/src/main.ts",
    ],
    allowedCommands: [["bun", "test", "test/runtime-info.test.ts"]],
    requiresSuccessfulCommand: true,
    requiresFailingThenSuccessfulCommand: true,
    maximumToolCalls: 8,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: "First call run_command exactly once with [\"bun\",\"test\",\"test/runtime-info.test.ts\"]. Then call read_files exactly once for docs/runtime-feature.txt, packages/protocol/src/index.ts, apps/daemon/src/app.ts, and apps/cli/src/main.ts. Do not edit. Reply with exactly this line:\nDIAGNOSIS: runtime feature needs three source edits",
        expectedMarker: "DIAGNOSIS: runtime feature needs three source edits",
        requiredTools: ["run_command", "read_files"],
        maximumToolCalls: 2,
        exactResponse: true,
      },
      {
        prompt: "Use edit_file on exactly these three files: export RUNTIME_INFO_TYPE in packages/protocol/src/index.ts, change /v1/run to /v1/runtime in apps/daemon/src/app.ts, and change /runtim to /runtime in apps/cli/src/main.ts. Then call run_command exactly once with [\"bun\",\"test\",\"test/runtime-info.test.ts\"]. Reply with exactly this line:\nFEATURE: runtime route and command pass",
        expectedMarker: "FEATURE: runtime route and command pass",
        requiredTools: ["edit_file", "run_command"],
        maximumToolCalls: 4,
        exactResponse: true,
      },
    ],
  },
  "full-agent-long-context-recall-v1": {
    id: "full-agent-long-context-recall-v1",
    prompt: "Read the quality ledger, then recall its early, middle, superseded, and latest facts in a later turn.",
    expectedMarker: "QUALITY HISTORY: loaded",
    files: [{
      path: "docs/quality-ledger.txt",
      initialContent: FULL_AGENT_QUALITY_LEDGER,
      expectedContent: FULL_AGENT_QUALITY_LEDGER,
    }],
    requiredTools: ["read_file"],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 1,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: "Use read_file exactly once on docs/quality-ledger.txt with offset 1 and limit 80. Then reply with exactly this line:\nQUALITY HISTORY: loaded",
        expectedMarker: "QUALITY HISTORY: loaded",
        requiredTools: ["read_file"],
        maximumToolCalls: 1,
        exactResponse: true,
      },
      {
        prompt: "Do not use tools. From the quality ledger in history, return the owner, middle output reserve, superseded port, and current port. Reply with exactly this line:\nQUALITY RECALL: owner=daemon middle=1536 old_port=3000 current_port=7337",
        expectedMarker: "QUALITY RECALL: owner=daemon middle=1536 old_port=3000 current_port=7337",
        requiredTools: [],
        maximumToolCalls: 0,
        exactResponse: true,
      },
    ],
  },
  "full-agent-two-file-regression-repair-v1": {
    id: "full-agent-two-file-regression-repair-v1",
    prompt: "Diagnose and repair the context-admission contract using the focused test and specification.",
    expectedMarker: "QUALITY DIAGNOSIS: reserves and admission disagree",
    files: [
      { path: "src/budget.ts", initialContent: FULL_AGENT_BUDGET_BUG, expectedContent: FULL_AGENT_BUDGET_FIXED },
      { path: "src/admission.ts", initialContent: FULL_AGENT_ADMISSION_BUG, expectedContent: FULL_AGENT_ADMISSION_FIXED },
      { path: "docs/context-contract.txt", initialContent: FULL_AGENT_BUDGET_SPEC, expectedContent: FULL_AGENT_BUDGET_SPEC },
      { path: "test/context-budget.test.ts", initialContent: FULL_AGENT_BUDGET_TEST, expectedContent: FULL_AGENT_BUDGET_TEST },
      { path: "package.json", initialContent: TEST_PACKAGE, expectedContent: TEST_PACKAGE },
    ],
    requiredTools: ["run_command", "read_files", "edit_file"],
    permissionMode: "ask",
    allowedWritePaths: ["src/budget.ts", "src/admission.ts"],
    allowedCommands: [["bun", "test", "test/context-budget.test.ts"]],
    requiresSuccessfulCommand: true,
    requiresFailingThenSuccessfulCommand: true,
    maximumToolCalls: 5,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: "First call run_command exactly once with [\"bun\",\"test\",\"test/context-budget.test.ts\"]. Then call read_files exactly once for docs/context-contract.txt, src/budget.ts, src/admission.ts, and test/context-budget.test.ts. Do not edit. Infer the contract violation and reply with exactly this line:\nQUALITY DIAGNOSIS: reserves and admission disagree",
        expectedMarker: "QUALITY DIAGNOSIS: reserves and admission disagree",
        requiredTools: ["run_command", "read_files"],
        maximumToolCalls: 2,
        exactResponse: true,
      },
      {
        prompt: "Implement the context-admission contract from the specification. Change only src/budget.ts and src/admission.ts, then call run_command exactly once with [\"bun\",\"test\",\"test/context-budget.test.ts\"]. Reply with exactly this line:\nQUALITY REPAIR: context budget tests pass",
        expectedMarker: "QUALITY REPAIR: context budget tests pass",
        requiredTools: ["edit_file", "run_command"],
        maximumToolCalls: 3,
        exactResponse: true,
      },
    ],
  },
  "direct-answer-calibration-v1": {
    id: "direct-answer-calibration-v1",
    prompt: "Do not use tools. Reply with exactly this line:\nCALIBRATION: direct answer",
    expectedMarker: "CALIBRATION: direct answer",
    files: [],
    requiredTools: [],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 0,
    exactResponse: true,
  },
  "read-only-arithmetic-diagnosis-v1": {
    id: "read-only-arithmetic-diagnosis-v1",
    prompt: "Inspect src/calculate-total.ts and identify its arithmetic bug. Do not modify any files. Use the read_file tool before answering. End your answer with exactly this line:\nBUG: total - price should be total + price",
    expectedMarker: "BUG: total - price should be total + price",
    files: [{ path: "src/calculate-total.ts", initialContent: CALCULATE_TOTAL_BUG, expectedContent: CALCULATE_TOTAL_BUG }],
    requiredTools: ["read_file"],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
  },
  "single-file-greeting-edit-v1": {
    id: "single-file-greeting-edit-v1",
    prompt: "Read src/greeting.ts, then use edit_file to make the greeting end with an exclamation mark instead of a period. Make no other changes. End your answer with exactly this line:\nEDIT: greeting uses an exclamation mark",
    expectedMarker: "EDIT: greeting uses an exclamation mark",
    files: [{ path: "src/greeting.ts", initialContent: GREETING_BUG, expectedContent: GREETING_FIXED }],
    requiredTools: ["read_file", "edit_file"],
    permissionMode: "ask",
    allowedWritePaths: ["src/greeting.ts"],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
  },
  "failed-test-arithmetic-repair-v1": {
    id: "failed-test-arithmetic-repair-v1",
    prompt: "Run the test suite with run_command using exactly [\"bun\", \"test\"]. Inspect the failing arithmetic implementation, use edit_file to fix the source without changing tests, then run the same test command again and confirm it passes. End your answer with exactly this line:\nREPAIR: tests pass",
    expectedMarker: "REPAIR: tests pass",
    files: [
      { path: "src/calculate-total.ts", initialContent: CALCULATE_TOTAL_BUG, expectedContent: CALCULATE_TOTAL_FIXED },
      { path: "test/calculate-total.test.ts", initialContent: CALCULATE_TOTAL_TEST, expectedContent: CALCULATE_TOTAL_TEST },
      { path: "package.json", initialContent: TEST_PACKAGE, expectedContent: TEST_PACKAGE },
    ],
    requiredTools: ["run_command", "read_file", "edit_file"],
    permissionMode: "ask",
    allowedWritePaths: ["src/calculate-total.ts"],
    allowedCommands: [["bun", "test"]],
    requiresSuccessfulCommand: true,
    requiresFailingThenSuccessfulCommand: true,
  },
  "growing-session-calibration-v1": {
    id: "growing-session-calibration-v1",
    prompt: growingSessionPrompt(1, 0),
    expectedMarker: "CALIBRATION: growing turn 1",
    files: [],
    requiredTools: [],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 0,
    exactResponse: true,
    turns: [
      { prompt: growingSessionPrompt(1, 0), expectedMarker: "CALIBRATION: growing turn 1" },
      { prompt: growingSessionPrompt(2, 32), expectedMarker: "CALIBRATION: growing turn 2" },
      { prompt: growingSessionPrompt(3, 64), expectedMarker: "CALIBRATION: growing turn 3" },
      { prompt: growingSessionPrompt(4, 128), expectedMarker: "CALIBRATION: growing turn 4" },
    ],
  },
  "multilingual-context-calibration-v1": {
    id: "multilingual-context-calibration-v1",
    prompt: multilingualStressPrompt(),
    expectedMarker: "CALIBRATION: multilingual context",
    files: [],
    requiredTools: [],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 0,
    exactResponse: true,
  },
  "escaped-json-calibration-v1": {
    id: "escaped-json-calibration-v1",
    prompt: escapedJsonStressPrompt(),
    expectedMarker: "CALIBRATION: escaped JSON",
    files: [],
    requiredTools: [],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 0,
    exactResponse: true,
  },
  "dense-code-calibration-v1": {
    id: "dense-code-calibration-v1",
    prompt: denseCodeStressPrompt(),
    expectedMarker: "CALIBRATION: dense code",
    files: [],
    requiredTools: [],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 0,
    exactResponse: true,
  },
  "historical-tool-output-calibration-v1": {
    id: "historical-tool-output-calibration-v1",
    prompt: "Use read_file exactly once to read data/history.txt with offset 1 and limit 90. Then reply with exactly this line:\nCALIBRATION: historical source loaded",
    expectedMarker: "CALIBRATION: historical source loaded",
    files: [{ path: "data/history.txt", initialContent: LARGE_HISTORY_FILE, expectedContent: LARGE_HISTORY_FILE }],
    requiredTools: ["read_file"],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 1,
    exactResponse: true,
    turns: [
      {
        prompt: "Use read_file exactly once to read data/history.txt with offset 1 and limit 90. Then reply with exactly this line:\nCALIBRATION: historical source loaded",
        expectedMarker: "CALIBRATION: historical source loaded",
        requiredTools: ["read_file"],
        maximumToolCalls: 1,
        exactResponse: true,
        roundShapes: ["tool_selection", "tool_follow_up"],
      },
      {
        prompt: "Do not use tools. Reply with exactly this line:\nCALIBRATION: historical context compacted",
        expectedMarker: "CALIBRATION: historical context compacted",
        requiredTools: [],
        maximumToolCalls: 0,
        exactResponse: true,
        roundShapes: ["historical_compaction"],
        requireCompaction: true,
      },
    ],
  },
  "schema3-long-session-calibration-v1": {
    id: "schema3-long-session-calibration-v1",
    prompt: longSessionReadPrompt("A"),
    expectedMarker: "CALIBRATION: read set A",
    files: [
      { path: "data/stable.txt", initialContent: LONG_SESSION_STABLE_FILE, expectedContent: LONG_SESSION_STABLE_FILE },
      {
        path: "data/changing.txt",
        initialContent: LONG_SESSION_CHANGING_FILE_A,
        expectedContent: LONG_SESSION_CHANGING_FILE_B,
      },
    ],
    requiredTools: ["read_files"],
    permissionMode: "deny",
    allowedWritePaths: [],
    allowedCommands: [],
    requiresSuccessfulCommand: false,
    maximumToolCalls: 2,
    exactResponse: true,
    requiredContextCapacity: 8_192,
    requiredMaxOutputTokens: 1_536,
    requireAllRoundsCalibration: true,
    turns: [
      {
        prompt: longSessionReadPrompt("A"),
        expectedMarker: "CALIBRATION: read set A",
        requiredTools: ["read_files"],
        maximumToolCalls: 1,
        exactResponse: true,
        roundShapes: ["tool_selection", "tool_follow_up"],
        expectedToolCalls: [{ name: "read_files", arguments: LONG_SESSION_READ_ARGUMENTS }],
        exactModelRounds: 2,
      },
      {
        prompt: longSessionReadPrompt("B"),
        expectedMarker: "CALIBRATION: read set B",
        requiredTools: ["read_files"],
        maximumToolCalls: 1,
        exactResponse: true,
        roundShapes: ["tool_selection", "tool_follow_up"],
        beforeWorkspaceUpdates: [{
          path: "data/changing.txt",
          expectedBeforeContent: LONG_SESSION_CHANGING_FILE_A,
          content: LONG_SESSION_CHANGING_FILE_B,
        }],
        expectedToolCalls: [{ name: "read_files", arguments: LONG_SESSION_READ_ARGUMENTS }],
        exactModelRounds: 2,
      },
      {
        prompt: longSessionReductionPrompt(),
        expectedMarker: "CALIBRATION: schema 3 reduction",
        requiredTools: [],
        maximumToolCalls: 0,
        exactResponse: true,
        roundShapes: ["schema3_reduction"],
        expectedToolCalls: [],
        exactModelRounds: 1,
        expectedContextReduction: {
          roundIndex: 0,
          actionKinds: [
            "deduplicate_historical_file_content",
            "truncate_historical_tool_output",
            "drop_historical_turn",
          ],
          deduplicatedPaths: ["data/stable.txt"],
          deduplicatedMessageIndex: 3,
          retainedMessageIndex: 7,
          truncatedMessageIndex: 7,
          truncatedRemovedLines: 65,
          droppedTurnIndex: 0,
          retainedTurnIndex: 1,
          droppedMessageCount: 4,
          droppedMessageStartIndex: 1,
          requireCalibration: true,
        },
      },
    ],
  },
};
const BENCHMARK_SYSTEM_PROMPT_WORKSPACE = "/benchmark/workspace";

export interface AgentBenchmarkConfig {
  fixtureId: string;
  model: string;
  warmupRuns: number;
  measuredRuns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  contextPolicy?: "schema3" | "raw" | "delayed-hard";
}

export interface AgentBenchmarkObservation {
  sequence: number;
  phase: "warmup" | "measured";
  durationMs: number;
  status: string;
  success: boolean;
  expectedMarkerFound: boolean;
  requiredToolsObserved: boolean;
  maximumToolCallsObserved: boolean;
  workspaceValid: boolean;
  requiredCommandSucceeded: boolean;
  requiredCompactionObserved: boolean;
  exactToolCallsObserved: boolean;
  exactModelRoundsObserved: boolean;
  workspaceTransitionsValid: boolean;
  requiredContextReductionObserved: boolean;
  providerUsageCalibrationValid: boolean;
  modelRounds: number;
  toolCalls: number;
  toolNames: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  providerQueueDurationMs: number | null;
  providerDurationMs: number | null;
  providerTimeToFirstOutputMs: number[];
  contextTrimEvents: number;
  providerRounds: AgentProviderRound[];
  turnResponses: string[];
  responseText: string;
}

export type AgentCalibrationShape =
  | "direct"
  | "tool_selection"
  | "tool_follow_up"
  | "repair"
  | "growing_session"
  | "multilingual"
  | "escaped_json"
  | "dense_code"
  | "historical_compaction"
  | "schema3_reduction";

export interface AgentProviderRound {
  providerCallId: string;
  turnId: string;
  turnIndex: number;
  roundIndex: number;
  shape: AgentCalibrationShape;
  contextPlan: ContextPlan | null;
  usage: TokenUsage | null;
  outcome: "completed" | "failed" | "cancelled" | "interrupted" | null;
  queueDurationMs: number | null;
  durationMs: number | null;
  timeToFirstOutputMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  calibration: {
    eligible: boolean;
    exclusionReason: string | null;
    estimateErrorTokens: number | null;
    estimateToActualRatio: number | null;
    requiredCalibrationFactor: number | null;
  };
}

export interface AgentBenchmarkDependencies {
  processor: TurnProcessor;
  now?: () => number;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  backendVersion?: string;
  modelDigest?: string;
  endpoint?: string;
  sourceRevision?: string;
  systemPromptNonce?: string;
}

export interface AgentBenchmarkReport {
  schemaVersion: typeof AGENT_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
    bunVersion: string;
  };
  runtime: {
    provider: string;
    model: string;
    endpoint: string | null;
    backendVersion: string | null;
    contextBeforeRun: number | null;
    contextAfterRun: number | null;
    sourceRevision: string | null;
    modelDigest: string | null;
    profileStatus: RuntimeProfileStatus;
  };
  fixture: {
    id: string;
    prompt: string;
    expectedMarker: string;
    files: AgentBenchmarkFixtureFile[];
    requiredTools: string[];
    permissionMode: "ask" | "deny";
    requiresSuccessfulCommand: boolean;
    requiresFailingThenSuccessfulCommand: boolean;
    systemPromptWorkspace: string;
    turns: AgentBenchmarkFixtureTurn[];
    maximumToolCalls: number | null;
    exactResponse: boolean;
    requiredContextCapacity: number | null;
    requiredMaxOutputTokens: number | null;
    requireAllRoundsCalibration: boolean;
  };
  config: AgentBenchmarkConfig;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: {
    before: HostPowerSnapshot | null;
    after: HostPowerSnapshot | null;
  };
  observations: AgentBenchmarkObservation[];
  summary: {
    measuredRuns: number;
    successfulRuns: number;
    successRate: number;
    medianDurationMs: number;
    medianModelRounds: number;
    medianToolCalls: number;
    calibration: {
      eligibleRounds: number;
      excludedRounds: number;
      medianRequiredCalibrationFactor: number | null;
      p95RequiredCalibrationFactor: number | null;
      maximumRequiredCalibrationFactor: number | null;
      maximumUnderestimateTokens: number | null;
    };
  };
}

export async function runAgentBenchmark(
  config: AgentBenchmarkConfig,
  dependencies: AgentBenchmarkDependencies,
): Promise<AgentBenchmarkReport> {
  validateConfig(config);
  const fixture = AGENT_BENCHMARK_FIXTURES[config.fixtureId];
  if (!fixture) throw new Error(`Unknown agent benchmark fixture: ${config.fixtureId}`);
  if (dependencies.processor.modelId !== config.model) {
    throw new Error(`Benchmark processor model does not match config: ${dependencies.processor.modelId}`);
  }
  if (dependencies.processor.maxOutputTokens !== config.maxOutputTokens) {
    throw new Error("Benchmark processor output limit does not match config");
  }
  if (dependencies.processor.temperature !== config.temperature) {
    throw new Error("Benchmark processor temperature does not match config");
  }
  if (dependencies.processor.seed !== config.seed) {
    throw new Error("Benchmark processor seed does not match config");
  }
  if (fixture.requiredContextCapacity !== undefined
    && dependencies.processor.contextCapacity !== fixture.requiredContextCapacity) {
    throw new Error(`Benchmark fixture requires context capacity ${fixture.requiredContextCapacity}`);
  }
  if (fixture.requiredMaxOutputTokens !== undefined && config.maxOutputTokens !== fixture.requiredMaxOutputTokens) {
    throw new Error(`Benchmark fixture requires output limit ${fixture.requiredMaxOutputTokens}`);
  }
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const beforeModels = await dependencies.processor.listModels();
  const contextBeforeRun = beforeModels.find((model) => model.id === config.model)?.contextWindow ?? null;
  const observations: AgentBenchmarkObservation[] = [];
  const totalRuns = config.warmupRuns + config.measuredRuns;
  const contextPolicy = config.contextPolicy ?? "schema3";
  const harness = createFixtureHarness(dependencies.processor, contextPolicy, dependencies.systemPromptNonce);

  try {
    for (let sequence = 0; sequence < totalRuns; sequence += 1) {
      observations.push(await runFixture(
        harness.server.url,
        harness.workspace,
        harness.databasePath,
        harness.authToken,
        fixture,
        sequence,
        sequence < config.warmupRuns ? "warmup" : "measured",
        config.timeoutMs,
        now,
      ));
    }
  } finally {
    await harness.server.stop(true);
    await harness.app.close();
    rmSync(harness.root, { recursive: true, force: true });
  }

  const afterModels = await dependencies.processor.listModels();
  const contextAfterRun = afterModels.find((model) => model.id === config.model)?.contextWindow ?? null;
  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  const measured = observations.filter((observation) => observation.phase === "measured");
  const successfulRuns = measured.filter((observation) => observation.success).length;
  const measuredRounds = measured.flatMap((observation) => observation.providerRounds);
  const eligibleCalibrationRounds = measured.flatMap((observation) =>
    observation.success ? observation.providerRounds.filter((round) => round.calibration.eligible) : []
  );
  const calibrationFactors = eligibleCalibrationRounds
    .map((round) => round.calibration.requiredCalibrationFactor)
    .filter((value): value is number => value !== null);
  const underestimateTokens = eligibleCalibrationRounds
    .map((round) => round.calibration.estimateErrorTokens)
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, -value));
  return {
    schemaVersion: AGENT_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    machine: {
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      totalMemoryBytes: totalmem(),
      bunVersion: Bun.version,
    },
    runtime: {
      provider: dependencies.processor.providerId,
      model: config.model,
      endpoint: dependencies.endpoint ?? null,
      backendVersion: dependencies.backendVersion ?? null,
      contextBeforeRun,
      contextAfterRun,
      sourceRevision: dependencies.sourceRevision ?? null,
      modelDigest: dependencies.modelDigest ?? null,
      profileStatus: runtimeProfileStatus(dependencies.processor),
    },
    fixture: {
      id: fixture.id,
      prompt: fixture.prompt,
      expectedMarker: fixture.expectedMarker,
      files: fixture.files,
      requiredTools: fixture.requiredTools,
      permissionMode: fixture.permissionMode,
      requiresSuccessfulCommand: fixture.requiresSuccessfulCommand,
      requiresFailingThenSuccessfulCommand: fixture.requiresFailingThenSuccessfulCommand ?? false,
      systemPromptWorkspace: BENCHMARK_SYSTEM_PROMPT_WORKSPACE,
      turns: fixtureTurns(fixture),
      maximumToolCalls: fixture.maximumToolCalls ?? null,
      exactResponse: fixture.exactResponse ?? false,
      requiredContextCapacity: fixture.requiredContextCapacity ?? null,
      requiredMaxOutputTokens: fixture.requiredMaxOutputTokens ?? null,
      requireAllRoundsCalibration: fixture.requireAllRoundsCalibration ?? false,
    },
    config,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      delta: calculateHostMemoryDelta(memoryBefore, memoryAfter),
    },
    power: { before: powerBefore, after: powerAfter },
    observations,
    summary: {
      measuredRuns: measured.length,
      successfulRuns,
      successRate: successfulRuns / measured.length,
      medianDurationMs: median(measured.map((observation) => observation.durationMs)),
      medianModelRounds: median(measured.map((observation) => observation.modelRounds)),
      medianToolCalls: median(measured.map((observation) => observation.toolCalls)),
      calibration: {
        eligibleRounds: eligibleCalibrationRounds.length,
        excludedRounds: measuredRounds.length - eligibleCalibrationRounds.length,
        medianRequiredCalibrationFactor: nullableMedian(calibrationFactors),
        p95RequiredCalibrationFactor: percentile(calibrationFactors, 0.95),
        maximumRequiredCalibrationFactor: calibrationFactors.length > 0 ? Math.max(...calibrationFactors) : null,
        maximumUnderestimateTokens: underestimateTokens.length > 0 ? Math.max(...underestimateTokens) : null,
      },
    },
  };
}

function createFixtureHarness(
  processor: TurnProcessor,
  contextPolicy: NonNullable<AgentBenchmarkConfig["contextPolicy"]>,
  systemPromptNonce?: string,
): {
  root: string;
  workspace: string;
  databasePath: string;
  authToken: string;
  app: ReturnType<typeof createDaemonApp>;
  server: Bun.Server<unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), "demesne-agent-benchmark-"));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  const authToken = "agent-benchmark-token";
  const databasePath = join(data, "demesne.sqlite");
  const app = createDaemonApp({
    databasePath,
    processor,
    authToken,
    systemPrompt: `${systemPromptNonce ? `BENCHMARK_NONCE_${systemPromptNonce}\n` : ""}${defaultSystemPrompt(BENCHMARK_SYSTEM_PROMPT_WORKSPACE)}`,
    contextPlanner: contextPlannerForPolicy(contextPolicy),
  });
  const server = Bun.serve({ port: 0, idleTimeout: 255, fetch: app.fetch });
  return { root, workspace, databasePath, authToken, app, server };
}

const rawContextPlanner: ContextPlanner = planRawContextRequest;

function contextPlannerForPolicy(contextPolicy: NonNullable<AgentBenchmarkConfig["contextPolicy"]>): ContextPlanner {
  if (contextPolicy === "raw") return rawContextPlanner;
  if (contextPolicy === "delayed-hard") return planDelayedHardContextRequest;
  return planContextRequest;
}

async function runFixture(
  serverUrl: URL,
  workspace: string,
  databasePath: string,
  authToken: string,
  fixture: AgentBenchmarkFixtureDefinition,
  sequence: number,
  phase: AgentBenchmarkObservation["phase"],
  timeoutMs: number,
  now: () => number,
): Promise<AgentBenchmarkObservation> {
  prepareFixture(workspace, fixture);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Agent benchmark timed out")), timeoutMs);
  const started = now();

  try {
    const created = await jsonRequest<CreateSessionResponse>(serverUrl, "/v1/sessions", authToken, {
      method: "POST",
      body: JSON.stringify({ title: `Agent benchmark ${sequence}`, workspacePath: workspace }),
    });
    const submittedTurns: SubmitTurnResponse[] = [];
    const events: EventEnvelope[] = [];
    const turnIndexes = new Map<string, number>();
    const turns = fixtureTurns(fixture);
    let workspaceTransitionsValid = true;
    for (const [turnIndex, fixtureTurn] of turns.entries()) {
      workspaceTransitionsValid = applyWorkspaceUpdates(workspace, fixtureTurn.beforeWorkspaceUpdates ?? [])
        && workspaceTransitionsValid;
      const submitted = await jsonRequest<SubmitTurnResponse>(
        serverUrl,
        `/v1/sessions/${created.session.id}/turns`,
        authToken,
        {
          method: "POST",
          body: JSON.stringify({
            content: fixtureTurn.prompt,
            permissionMode: fixture.permissionMode,
            thinkingEnabled: false,
          }),
        },
      );
      submittedTurns.push(submitted);
      turnIndexes.set(submitted.turn.id, turnIndex);
      events.push(...await collectTurnEvents(
        serverUrl,
        created.session.id,
        submitted.eventId,
        authToken,
        controller.signal,
        fixture,
      ));
    }
    const state = await jsonRequest<SessionStateResponse>(
      serverUrl,
      `/v1/sessions/${created.session.id}`,
      authToken,
      { signal: controller.signal },
    );
    const completed = now();
    const completedTurns = submittedTurns.map((submitted) =>
      state.session.turns.find((candidate) => candidate.id === submitted.turn.id)
    );
    const turnResponses = completedTurns.map((turn) => turn?.responseText ?? "");
    const responseText = turnResponses.join("\n\n");
    const toolNames = events
      .filter((event) => event.type === "tool.call_requested")
      .map((event) => typeof event.payload.name === "string" ? event.payload.name : "unknown");
    const expectedMarkerFound = turns.every((fixtureTurn, index) => {
      const response = turnResponses[index] ?? "";
      return (fixtureTurn.exactResponse ?? fixture.exactResponse)
        ? response.trim() === fixtureTurn.expectedMarker
        : response.includes(fixtureTurn.expectedMarker);
    });
    const requiredToolsObserved = fixture.requiredTools.every((name) => toolNames.includes(name))
      && turns.every((fixtureTurn, index) => {
        const turnId = submittedTurns[index]?.turn.id;
        const names = events
          .filter((event) => event.turnId === turnId && event.type === "tool.call_requested")
          .map((event) => typeof event.payload.name === "string" ? event.payload.name : "unknown");
        return (fixtureTurn.requiredTools ?? []).every((name) => names.includes(name));
      });
    const maximumToolCallsObserved = (fixture.maximumToolCalls === undefined || toolNames.length <= fixture.maximumToolCalls)
      && turns.every((fixtureTurn, index) => {
        if (fixtureTurn.maximumToolCalls === undefined) return true;
        const turnId = submittedTurns[index]?.turn.id;
        return events.filter((event) => event.turnId === turnId && event.type === "tool.call_requested").length
          <= fixtureTurn.maximumToolCalls;
      });
    const roundShapes = new Map(turns.map((turn, index) => [index, turn.roundShapes ?? []]));
    const providerRounds = collectProviderRounds(events, turnIndexes, fixture.id, roundShapes);
    const requiredCompactionObserved = turns.every((fixtureTurn, turnIndex) =>
      !fixtureTurn.requireCompaction
      || providerRounds.some((round) => round.turnIndex === turnIndex
        && round.contextPlan?.actions.some((action) => action.kind === "truncate_historical_tool_output"))
    );
    const exactToolCallsObserved = turns.every((fixtureTurn, turnIndex) => {
      const expectedCalls = fixtureTurn.expectedToolCalls;
      if (!expectedCalls) return true;
      const turnId = submittedTurns[turnIndex]?.turn.id;
      const actual = events
        .filter((event) => event.turnId === turnId && event.type === "tool.call_requested")
        .map((event) => ({ name: event.payload.name, arguments: parsedJsonOrNull(event.payload.arguments) }));
      return actual.length === expectedCalls.length
        && actual.every((call, index) => call.name === expectedCalls[index]?.name
          && jsonValuesEqual(call.arguments, expectedCalls[index]!.arguments));
    });
    const exactModelRoundsObserved = turns.every((fixtureTurn, turnIndex) => {
      if (fixtureTurn.exactModelRounds === undefined) return true;
      return providerRounds.filter((round) => round.turnIndex === turnIndex).length === fixtureTurn.exactModelRounds;
    });
    const requiredContextReductionObserved = turns.every((fixtureTurn, turnIndex) =>
      !fixtureTurn.expectedContextReduction
      || contextReductionObserved(
        fixtureTurn.expectedContextReduction,
        turnIndex,
        submittedTurns,
        providerRounds,
        events,
        databasePath,
        created.session.id,
      )
    );
    const providerUsageCalibrationValid = !fixture.requireAllRoundsCalibration
      || (providerRounds.length > 0 && providerRounds.every((round) => round.calibration.eligible));
    const workspaceValid = validateFixtureWorkspace(workspace, fixture);
    const successfulCommandObserved = events.some((event) =>
      event.type === "tool.call_completed" && event.payload.name === "run_command" && event.payload.exitCode === 0
    );
    const requiredCommandSucceeded = (!fixture.requiresSuccessfulCommand || successfulCommandObserved)
      && (!fixture.requiresFailingThenSuccessfulCommand
        || repairToolSequenceObserved(events, fixture.allowedWritePaths));
    const inputTokens = sumKnownOrNull(providerRounds.map((round) => round.inputTokens));
    const outputTokens = sumKnownOrNull(providerRounds.map((round) => round.outputTokens));
    const providerQueueDurationMs = sumKnownOrNull(providerRounds.map((round) => round.queueDurationMs));
    const providerDurationMs = sumKnownOrNull(providerRounds.map((round) => round.durationMs));
    const providerTimeToFirstOutputMs = providerRounds
      .map((round) => round.timeToFirstOutputMs)
      .filter((value): value is number => value !== null);
    const status = completedTurns.every((turn) => turn?.status === "completed")
      ? "completed"
      : completedTurns.find((turn) => turn?.status !== "completed")?.status ?? "missing";
    return {
      sequence,
      phase,
      durationMs: Math.max(0, completed - started),
      status,
      success: status === "completed"
        && expectedMarkerFound
        && requiredToolsObserved
        && maximumToolCallsObserved
        && requiredCompactionObserved
        && exactToolCallsObserved
        && exactModelRoundsObserved
        && workspaceTransitionsValid
        && requiredContextReductionObserved
        && providerUsageCalibrationValid
        && workspaceValid
        && requiredCommandSucceeded,
      expectedMarkerFound,
      requiredToolsObserved,
      maximumToolCallsObserved,
      requiredCompactionObserved,
      exactToolCallsObserved,
      exactModelRoundsObserved,
      workspaceTransitionsValid,
      requiredContextReductionObserved,
      providerUsageCalibrationValid,
      workspaceValid,
      requiredCommandSucceeded,
      modelRounds: events.filter((event) => event.type === "model.request_started").length,
      toolCalls: toolNames.length,
      toolNames,
      inputTokens,
      outputTokens,
      providerQueueDurationMs,
      providerDurationMs,
      providerTimeToFirstOutputMs,
      contextTrimEvents: events.filter((event) => event.type === "model.context_trimmed").length,
      providerRounds,
      turnResponses,
      responseText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function collectTurnEvents(
  baseUrl: URL,
  sessionId: string,
  after: number,
  authToken: string,
  signal: AbortSignal,
  fixture: AgentBenchmarkFixtureDefinition,
): Promise<EventEnvelope[]> {
  const url = new URL("/v1/events", baseUrl);
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("after", String(after));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
    signal,
  });
  const events: EventEnvelope[] = [];
  for await (const event of readServerSentEvents(response)) {
    events.push(event);
    if (event.type === "permission.requested") {
      const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
      if (!permissionId) throw new Error("Agent benchmark received a malformed permission request");
      await jsonRequest(baseUrl, `/v1/permissions/${permissionId}`, authToken, {
        method: "POST",
        body: JSON.stringify({ decision: fixturePermissionDecision(events, event, fixture) }),
        signal,
      });
    }
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) break;
  }
  return events;
}

function fixturePermissionDecision(
  events: EventEnvelope[],
  permissionEvent: EventEnvelope,
  fixture: AgentBenchmarkFixtureDefinition,
): "allow_once" | "deny" {
  const toolCallId = typeof permissionEvent.payload.toolCallId === "string" ? permissionEvent.payload.toolCallId : null;
  if (!toolCallId) return "deny";
  const request = events.findLast((event) =>
    event.type === "tool.call_requested" && event.payload.toolCallId === toolCallId
  );
  if (!request || typeof request.payload.name !== "string" || typeof request.payload.arguments !== "string") return "deny";

  let input: unknown;
  try {
    input = JSON.parse(request.payload.arguments);
  } catch {
    return "deny";
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "deny";
  const value = input as Record<string, unknown>;
  if (request.payload.name === "edit_file") {
    return typeof value.path === "string" && fixture.allowedWritePaths.includes(value.path) ? "allow_once" : "deny";
  }
  if (request.payload.name === "run_command" && Array.isArray(value.argv) && value.argv.every((entry) => typeof entry === "string")) {
    const argv = value.argv as string[];
    return Object.keys(value).length === 1 && fixture.allowedCommands.some((allowed) => arraysEqual(argv, allowed))
      ? "allow_once"
      : "deny";
  }
  return "deny";
}

function prepareFixture(workspace: string, fixture: AgentBenchmarkFixtureDefinition): void {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const file of fixture.files) {
    const absolute = join(workspace, file.path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, file.initialContent, { encoding: "utf8", mode: 0o600 });
  }
}

function validateFixtureWorkspace(workspace: string, fixture: AgentBenchmarkFixtureDefinition): boolean {
  const actualPaths = collectFiles(workspace);
  const expectedPaths = fixture.files.map((file) => file.path).sort();
  if (!arraysEqual(actualPaths, expectedPaths)) return false;
  return fixture.files.every((file) => readFileSync(join(workspace, file.path), "utf8") === file.expectedContent);
}

function applyWorkspaceUpdates(workspace: string, updates: AgentBenchmarkWorkspaceUpdate[]): boolean {
  let valid = true;
  for (const update of updates) {
    const absolute = join(workspace, update.path);
    if (readFileSync(absolute, "utf8") !== update.expectedBeforeContent) valid = false;
    writeFileSync(absolute, update.content, "utf8");
  }
  return valid;
}

function collectFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(root, absolute));
    } else if (entry.isFile() && statSync(absolute).isFile()) {
      files.push(absolute.slice(root.length + 1));
    }
  }
  return files.sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsedJsonOrNull(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return arraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => jsonValuesEqual(left[key], right[key]));
}

function contextReductionObserved(
  expected: AgentBenchmarkExpectedContextReduction,
  turnIndex: number,
  submittedTurns: SubmitTurnResponse[],
  rounds: AgentProviderRound[],
  events: EventEnvelope[],
  databasePath: string,
  sessionId: string,
): boolean {
  const round = rounds.find((candidate) => candidate.turnIndex === turnIndex && candidate.roundIndex === expected.roundIndex);
  const plan = round?.contextPlan;
  const droppedTurnId = submittedTurns[expected.droppedTurnIndex]?.turn.id;
  const retainedTurnId = submittedTurns[expected.retainedTurnIndex]?.turn.id;
  const currentTurnId = submittedTurns[turnIndex]?.turn.id;
  if (!round || !plan || plan.schemaVersion !== 3 || !droppedTurnId || !retainedTurnId || !currentTurnId) return false;
  const actionKinds = plan.actions.map((action) => action.kind);
  if (!arraysEqual(actionKinds, expected.actionKinds)) return false;
  const deduplicatedPaths = plan.actions.flatMap((action) =>
    action.kind === "deduplicate_historical_file_content" ? [action.path] : []
  );
  if (!arraysEqual(deduplicatedPaths, expected.deduplicatedPaths)) return false;
  const deduplications = plan.actions.filter((action) => action.kind === "deduplicate_historical_file_content");
  const olderToolCallId = providerToolCallId(events, submittedTurns[expected.droppedTurnIndex]?.turn.id);
  const retainedToolCallId = providerToolCallId(events, submittedTurns[expected.retainedTurnIndex]?.turn.id);
  if (deduplications.length !== 1 || !olderToolCallId || !retainedToolCallId
    || deduplications[0]?.messageIndex !== expected.deduplicatedMessageIndex
    || deduplications[0].retainedMessageIndex !== expected.retainedMessageIndex
    || deduplications[0].toolCallId !== olderToolCallId
    || deduplications[0].retainedToolCallId !== retainedToolCallId) return false;
  const truncations = plan.actions.filter((action) => action.kind === "truncate_historical_tool_output");
  if (truncations.length !== 1 || truncations[0]?.messageIndex !== expected.truncatedMessageIndex
    || truncations[0].removedLines !== expected.truncatedRemovedLines) return false;
  const drops = plan.actions.filter((action) => action.kind === "drop_historical_turn");
  if (drops.length !== 1 || drops[0]?.turnId !== droppedTurnId
    || drops[0].messageCount !== expected.droppedMessageCount
    || drops[0].messageStartIndex !== expected.droppedMessageStartIndex) return false;
  const maximumInput = plan.maximumPlannedInputTokens;
  if (maximumInput === null || plan.estimatedInputTokens > maximumInput) return false;
  const estimateBeforeDropping = plan.estimatedInputTokens
    + drops.reduce((total, action) => total + action.estimatedTokensSaved, 0);
  if (estimateBeforeDropping <= maximumInput) return false;
  if (expected.requireCalibration && !round.calibration.eligible) return false;
  const firstRetainedMessageId = persistedContextBoundary(databasePath, sessionId, retainedTurnId, droppedTurnId);
  if (firstRetainedMessageId === null) return false;
  return events.some((event) => {
    const droppedTurnIds = event.payload.droppedTurnIds;
    return event.turnId === currentTurnId
      && event.type === "model.context_trimmed"
      && Array.isArray(droppedTurnIds)
      && droppedTurnIds.every((value): value is string => typeof value === "string")
      && arraysEqual(droppedTurnIds, [droppedTurnId])
      && event.payload.firstRetainedMessageId === firstRetainedMessageId;
  });
}

function providerToolCallId(events: EventEnvelope[], turnId: string | undefined): string | null {
  if (!turnId) return null;
  const event = events.find((candidate) => candidate.turnId === turnId && candidate.type === "tool.call_requested");
  return typeof event?.payload.providerToolCallId === "string" ? event.payload.providerToolCallId : null;
}

function persistedContextBoundary(
  databasePath: string,
  sessionId: string,
  retainedTurnId: string,
  droppedTurnId: string,
): number | null {
  const database = new Database(databasePath, { readonly: true });
  try {
    const session = database.query("SELECT context_start_message_id AS id FROM sessions WHERE id = ?")
      .get(sessionId) as { id: number | null } | null;
    if (!session || session.id === null) return null;
    const retained = database.query("SELECT MIN(id) AS id FROM model_messages WHERE turn_id = ?")
      .get(retainedTurnId) as { id: number | null } | null;
    const dropped = database.query("SELECT MAX(id) AS id FROM model_messages WHERE turn_id = ?")
      .get(droppedTurnId) as { id: number | null } | null;
    return retained?.id === session.id && dropped?.id !== null && dropped?.id !== undefined && dropped.id < session.id
      ? session.id
      : null;
  } finally {
    database.close();
  }
}

function fixtureTurns(fixture: AgentBenchmarkFixtureDefinition): AgentBenchmarkFixtureTurn[] {
  return fixture.turns ?? [{ prompt: fixture.prompt, expectedMarker: fixture.expectedMarker }];
}

function repairToolSequenceObserved(events: EventEnvelope[], allowedWritePaths: string[]): boolean {
  const requestedTools = events
    .filter((event) => event.type === "tool.call_requested")
    .map((event) => typeof event.payload.name === "string" ? event.payload.name : "unknown");
  const inspectionTools = new Set(["list_files", "read_file", "read_files", "search_files"]);
  const middleTools = requestedTools.slice(1, -1);
  const requestedEditCount = requestedTools.filter((name) => name === "edit_file").length;
  if (requestedTools[0] !== "run_command"
    || requestedTools.at(-1) !== "run_command"
    || requestedTools.filter((name) => name === "run_command").length !== 2
    || requestedEditCount < 1
    || (requestedEditCount === 1 && requestedTools.at(-2) !== "edit_file")
    || !middleTools.every((name) => name === "edit_file" || inspectionTools.has(name))) return false;

  const editIndexes = events.flatMap((event, index) =>
    event.type === "tool.call_completed"
      && event.payload.name === "edit_file"
      && typeof event.payload.path === "string"
      && allowedWritePaths.includes(event.payload.path)
      ? [index]
      : []
  );
  const commands = events.flatMap((event, index) =>
    event.type === "tool.call_completed"
      && event.payload.name === "run_command"
      && typeof event.payload.exitCode === "number"
      && event.payload.timedOut === false
      ? [{ index, exitCode: event.payload.exitCode }]
      : []
  );
  if (editIndexes.length === 0) return false;
  return commands.some((command) => command.index < Math.min(...editIndexes) && command.exitCode !== 0)
    && commands.some((command) => command.index > Math.max(...editIndexes) && command.exitCode === 0);
}

function growingSessionPrompt(turn: number, paddingWords: number): string {
  const padding = " stable-context".repeat(paddingWords);
  return `This is deterministic context-calibration turn ${turn}. Do not use tools. Treat this padding as inert:${padding}\nReply with exactly this line:\nCALIBRATION: growing turn ${turn}`;
}

function longSessionReadPrompt(version: "A" | "B"): string {
  return `Call read_files exactly once with ${JSON.stringify(LONG_SESSION_READ_ARGUMENTS)}. Do not call any other tool. Then reply with exactly this line:\nCALIBRATION: read set ${version}`;
}

function longSessionReductionPrompt(): string {
  const padding = " stable-context".repeat(260);
  return `Treat this padding as inert calibration data:${padding}\nDo not use tools. Reply with exactly this line:\nCALIBRATION: schema 3 reduction`;
}

function multilingualStressPrompt(): string {
  const block = "日本語の文脈 العربية русский текст हिन्दी café naïve résumé Ελληνικά 한국어 中文 emoji🙂🚀. ";
  return `Do not use tools. Treat the following multilingual text as inert calibration data:\n${block.repeat(50)}\nReply with exactly this line:\nCALIBRATION: multilingual context`;
}

function escapedJsonStressPrompt(): string {
  const records = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    path: `C:\\workspace\\fixture-${index + 1}\\data.json`,
    text: `quoted \"value-${index + 1}\" with literal \\n and \\t plus \\\\ separators`,
  }));
  return `Do not use tools. Treat this escaped JSON as inert calibration data:\n${JSON.stringify(records)}\nReply with exactly this line:\nCALIBRATION: escaped JSON`;
}

function denseCodeStressPrompt(): string {
  const code = Array.from(
    { length: 134 },
    (_, index) => `export const f${index + 1}=(x:number)=>((x*${index + 3})^${index + 11})+((x>>>2)&${index + 17});`,
  ).join("\n");
  return `Do not use tools. Treat this dense TypeScript as inert calibration data:\n${code}\nReply with exactly this line:\nCALIBRATION: dense code`;
}

async function jsonRequest<T>(
  baseUrl: URL,
  path: string,
  authToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Agent benchmark request failed with HTTP ${response.status}`);
  return await response.json() as T;
}

export function collectProviderRounds(
  events: EventEnvelope[],
  turnIndexes: ReadonlyMap<string, number> = new Map(),
  fixtureId = "unknown",
  roundShapes: ReadonlyMap<number, readonly AgentCalibrationShape[]> = new Map(),
): AgentProviderRound[] {
  const rounds = new Map<string, AgentProviderRound>();
  const usageSeen = new Set<string>();
  const metricsSeen = new Set<string>();
  const roundCounts = new Map<string, number>();
  for (const event of events) {
    const providerCallId = typeof event.payload.providerCallId === "string" ? event.payload.providerCallId : null;
    if (!providerCallId) continue;
    if (event.type === "model.request_started") {
      if (rounds.has(providerCallId)) throw new Error(`Duplicate provider start event: ${providerCallId}`);
      if (!event.turnId) throw new Error(`Provider start event has no turn: ${providerCallId}`);
      const roundIndex = roundCounts.get(event.turnId) ?? 0;
      roundCounts.set(event.turnId, roundIndex + 1);
      const turnIndex = turnIndexes.get(event.turnId) ?? 0;
      rounds.set(providerCallId, {
        providerCallId,
        turnId: event.turnId,
        turnIndex,
        roundIndex,
        shape: calibrationShape(fixtureId, turnIndex, roundIndex, roundShapes),
        contextPlan: contextPlanOrNull(event.payload.contextPlan),
        usage: null,
        outcome: null,
        queueDurationMs: null,
        durationMs: null,
        timeToFirstOutputMs: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        calibration: emptyCalibration("provider call did not complete"),
      });
      continue;
    }
    const round = rounds.get(providerCallId);
    if (!round) {
      if ([
        "model.usage",
        "model.metrics",
        "model.request_completed",
        "model.request_failed",
        "model.request_cancelled",
        "model.request_interrupted",
      ].includes(event.type)) {
        throw new Error(`Provider event has no matching start: ${providerCallId}`);
      }
      continue;
    }
    if (event.type === "model.usage") {
      if (usageSeen.has(providerCallId)) throw new Error(`Duplicate provider usage event: ${providerCallId}`);
      usageSeen.add(providerCallId);
      const inputTokens = nonnegativeSafeIntegerOrNull(event.payload.inputTokens);
      const outputTokens = nonnegativeSafeIntegerOrNull(event.payload.outputTokens);
      const totalTokens = nonnegativeSafeIntegerOrNull(event.payload.totalTokens);
      const cachedInputTokens = nonnegativeSafeIntegerOrNull(event.payload.cachedInputTokens);
      round.inputTokens = inputTokens;
      round.outputTokens = outputTokens;
      round.totalTokens = totalTokens;
      round.usage = {
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
      };
    }
    if (event.type === "model.metrics") {
      if (metricsSeen.has(providerCallId)) throw new Error(`Duplicate provider metrics event: ${providerCallId}`);
      metricsSeen.add(providerCallId);
      round.queueDurationMs = numericOrNull(event.payload.queueDurationMs);
      round.durationMs = numericOrNull(event.payload.durationMs);
      round.timeToFirstOutputMs = numericOrNull(event.payload.timeToFirstTokenMs);
    }
    if (event.type === "model.request_completed") round.outcome = "completed";
    if (event.type === "model.request_failed") round.outcome = "failed";
    if (event.type === "model.request_cancelled") round.outcome = "cancelled";
    if (event.type === "model.request_interrupted") round.outcome = "interrupted";
  }
  return [...rounds.values()].map((round) => ({ ...round, calibration: calibrationForRound(round) }));
}

function contextPlanOrNull(value: unknown): ContextPlan | null {
  if (!isRecord(value) || ![1, 2, 3].includes(value.schemaVersion as number) || !isRecord(value.estimator)) return null;
  if (value.estimator.method !== "openai-json-utf8-bytes-divisor-3" || ![1, 2].includes(value.estimator.version as number)) return null;
  if ((value.schemaVersion === 1) !== (value.estimator.version === 1)) return null;
  if (value.estimator.version === 2 && value.estimator.safetyFactor !== 1.2) return null;
  if (!isRecord(value.reserves) || !Array.isArray(value.actions)) return null;
  if (!positiveSafeInteger(value.originalEstimatedInputTokens) || !positiveSafeInteger(value.estimatedInputTokens)) return null;
  if (!nonnegativeSafeInteger(value.estimatedMessageTokens) || !nonnegativeSafeInteger(value.estimatedToolDefinitionTokens)) return null;
  if (!nullableNonnegativeSafeInteger(value.capacityTokens)
    || !nullableNonnegativeSafeInteger(value.maximumPlannedInputTokens)
    || !nullableNonnegativeSafeInteger(value.hardInputLimitTokens)
    || !nullableNonnegativeSafeInteger(value.reserves.outputTokens)
    || !nonnegativeSafeInteger(value.reserves.toolResultTokens)
    || !nonnegativeSafeInteger(value.reserves.safetyTokens)
    || !nullableNonnegativeSafeInteger(value.reserves.totalTokens)) return null;
  if (!["capacity_unknown", "within_soft_limit", "over_soft_limit", "over_hard_limit", "over_capacity"].includes(
    typeof value.budgetStatus === "string" ? value.budgetStatus : "",
  )) return null;
  if (!value.actions.every(contextActionIsValid)) return null;
  if (value.schemaVersion !== 3 && value.actions.some((action) => isRecord(action)
    && action.kind !== "truncate_historical_tool_output")) return null;
  const estimatedSavings = value.actions.reduce(
    (total, action) => total + (isRecord(action) && typeof action.estimatedTokensSaved === "number"
      ? action.estimatedTokensSaved
      : 0),
    0,
  );
  const originalEstimatedInputTokens = value.originalEstimatedInputTokens as number;
  const estimatedInputTokens = value.estimatedInputTokens as number;
  const estimatedMessageTokens = value.estimatedMessageTokens as number;
  const estimatedToolDefinitionTokens = value.estimatedToolDefinitionTokens as number;
  const capacityTokens = value.capacityTokens as number | null;
  const outputTokens = value.reserves.outputTokens as number | null;
  const toolResultTokens = value.reserves.toolResultTokens as number;
  const safetyTokens = value.reserves.safetyTokens as number;
  const totalTokens = value.reserves.totalTokens as number | null;
  const expectedTotalTokens = outputTokens === null ? null : outputTokens + toolResultTokens + safetyTokens;
  const expectedMaximumInput = capacityTokens === null || expectedTotalTokens === null
    ? null
    : Math.max(0, capacityTokens - expectedTotalTokens);
  const expectedHardInput = capacityTokens === null || outputTokens === null
    ? null
    : Math.max(0, capacityTokens - outputTokens);
  if (originalEstimatedInputTokens - estimatedInputTokens !== estimatedSavings) return null;
  if (estimatedInputTokens !== estimatedMessageTokens + estimatedToolDefinitionTokens) return null;
  if (totalTokens !== expectedTotalTokens
    || value.maximumPlannedInputTokens !== expectedMaximumInput
    || value.hardInputLimitTokens !== expectedHardInput) return null;
  if (value.budgetStatus !== expectedBudgetStatus(
    estimatedInputTokens,
    capacityTokens,
    expectedMaximumInput,
    expectedHardInput,
  )) return null;
  return value as unknown as ContextPlan;
}

function contextActionIsValid(action: unknown): boolean {
  if (!isRecord(action) || !positiveSafeInteger(action.estimatedTokensSaved)) return false;
  if (action.kind === "truncate_historical_tool_output") {
    return nonnegativeSafeInteger(action.messageIndex)
      && nonnegativeSafeInteger(action.originalCharacters)
      && nonnegativeSafeInteger(action.compactedCharacters)
      && positiveSafeInteger(action.removedLines);
  }
  if (action.kind === "deduplicate_historical_file_content") {
    return nonnegativeSafeInteger(action.messageIndex)
      && nonnegativeSafeInteger(action.retainedMessageIndex)
      && typeof action.toolCallId === "string"
      && typeof action.retainedToolCallId === "string"
      && typeof action.path === "string"
      && nonnegativeSafeInteger(action.originalCharacters)
      && nonnegativeSafeInteger(action.compactedCharacters);
  }
  if (action.kind === "drop_historical_turn") {
    return typeof action.turnId === "string"
      && nonnegativeSafeInteger(action.messageStartIndex)
      && positiveSafeInteger(action.messageCount);
  }
  return false;
}

function expectedBudgetStatus(
  estimatedInputTokens: number,
  capacityTokens: number | null,
  maximumPlannedInputTokens: number | null,
  hardInputLimitTokens: number | null,
): ContextPlan["budgetStatus"] {
  if (capacityTokens === null || maximumPlannedInputTokens === null || hardInputLimitTokens === null) {
    return "capacity_unknown";
  }
  if (estimatedInputTokens <= maximumPlannedInputTokens) return "within_soft_limit";
  if (estimatedInputTokens <= hardInputLimitTokens) return "over_soft_limit";
  if (estimatedInputTokens <= capacityTokens) return "over_hard_limit";
  return "over_capacity";
}

function calibrationForRound(round: AgentProviderRound): AgentProviderRound["calibration"] {
  if (round.outcome !== "completed") return emptyCalibration("provider call did not complete");
  if (!round.contextPlan) return emptyCalibration("context plan is missing or invalid");
  const actual = round.usage?.inputTokens;
  if (actual === null || actual === undefined) return emptyCalibration("provider input usage is missing or invalid");
  if (actual <= 0) return emptyCalibration("provider input usage is zero");
  const estimated = round.contextPlan.estimatedInputTokens;
  return {
    eligible: true,
    exclusionReason: null,
    estimateErrorTokens: estimated - actual,
    estimateToActualRatio: estimated / actual,
    requiredCalibrationFactor: actual / estimated,
  };
}

function emptyCalibration(exclusionReason: string): AgentProviderRound["calibration"] {
  return {
    eligible: false,
    exclusionReason,
    estimateErrorTokens: null,
    estimateToActualRatio: null,
    requiredCalibrationFactor: null,
  };
}

function calibrationShape(
  fixtureId: string,
  turnIndex: number,
  roundIndex: number,
  roundShapes: ReadonlyMap<number, readonly AgentCalibrationShape[]>,
): AgentCalibrationShape {
  const declared = roundShapes.get(turnIndex)?.[roundIndex];
  if (declared) return declared;
  if (fixtureId === "direct-answer-calibration-v1") return "direct";
  if (fixtureId === "growing-session-calibration-v1") return "growing_session";
  if (fixtureId === "multilingual-context-calibration-v1") return "multilingual";
  if (fixtureId === "escaped-json-calibration-v1") return "escaped_json";
  if (fixtureId === "dense-code-calibration-v1") return "dense_code";
  if (fixtureId === "historical-tool-output-calibration-v1" && turnIndex > 0) return "historical_compaction";
  if (fixtureId === "failed-test-arithmetic-repair-v1") return "repair";
  return roundIndex === 0 ? "tool_selection" : "tool_follow_up";
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeSafeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableNonnegativeSafeInteger(value: unknown): boolean {
  return value === null || nonnegativeSafeInteger(value);
}

function sumKnownOrNull(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function validateConfig(config: AgentBenchmarkConfig): void {
  if (!config.fixtureId.trim()) throw new Error("Benchmark fixture ID cannot be empty");
  if (!config.model.trim()) throw new Error("Benchmark model cannot be empty");
  boundedInteger(config.warmupRuns, "warmupRuns", 0, 5);
  boundedInteger(config.measuredRuns, "measuredRuns", 1, 10);
  boundedInteger(config.timeoutMs, "timeoutMs", 1_000, 30 * 60_000);
  boundedInteger(config.maxOutputTokens, "maxOutputTokens", 1, 4_096);
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (!Number.isSafeInteger(config.seed)) throw new Error("seed must be a safe integer");
  if (config.contextPolicy !== undefined && !["schema3", "raw", "delayed-hard"].includes(config.contextPolicy)) {
    throw new Error("contextPolicy is invalid");
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function nullableMedian(values: number[]): number | null {
  return values.length > 0 ? median(values) : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}

function runtimeProfileStatus(processor: TurnProcessor): RuntimeProfileStatus {
  return processor.runtimeStatus?.() ?? {
    profile: null,
    state: "unconfigured",
    expected: null,
    observed: null,
    mismatches: [],
    observedAt: null,
  };
}

async function backendVersion(baseUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/api/version", baseUrl), { redirect: "manual" });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

async function modelDigest(baseUrl: string, model: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), { redirect: "manual" });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
    for (const candidate of value.models) {
      if (!isRecord(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name : candidate.model;
      if (name === model && typeof candidate.digest === "string") return candidate.digest;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const model = process.env.DEMESNE_MODEL?.trim();
  if (!model) throw new Error("DEMESNE_MODEL is required for an agent benchmark");
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11434/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "ollama";
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 1_536);
  const configuredContextCapacity = optionalEnvironmentInteger("DEMESNE_CONTEXT_WINDOW");
  const runtimeProfile = process.env.DEMESNE_RUNTIME_PROFILE?.trim();
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
    providerId,
    includeUsage: true,
    reasoningEffort: "none",
    contextWindow: configuredContextCapacity,
  });
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  const processor = new ProviderTurnProcessor(provider, model, {
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, verifier, configuredContextCapacity);
  const report = await runAgentBenchmark({
    fixtureId: process.env.DEMESNE_BENCHMARK_FIXTURE?.trim() || "read-only-arithmetic-diagnosis-v1",
    model,
    warmupRuns: environmentInteger("DEMESNE_BENCHMARK_WARMUPS", 0),
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 1),
    timeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, {
    processor,
    endpoint: baseUrl,
    backendVersion: await backendVersion(baseUrl),
    modelDigest: await modelDigest(baseUrl, model),
    sourceRevision: process.env.DEMESNE_SOURCE_REVISION,
  });

  const dataDirectory = process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne");
  const benchmarkDirectory = join(dataDirectory, "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const timestamp = report.startedAt.replaceAll(":", "-");
  const outputPath = join(benchmarkDirectory, `agent-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.log(`Agent benchmark: ${report.fixture.id}`);
  console.log(`Successful runs: ${report.summary.successfulRuns}/${report.summary.measuredRuns}`);
  console.log(`Median task duration: ${(report.summary.medianDurationMs / 1_000).toFixed(2)}s`);
  console.log(`Median model rounds: ${report.summary.medianModelRounds}`);
  console.log(`Median tool calls: ${report.summary.medianToolCalls}`);
  console.log(`Eligible calibration rounds: ${report.summary.calibration.eligibleRounds}`);
  console.log(`Maximum required calibration factor: ${report.summary.calibration.maximumRequiredCalibrationFactor?.toFixed(4) ?? "unknown"}`);
  console.log(`Raw report: ${outputPath}`);
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function optionalEnvironmentInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
