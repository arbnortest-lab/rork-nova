/**
 * Scheduling model for the on-chain add-on.
 *
 * Pure functions over a `OnChainJob` record, so every transition is unit
 * tested without a browser. The provider only decides *when* to call these.
 *
 * Lifecycle of one signal fired at time T:
 *
 *   T          early scan   window [T-15m, T+2m] queried now — the tail of
 *                           the window has not happened yet, so the result
 *                           is marked early and shown with that caveat
 *   T+5m       final scan   the full window, after a 3-minute allowance for
 *                           Arkham to index the last blocks
 *
 * Failures that can clear up (rate limits, timeouts, backend restarts) retry
 * with growing delays; failures that cannot (missing key, unknown token,
 * chain not indexed) stop immediately so no credits are wasted.
 */

import type { OnChainPhase, OnChainRead, OnChainReason, SignalSide } from "./types";
import type { ScanOutcome } from "./client";

export const WINDOW_BEFORE_MS = 15 * 60_000;
export const WINDOW_AFTER_MS = 2 * 60_000;
/** Time given to Arkham to index the last blocks of the window. */
export const INDEX_LAG_MS = 3 * 60_000;
/** The final scan runs this long after the signal. */
export const FINAL_AFTER_MS = WINDOW_AFTER_MS + INDEX_LAG_MS;
export const RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 300_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A queued scan is re-polled this often, this many times, before it counts as a failure. */
export const POLL_DELAY_MS = 8_000;
export const MAX_POLLS = 8;
/** Signals older than this are never scanned: the backend refuses them too. */
export const MAX_SIGNAL_AGE_MS = 7 * 24 * 60 * 60_000;

export type JobSource = "alert" | "manual";

export interface OnChainJob {
  /** Alert id, or `manual:<symbol>:<at>` for a scan the trader asked for. */
  id: string;
  symbol: string;
  side: SignalSide;
  /** Signal time the window is anchored to. */
  at: number;
  source: JobSource;
  early?: OnChainRead;
  final?: OnChainRead;
  /** Failed attempts in the current phase. */
  attempts: number;
  /** Consecutive "still queued" answers in the current phase. */
  polls: number;
  /** Earliest time the next request may run. */
  nextAt: number;
  /** True once the final verdict (or a terminal failure) is in. */
  done: boolean;
  /** Ask the backend to ignore its cache on the next request. */
  force?: boolean;
  lastError?: string;
  updatedAt: number;
}

export function newJob(
  input: { id: string; symbol: string; side: SignalSide; at: number; source: JobSource },
  now: number,
): OnChainJob {
  return {
    id: input.id,
    symbol: input.symbol,
    side: input.side,
    at: input.at,
    source: input.source,
    attempts: 0,
    polls: 0,
    nextAt: now,
    done: false,
    updatedAt: now,
  };
}

/** Which scan a request made right now would be. */
export function phaseFor(job: Pick<OnChainJob, "at">, now: number): OnChainPhase {
  return now >= job.at + FINAL_AFTER_MS ? "final" : "early";
}

/** When the job next wants the network; `Infinity` once it is done. */
export function dueAt(job: OnChainJob, now: number): number {
  if (job.done) return Number.POSITIVE_INFINITY;
  const finalAt = job.at + FINAL_AFTER_MS;
  // With the early read in hand there is nothing to do until the final slot.
  if (job.early && now < finalAt) return Math.max(job.nextAt, finalAt);
  return job.nextAt;
}

/** The job to run now, if any: earliest due, fresher signals first on ties. */
export function pickDue(jobs: OnChainJob[], now: number): OnChainJob | undefined {
  let best: OnChainJob | undefined;
  let bestDue = Number.POSITIVE_INFINITY;
  for (const job of jobs) {
    const due = dueAt(job, now);
    if (due > now) continue;
    if (!best || due < bestDue || (due === bestDue && job.at > best.at)) {
      best = job;
      bestDue = due;
    }
  }
  return best;
}

/** The next moment any job becomes due, for the wake-up timer. */
export function nextWake(jobs: OnChainJob[], now: number): number | undefined {
  let wake: number | undefined;
  for (const job of jobs) {
    const due = dueAt(job, now);
    if (!Number.isFinite(due) || due <= now) continue;
    if (wake === undefined || due < wake) wake = due;
  }
  return wake;
}

