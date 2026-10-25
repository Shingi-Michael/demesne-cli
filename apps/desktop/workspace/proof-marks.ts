import type { ProofClaim } from "@demesne/protocol";
import { proofCounts } from "@demesne/protocol";

/// Proof marks in the window: where a claim's words are in the rendered
/// answer, and what unfolds under its paragraph. The daemon pairs claims
/// with steps; this only draws them.

/// A rendered answer, as the text of its nodes in order, with each claim's
/// words looked up tolerantly: code ticks and emphasis marks are gone once
/// rendered, and whitespace wraps.
export interface Found { segment: number; start: number; end: number }

const DROP = /[`*_~]/g;

/// Where a claim's words lie across the text segments: one range per
/// segment touched, in order, or null when they are not there.
export function locate(segments: readonly string[], text: string): Found[] | null {
  const needle = text.replace(DROP, "").replace(/\s+/g, " ").trim();
  if (!needle) return null;
  // Build the flattened text, remembering where each kept character came from.
  let flat = "";
  const from: Array<{ segment: number; offset: number }> = [];
  let lastSpace = true;
  segments.forEach((segment, index) => {
    for (let offset = 0; offset < segment.length; offset++) {
      const char = segment[offset]!;
      if (/\s/.test(char)) {
        if (lastSpace) continue;
        flat += " "; from.push({ segment: index, offset }); lastSpace = true;
        continue;
      }
      if (DROP.test(char)) { DROP.lastIndex = 0; continue; }
      DROP.lastIndex = 0;
      flat += char; from.push({ segment: index, offset }); lastSpace = false;
    }
  });
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const out: Found[] = [];
  for (let i = at; i < at + needle.length; i++) {
    const { segment, offset } = from[i]!;
    const last = out.at(-1);
    if (last && last.segment === segment) last.end = offset + 1;
    else out.push({ segment, start: offset, end: offset + 1 });
  }
  return out;
}

/// The step's words for the mark's tooltip: "Ran bun test · step 4".
export function claimTitle(claim: ProofClaim, step: { words: string; number: number } | null): string {
  if (claim.state === "proved") return step ? `${step.words} · step ${step.number}` : claim.step ? `Checked · ${claim.step}` : "Proved";
  if (claim.state === "unchecked") return "Nothing in this turn checked this";
  if (claim.state === "checking") return `Checking${claim.step ? ` · ${claim.step}` : "…"}`;
  if (claim.state === "false") return `Not true${claim.why ? `: ${claim.why}` : ""}`;
  return "Dropped from the answer";
}

/// The count line under an answer: "3 proved · 1 not checked".
export function proofLine(claims: readonly ProofClaim[]): { proved: string; unchecked: string; wrong: string; checking: string } | null {
  const counts = proofCounts(claims);
  if (!counts.total) return null;
  const all = counts.proved === counts.total;
  return {
    proved: counts.proved ? (all ? `All ${counts.total} proved` : `${counts.proved} proved`) : "",
    unchecked: counts.unchecked ? `${counts.unchecked} not checked` : "",
    wrong: counts.wrong ? `${counts.wrong} not true` : "",
    checking: counts.checking ? `checking ${counts.checking}` : "",
  };
}

/// What the turn did look at, for a claim nothing checked: "It read and
/// edited sidebar.ts and ran bun test."
export function lookedAt(steps: ReadonlyArray<{ words: string }>): string {
  const seen = [...new Set(steps.map((step) => `${step.words.charAt(0).toLowerCase()}${step.words.slice(1)}`))].slice(0, 4);
  if (!seen.length) return "";
  return `This turn only ${seen.length > 1 ? `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}` : seen[0]!}.`;
}
