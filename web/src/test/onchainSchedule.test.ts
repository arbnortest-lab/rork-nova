/**
 * Scheduling, retry and badge states for the on-chain add-on.
 */

import { describe, expect, it } from "vitest";

import type { ScanOutcome } from "@/lib/onchain/client";
import {
  applyOutcome,
  badgeOf,
  currentRead,
  dueAt,
  FINAL_AFTER_MS,
  isTestAlert,
  MAX_ATTEMPTS,
  MAX_POLLS,
  newJob,
  nextWake,
  phaseFor,
  pickDue,
  POLL_DELAY_MS,
  rescanJob,
  RETRY_DELAYS_MS,
  unavailableRead,
  type OnChainJob,
} from "@/lib/onchain/schedule";
import type { OnChainRead } from "@/lib/onchain/types";

const T0 = 1_800_000_000_000;

function job(at = T0, now = T0): OnChainJob {
  return newJob({ id: "a1", symbol: "MOVRUSDT", side: "short", at, source: "alert" }, now);
}

function okRead(phase: "early" | "final", patch: Partial<OnChainRead> = {}): OnChainRead {
  return {
    version: 1,
    symbol: "MOVRUSDT",
    side: "short",
    at: T0,
    phase,
    window: { from: T0 - 900_000, to: T0 + 120_000 },
    state: "ok",
    verdict: "distribution",
    qualifier: "spot",
    confidence: "medium",
    alignment: "confirms",
    inflowUsd: 300_000,
    outflowUsd: 0,
    netUsd: -300_000,
    clusters: [],
    stats: { transfers: 4, kept: 2, small: 1, outliers: 0, internal: 1, ignored: 0, truncated: false },
    summary: "Distribution · $300k in (2 clusters) vs $0 out (0 clusters) · net −$300k",
    scannedAt: T0 + 1_000,
    durationMs: 900,
    credits: 8,
    ...patch,
  };
}

const read = (r: OnChainRead): ScanOutcome => ({ kind: "read", read: r });

describe("phase and timing", () => {
  it("runs an early scan at the signal and the final one five minutes later", () => {
    expect(phaseFor({ at: T0 }, T0)).toBe("early");
    expect(phaseFor({ at: T0 }, T0 + FINAL_AFTER_MS - 1)).toBe("early");
    expect(phaseFor({ at: T0 }, T0 + FINAL_AFTER_MS)).toBe("final");
    expect(FINAL_AFTER_MS).toBe(5 * 60_000);
  });

  it("a fresh job is due immediately", () => {
    const j = job();
    expect(dueAt(j, T0)).toBe(T0);
    expect(pickDue([j], T0)).toBe(j);
  });

  it("after the early read it sleeps until the final slot", () => {
    const j = applyOutcome(job(), "early", read(okRead("early")), T0 + 1_000);
    expect(j.early?.phase).toBe("early");
    expect(j.done).toBe(false);
    expect(dueAt(j, T0 + 2_000)).toBe(T0 + FINAL_AFTER_MS);
    expect(pickDue([j], T0 + 2_000)).toBeUndefined();
    expect(nextWake([j], T0 + 2_000)).toBe(T0 + FINAL_AFTER_MS);
    expect(pickDue([j], T0 + FINAL_AFTER_MS)).toBe(j);
  });

  it("the final read completes the job", () => {
    let j = applyOutcome(job(), "early", read(okRead("early")), T0 + 1_000);
    j = applyOutcome(j, "final", read(okRead("final")), T0 + FINAL_AFTER_MS + 1_000);
    expect(j.done).toBe(true);
    expect(j.final?.phase).toBe("final");
    expect(dueAt(j, T0 + FINAL_AFTER_MS + 2_000)).toBe(Number.POSITIVE_INFINITY);
    expect(nextWake([j], T0)).toBeUndefined();
  });

  it("picks the earliest due job, newest signal on ties", () => {
    const older = newJob({ id: "o", symbol: "A", side: "short", at: T0 - 60_000, source: "alert" }, T0);
    const newer = newJob({ id: "n", symbol: "B", side: "short", at: T0, source: "alert" }, T0);
    expect(pickDue([older, newer], T0)?.id).toBe("n");
    const later = { ...older, nextAt: T0 + 10 };
    expect(pickDue([later, newer], T0 + 20)?.id).toBe("n");
  });
});