/** A synthetic unavailable read, for failures the backend never saw. */
export function unavailableRead(
  job: Pick<OnChainJob, "symbol" | "side" | "at">,
  phase: OnChainPhase,
  reason: OnChainReason,
  message: string,
  retryable: boolean,
  now: number,
): OnChainRead {
  return {
    version: 1,
    symbol: job.symbol,
    side: job.side,
    at: job.at,
    phase,
    window: { from: job.at - WINDOW_BEFORE_MS, to: job.at + WINDOW_AFTER_MS },
    state: "unavailable",
    reason,
    message,
    retryable,
    verdict: "none",
    qualifier: "none",
    confidence: "none",
    alignment: "neutral",
    inflowUsd: 0,
    outflowUsd: 0,
    netUsd: 0,
    clusters: [],
    stats: { transfers: 0, kept: 0, small: 0, outliers: 0, internal: 0, ignored: 0, truncated: false },
    summary: message,
    scannedAt: now,
    durationMs: 0,
    credits: 0,
  };
}

function settle(job: OnChainJob, phase: OnChainPhase, read: OnChainRead, now: number): OnChainJob {
  const base: OnChainJob = { ...job, attempts: 0, polls: 0, force: undefined, updatedAt: now };
  if (phase === "final") {
    return { ...base, final: read, done: true, nextAt: now, lastError: read.state === "ok" ? undefined : read.message };
  }
  return {
    ...base,
    early: read,
    nextAt: job.at + FINAL_AFTER_MS,
    lastError: read.state === "ok" ? undefined : read.message,
  };
}

function fail(job: OnChainJob, phase: OnChainPhase, read: OnChainRead, now: number): OnChainJob {
  // Nothing a retry could change: record it and stop, whatever the phase.
  if (!read.retryable) {
    return { ...job, [phase]: read, done: true, attempts: 0, polls: 0, force: undefined, lastError: read.message, updatedAt: now };
  }
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return settle(job, phase, read, now);
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return { ...job, attempts, polls: 0, nextAt: now + delay, lastError: read.message, updatedAt: now };
}

/** Folds one backend answer into the job. */
export function applyOutcome(job: OnChainJob, phase: OnChainPhase, outcome: ScanOutcome, now: number): OnChainJob {
  if (outcome.kind === "read") {
    const read = outcome.read;
    return read.state === "ok" ? settle(job, phase, read, now) : fail(job, phase, read, now);
  }

  if (outcome.kind === "pending") {
    const polls = job.polls + 1;
    if (polls >= MAX_POLLS) {
      const read = unavailableRead(job, phase, "timeout", "Scan stayed queued on the backend for too long", true, now);
      return fail({ ...job, polls: 0 }, phase, read, now);
    }
    return { ...job, polls, nextAt: now + POLL_DELAY_MS, updatedAt: now };
  }

  const read = unavailableRead(job, phase, outcome.reason, outcome.message, outcome.retryable, now);
  return fail(job, phase, read, now);
}

