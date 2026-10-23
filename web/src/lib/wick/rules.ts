/**
 * Defaults and sanitisers for the Liquidity Exhaustion Engine configuration.
 *
 * This module deliberately imports nothing but types, so the PDF build script
 * can read the live thresholds without pulling in the browser-side engine.
 */

import type { WickRules } from "./types";

/** Bars behind the "higher high" half of the trap test. */
export const TRAP_LOOKBACK = 12;
/** How many of the newest bars may carry the rejection. Keeps the trap recent. */
export const TRAP_SCAN = 3;
/** Bars behind the relative-volume baseline. */
export const RVOL_LOOKBACK = 96;

export const DEFAULT_WICK_RULES: WickRules = {
  refreshMs: 2_000,
  minVolume: 5_000_000,
  /** Within 5 bps of the 24h extreme counts as pinned. */
  pinBps: 5,
  rvolClimax: 300,
  wickPct: 45,
  depletionPct: 0.5,
  horizonDays: 365,
  deepWatch: 12,
  cooldownMins: 30,
};

/** Refresh cadence options — the spec asks for 1-5 seconds. */
export const REFRESH_OPTIONS = [
  { value: 1_000, label: "1s" },
  { value: 2_000, label: "2s" },
  { value: 3_000, label: "3s" },
  { value: 5_000, label: "5s" },
] as const;

export const DEEP_OPTIONS = [
  { value: 6, label: "6" },
  { value: 12, label: "12" },
  { value: 18, label: "18" },
  { value: 24, label: "24" },
] as const;

/** Long-horizon windows for the depletion gate, in trading days. */
export const HORIZON_OPTIONS = [
  { value: 90, label: "90d" },
  { value: 180, label: "180d" },
  { value: 365, label: "1y" },
] as const;

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerces persisted configuration back into range. A stored value from an older
 * build, or a hand-edited localStorage entry, can never put the engine into a
 * state where it arms on nothing or hammers the venue.
 *
 * The wick floor is 45% by specification — the trap is defined by a rejection
 * that took at least that much of the candle back — so it is clamped there and
 * cannot be configured below it.
 */
export function sanitizeWickRules(raw: unknown): WickRules {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_WICK_RULES };
  const r = raw as Partial<Record<keyof WickRules, unknown>>;
  const allowed = REFRESH_OPTIONS.map((o) => o.value) as readonly number[];
  const refreshMs =
    typeof r.refreshMs === "number" && allowed.includes(r.refreshMs)
      ? r.refreshMs
      : DEFAULT_WICK_RULES.refreshMs;

  return {
    refreshMs,
    minVolume: clampNum(r.minVolume, 0, 5_000_000_000, DEFAULT_WICK_RULES.minVolume),
    pinBps: clampNum(r.pinBps, 0.5, 100, DEFAULT_WICK_RULES.pinBps),
    rvolClimax: clampNum(r.rvolClimax, 150, 2_000, DEFAULT_WICK_RULES.rvolClimax),
    wickPct: clampNum(r.wickPct, 45, 95, DEFAULT_WICK_RULES.wickPct),
    depletionPct: clampNum(r.depletionPct, 0, 10, DEFAULT_WICK_RULES.depletionPct),
    horizonDays: Math.round(clampNum(r.horizonDays, 30, 365, DEFAULT_WICK_RULES.horizonDays)),
    deepWatch: Math.round(clampNum(r.deepWatch, 2, 24, DEFAULT_WICK_RULES.deepWatch)),
    cooldownMins: clampNum(r.cooldownMins, 1, 1_440, DEFAULT_WICK_RULES.cooldownMins),
  };
}