describe("retries", () => {
  it("backs off on retryable failures and gives up after the last delay", () => {
    let j = job();
    let now = T0;
    for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
      j = applyOutcome(j, "early", { kind: "failed", reason: "timeout", message: "slow", retryable: true }, now);
      expect(j.attempts).toBe(i + 1);
      expect(j.nextAt).toBe(now + RETRY_DELAYS_MS[i]);
      expect(j.done).toBe(false);
      now = j.nextAt;
    }
    j = applyOutcome(j, "early", { kind: "failed", reason: "timeout", message: "slow", retryable: true }, now);
    expect(j.attempts).toBe(0);
    expect(j.early?.state).toBe("unavailable");
    expect(j.done).toBe(false);
    expect(dueAt(j, now)).toBe(T0 + FINAL_AFTER_MS);
    expect(MAX_ATTEMPTS).toBe(RETRY_DELAYS_MS.length + 1);
  });

  it("stops at once on a failure no retry can fix", () => {
    const r = unavailableRead(job(), "early", "token-unmapped", "no token", false, T0);
    const j = applyOutcome(job(), "early", read(r), T0);
    expect(j.done).toBe(true);
    expect(j.early?.reason).toBe("token-unmapped");
    expect(badgeOf(j, T0)).toMatchObject({ state: "unavailable", label: "On-Chain: Unavailable" });
  });

  it("polls a queued scan and treats a stuck queue as a retryable failure", () => {
    let j = job();
    for (let i = 1; i < MAX_POLLS; i += 1) {
      j = applyOutcome(j, "early", { kind: "pending", position: 2, queue: 3 }, T0 + i);
      expect(j.polls).toBe(i);
      expect(j.nextAt).toBe(T0 + i + POLL_DELAY_MS);
    }
    j = applyOutcome(j, "early", { kind: "pending", position: 1, queue: 1 }, T0 + 100);
    expect(j.polls).toBe(0);
    expect(j.attempts).toBe(1);
    expect(j.lastError).toMatch(/queued/);
  });

  it("a final read that fails retryably keeps the early verdict on the badge", () => {
    let j = applyOutcome(job(), "early", read(okRead("early")), T0 + 1_000);
    const t = T0 + FINAL_AFTER_MS + 1_000;
    j = applyOutcome(j, "final", { kind: "failed", reason: "network", message: "down", retryable: true }, t);
    const view = badgeOf(j, t + 1);
    expect(view.state).toBe("resolved");
    expect(view.early).toBe(true);
    expect(view.hint).toContain("final read retry 1");
  });

  it("rescan clears the final read and forces the backend cache", () => {
    let j = applyOutcome(job(), "final", read(okRead("final")), T0 + FINAL_AFTER_MS);
    j = rescanJob(j, T0 + 600_000);
    expect(j.done).toBe(false);
    expect(j.final).toBeUndefined();
    expect(j.force).toBe(true);
    expect(pickDue([j], T0 + 600_000)).toBe(j);
    j = applyOutcome(j, "final", read(okRead("final")), T0 + 601_000);
    expect(j.force).toBeUndefined();
    expect(j.done).toBe(true);
  });
});

describe("badge", () => {
  it("is hidden without a job", () => {
    expect(badgeOf(undefined, T0).state).toBe("idle");
  });

  it("shows Scanning while the first read is out", () => {
    expect(badgeOf(job(), T0)).toMatchObject({ state: "scanning", label: "On-Chain: Scanning…", tone: "brand" });
  });

  it("names the verdict and the qualifier", () => {
    const j = applyOutcome(job(), "final", read(okRead("final", { qualifier: "smart-money", confidence: "high" })), T0);
    const v = badgeOf(j, T0);
    expect(v.label).toBe("On-Chain: Distribution (Smart Money)");
    expect(v.tone).toBe("neg");
    expect(v.hint).toContain("confirms the short");
    expect(v.hint).toContain("confidence high");
  });

  it("marks an early verdict as early and drops the mark once final", () => {
    let j = applyOutcome(job(), "early", read(okRead("early", { verdict: "accumulation", qualifier: "spot", alignment: "contradicts" })), T0);
    expect(badgeOf(j, T0)).toMatchObject({ label: "On-Chain: Accumulation (Spot) · early", tone: "pos", early: true });
    j = applyOutcome(j, "final", read(okRead("final", { verdict: "accumulation", qualifier: "spot" })), T0 + FINAL_AFTER_MS);
    expect(badgeOf(j, T0 + FINAL_AFTER_MS)).toMatchObject({ label: "On-Chain: Accumulation (Spot)", early: false });
  });

  it("greys out flat and mixed results", () => {
    const flat = applyOutcome(job(), "final", read(okRead("final", { verdict: "none", qualifier: "none", alignment: "neutral" })), T0);
    expect(badgeOf(flat, T0)).toMatchObject({ state: "flat", label: "On-Chain: No flow", tone: "muted" });
    const mixed = applyOutcome(job(), "final", read(okRead("final", { verdict: "mixed", qualifier: "none", alignment: "neutral" })), T0);
    expect(badgeOf(mixed, T0)).toMatchObject({ state: "flat", label: "On-Chain: Mixed", tone: "warn" });
  });

  it("prefers a successful read over a failed one", () => {
    const j: OnChainJob = {
      ...job(),
      early: okRead("early"),
      final: unavailableRead(job(), "final", "rate-limited", "429", true, T0),
      done: true,
    };
    expect(currentRead(j)?.phase).toBe("early");
    expect(badgeOf(j, T0).hint).toContain("final read failed: Rate limited");
  });
});

describe("isTestAlert", () => {
  it("recognises the engine's delivery check", () => {
    expect(isTestAlert({ reasons: ["Test alert — delivery path check, not a live signal"] })).toBe(true);
    expect(isTestAlert({ reasons: ["Price pinned the 24h high"] })).toBe(false);
  });
});