/** Resets a job so its final scan runs again, bypassing the backend cache. */
export function rescanJob(job: OnChainJob, now: number): OnChainJob {
  return { ...job, final: undefined, done: false, attempts: 0, polls: 0, nextAt: now, force: true, lastError: undefined, updatedAt: now };
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export type BadgeState = "idle" | "scanning" | "resolved" | "flat" | "unavailable";
export type BadgeTone = "muted" | "pos" | "neg" | "warn" | "brand";

export interface BadgeView {
  state: BadgeState;
  /** Badge text, always starting with "On-Chain". */
  label: string;
  tone: BadgeTone;
  /** True while the shown verdict comes from the early scan. */
  early: boolean;
  /** One short line of context for the detail view. */
  hint: string;
  read?: OnChainRead;
}

export const REASON_TEXT: Record<OnChainReason, string> = {
  "no-key": "Arkham key not set on the backend",
  "bad-key": "Arkham rejected the API key",
  forbidden: "Endpoint not in the Arkham plan, or credits exhausted",
  "rate-limited": "Rate limited",
  timeout: "Timed out",
  upstream: "Backend or Arkham error",
  network: "Backend unreachable",
  "token-unmapped": "Token could not be matched to Arkham",
  "no-coverage": "Chain not indexed by Arkham",
  "bad-request": "Request rejected",
};

const QUALIFIER_TEXT: Record<OnChainRead["qualifier"], string> = {
  "smart-money": "Smart Money",
  spot: "Spot",
  derivatives: "Derivatives",
  mixed: "Mixed venues",
  none: "",
};

function fmtDelay(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

/**
 * The verdict a job currently shows. A successful read always beats a failed
 * one, so an early verdict survives a final scan that could not run.
 */
export function currentRead(job: OnChainJob | undefined): OnChainRead | undefined {
  if (!job) return undefined;
  if (job.final?.state === "ok") return job.final;
  if (job.early?.state === "ok") return job.early;
  return job.final ?? job.early;
}

export function badgeOf(job: OnChainJob | undefined, now: number): BadgeView {
  if (!job) {
    return { state: "idle", label: "On-Chain: —", tone: "muted", early: false, hint: "Waits for a signal" };
  }

  const read = currentRead(job);
  const early = read?.phase === "early";

  if (!read || (read.state === "unavailable" && !job.done && read.phase === "final")) {
    const retrying = job.attempts > 0;
    const wait = job.nextAt - now;
    const phase = phaseFor(job, now);
    const hint =
      job.polls > 0
        ? `Queued on the backend · poll ${job.polls} of ${MAX_POLLS}`
        : retrying
          ? `Retry ${job.attempts} of ${MAX_ATTEMPTS - 1}${wait > 0 ? ` in ${fmtDelay(wait)}` : ""}${job.lastError ? ` · ${job.lastError}` : ""}`
          : phase === "early"
            ? "Window still open · early read in progress"
            : "Window closed · final read in progress";
    return { state: "scanning", label: "On-Chain: Scanning…", tone: "brand", early: false, hint };
  }

  if (read.state === "unavailable") {
    if (!job.done) {
      // Early scan failed; the final slot is still ahead.
      const finalIn = job.at + FINAL_AFTER_MS - now;
      return {
        state: "scanning",
        label: "On-Chain: Scanning…",
        tone: "brand",
        early: false,
        hint: `Early read failed (${read.reason ? REASON_TEXT[read.reason] : "error"}) · final read ${finalIn > 0 ? `in ${fmtDelay(finalIn)}` : "next"}`,
        read,
      };
    }
    return {
      state: "unavailable",
      label: "On-Chain: Unavailable",
      tone: "muted",
      early: false,
      hint: read.reason ? REASON_TEXT[read.reason] : read.message ?? "Unavailable",
      read,
    };
  }

  const suffix = early ? " · early" : "";
  if (read.verdict === "none") {
    return { state: "flat", label: `On-Chain: No flow${suffix}`, tone: "muted", early, hint: read.summary, read };
  }
  if (read.verdict === "mixed") {
    return { state: "flat", label: `On-Chain: Mixed${suffix}`, tone: "warn", early, hint: read.summary, read };
  }

  const q = QUALIFIER_TEXT[read.qualifier];
  const head = read.verdict === "accumulation" ? "Accumulation" : "Distribution";
  const label = `On-Chain: ${head}${q ? ` (${q})` : ""}${suffix}`;
  const tone: BadgeTone = read.verdict === "accumulation" ? "pos" : "neg";
  const align =
    read.alignment === "confirms" ? "confirms the short" : read.alignment === "contradicts" ? "contradicts the short" : "";
  const finalNote = !early
    ? ""
    : job.done && job.final?.state === "unavailable"
      ? `final read failed: ${job.final.reason ? REASON_TEXT[job.final.reason] : "error"}`
      : job.attempts > 0
        ? `final read retry ${job.attempts} of ${MAX_ATTEMPTS - 1}`
        : "";
  const hint = [read.summary, align, `confidence ${read.confidence}`, finalNote].filter(Boolean).join(" · ");
  return { state: "resolved", label, tone, early, hint, read };
}

/** Test alerts are a delivery check and must not spend Arkham credits. */
export function isTestAlert(alert: { reasons: string[] }): boolean {
  return alert.reasons.some((r) => r.startsWith("Test alert"));
}

export function manualJobId(symbol: string, at: number): string {
  return `manual:${symbol}:${at}`;
}
