import { describe, expect, test } from "bun:test";
import { classifyTurnPhase } from "../src/turn-activity.ts";

describe("TurnActivityLedger", () => {

  test("classifies repository checks after a change as verification", () => {
    expect(classifyTurnPhase("git_diff", {}, true)).toBe("verify");
    expect(classifyTurnPhase("git_diff", {}, false)).toBe("inspect");
    expect(classifyTurnPhase("write_file")).toBe("change");
    expect(classifyTurnPhase("search_files")).toBe("inspect");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "test:unit"] })).toBe("verify");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "lint_fix"] })).toBe("verify");
    expect(classifyTurnPhase("run_command", { argv: ["bun", "run", "build-cli"] })).toBe("verify");
  });
});
