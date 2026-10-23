import type { ExhaustionRead } from "./types";

/**
 * True once an alerted setup has genuinely fallen apart, which re-arms its
 * alert.
 *
 * Two gates must fail, and only measured failures count. A gate without live
 * history is unmeasured, which says nothing about the market: counting it as
 * failed would let a contract that briefly left the watch list, or whose
 * refreshes failed for a while, re-arm and alert twice on one setup.
 *
 * With every gate measured this is exactly the original rule, "two or fewer
 * gates passed".
 */
export function setupFellApart(read: Pick<ExhaustionRead, "gates">): boolean {
  return read.gates.filter((g) => g.measured && !g.passed).length >= 2;
}
