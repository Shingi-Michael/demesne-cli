import { expect, test } from "bun:test";
import { applyProofEvents, proofCounts, type ProofClaim } from "../src/index.ts";

const claims: ProofClaim[] = [
  { id: "a", text: "All tests pass", state: "proved", toolCallId: "t2", quote: "1198 pass" },
  { id: "b", text: "Nothing else calls it", state: "unchecked" },
];

test("the pass sets the claims and each later event changes one; null clears a field", () => {
  const out = applyProofEvents([
    { type: "turn.proofs", payload: { claims } },
    { type: "turn.proof", payload: { claimId: "b", state: "checking", step: "rg projectFor" } },
    { type: "turn.proof", payload: { claimId: "b", state: "false", why: "Two more callers.", quote: "away.ts:12", words: "Two other files call it" } },
    { type: "turn.proof", payload: { claimId: "b", state: "proved", why: null } },
    { type: "turn.proof", payload: { claimId: "missing", state: "dropped" } },
    { type: "other", payload: {} },
  ]);
  expect(out).toEqual([
    claims[0]!,
    { id: "b", text: "Nothing else calls it", state: "proved", step: "rg projectFor", quote: "away.ts:12", words: "Two other files call it" },
  ]);
  // The input claims are not changed in place.
  expect(claims[1]!.state).toBe("unchecked");
});

test("counts leave dropped claims out", () => {
  expect(proofCounts([...claims, { id: "c", text: "x", state: "dropped" }, { id: "d", text: "y", state: "false" }, { id: "e", text: "z", state: "checking" }]))
    .toEqual({ total: 4, proved: 1, unchecked: 1, wrong: 1, checking: 1 });
  expect(applyProofEvents([])).toEqual([]);
});
