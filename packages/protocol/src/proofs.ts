import type { ProofClaim } from "./index.ts";

/// The proof marks of a turn as its events leave them: `turn.proofs` sets
/// the pass's claims, each `turn.proof` changes one (a null field clears it).
export function applyProofEvents(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): ProofClaim[] {
  let claims: ProofClaim[] = [];
  for (const event of events) {
    if (event.type === "turn.proofs" && Array.isArray(event.payload.claims)) claims = (event.payload.claims as ProofClaim[]).map((claim) => ({ ...claim }));
    if (event.type === "turn.proof" && typeof event.payload.claimId === "string") {
      const { claimId, ...patch } = event.payload;
      const index = claims.findIndex((claim) => claim.id === claimId);
      if (index < 0) continue;
      const next = { ...claims[index]! } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      claims[index] = next as unknown as ProofClaim;
    }
  }
  return claims;
}

/// What the count line says: proved, not checked, not true, checking.
export function proofCounts(claims: readonly ProofClaim[]) {
  const live = claims.filter((claim) => claim.state !== "dropped");
  return {
    total: live.length,
    proved: live.filter((claim) => claim.state === "proved").length,
    unchecked: live.filter((claim) => claim.state === "unchecked").length,
    wrong: live.filter((claim) => claim.state === "false").length,
    checking: live.filter((claim) => claim.state === "checking").length,
  };
}
