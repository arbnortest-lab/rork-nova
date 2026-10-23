/**
 * Liquidity Exhaustion Engine — bull traps only.
 *
 * One model, four gates, no partial credit, ONE DIRECTION. A contract only
 * publishes a signal when it has run completely out of fuel at the rolling 24h
 * HIGH, which is taken short:
 *
 *   1. PIN        price reaches, sweeps or pins the rolling 24h high
 *   2. CLIMAX     relative volume spikes past the climax bar and is cooling
 *   3. TRAP       a lower-timeframe higher high is rejected by an upper wick
 *                 worth at least `wickPct` of that candle's range
 *   4. DEPLETION  the long-horizon high is reached, so there is no resting
 *                 liquidity left above to expand into
 *
 * Bear traps and long setups are out of scope by specification. Nothing here
 * measures the 24h low, and `TrapSide` cannot represent a long, so the engine
 * is incapable of emitting one rather than merely declining to.
 *
 * Everything here is pure: the whole model can be exercised without a socket.
 *
 * The cardinal rule is that an unmeasured gate never counts as passed. A
 * contract that has not loaded kline history yet cannot arm, no matter how
 * extreme its tier-1 numbers look.
 */

import { fmtCompactUsd, fmtPrice } from "@/lib/format";

import { TRAP_LOOKBACK, TRAP_SCAN } from "./rules";
import {
  GATE_LABEL,
  GATE_ORDER,
  type ExhaustionRead,
  type GateKey,
  type GateRead,
  type Kline,
  type LiquidityRead,
  type TickerTick,
  type VolumeRead,
  type WickRules,
} from "./types";

/** Re-exported so callers can import the engine and its output together. */
export type { ExhaustionRead, GateRead, TrapSide } from "./types";
export { TRAP_LOOKBACK, TRAP_SCAN } from "./rules";

const BPS = 10_000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------ */
/* Gate 1 — the 24h extreme                                            */
/* ------------------------------------------------------------------ */

export interface ExtremeRead {
  /** Distance from price up to the 24h high, in basis points. Never negative. */
  bps: number;
  /** The 24h high itself. */
  level: number;
  /** Position in the 24h range, 0 at the low and 1 at the high. */
  rangePos: number;
}

/**
 * How far price is from the rolling 24h HIGH.
 *
 * Only the high is measured. A contract sitting on its 24h low is not a
 * candidate for this engine at all — it simply reports a large distance and
 * fails gate 1, which is the correct outcome for a short-only model.
 *
 * A sweep prints beyond the rolling high, so the distance is clamped at zero
 * rather than going negative — trading through the level is the most complete
 * version of reaching it, not a miss.
 */
export function readExtreme(ticker: TickerTick): ExtremeRead | undefined {
  const { last, high, low } = ticker;
  if (!(last > 0) || !(high > 0) || !(low > 0) || high < low) return undefined;

  const span = high - low;
  const rangePos = span > 0 ? clamp01((last - low) / span) : 0.5;

  return { bps: Math.max(0, ((high - last) / last) * BPS), level: high, rangePos };
}

/* ------------------------------------------------------------------ */
/* Gate 3 — the wick rejection trap                                    */
/* ------------------------------------------------------------------ */

export interface TrapRead {
  /** Index of the trap bar inside the series it was found in. */
  index: number;
  at: number;
  /** Upper rejection wick as a share of the bar's total range, percent. */
  wickPct: number;
  /** The high the bar printed. */
  extreme: number;
  /** True when the bar extended beyond the whole lookback window. */
  extended: boolean;
}

/**
 * Upper rejection wick of one bar as a percentage of its range.
 *
 * Always the upper wick: this engine only cares about breakouts that failed
 * from above.
 */
export function wickShare(bar: Kline): number {
  const range = bar.high - bar.low;
  if (!(range > 0)) return 0;
  return clamp01((bar.high - Math.max(bar.open, bar.close)) / range) * 100;
}

/**
 * The price-action trap: a lower-timeframe higher high that was immediately
 * rejected — a bull trap.
 *
 * Both halves are required. A long wick on a bar that never took out the prior
 * range is just noise, and a new high that closed strong is continuation — only
 * the combination is a trap. The search covers the newest `scan` bars so a
 * rejection is reported while it is still actionable, never from an hour ago.
 */
export function findTrap(
  klines: Kline[],
  lookback: number = TRAP_LOOKBACK,
  scan: number = TRAP_SCAN,
): TrapRead | undefined {
  if (klines.length < lookback + 2) return undefined;

  let best: TrapRead | undefined;
  const first = Math.max(lookback, klines.length - scan);

  for (let i = first; i < klines.length; i += 1) {
    const bar = klines[i];
    const window = klines.slice(i - lookback, i);
    if (!window.length) continue;

    if (!(bar.high > Math.max(...window.map((k) => k.high)))) continue;

    const pct = wickShare(bar);
    if (!best || pct > best.wickPct) {
      best = { index: i, at: bar.openTime, wickPct: pct, extreme: bar.high, extended: true };
    }
  }

  return best;
}

/* ------------------------------------------------------------------ */
/* Gate 4 — long-horizon liquidity depletion                           */
/* ------------------------------------------------------------------ */

export interface HorizonRead {
  high: number;
  low: number;
  /** Completed daily bars actually behind the extremes. */
  days: number;
}

const DAY_MS = 86_400_000;

/**
 * Highest high and lowest low across the most recent `days` COMPLETED daily
 * bars.
 *
 * The in-progress day is excluded deliberately. If today's own bar could define
 * the horizon it is measured against, the gate would be self-referential: every
 * fresh breakout would sit exactly at its own yearly high and satisfy a test
 * that is supposed to mean there is no resting liquidity left above. Excluding
 * it also matches the `[1]` offset the TradingView indicator uses, so the two
 * implementations cannot disagree.
 */
export function readHorizon(
  daily: Kline[],
  days: number,
  now: number = Date.now(),
): HorizonRead | undefined {
  if (!daily.length) return undefined;
  const asOf = Number.isFinite(now) && now > 0 ? now : Date.now();
  const completed = daily.filter((bar) => bar.openTime > 0 && bar.openTime + DAY_MS <= asOf);
  if (!completed.length) return undefined;

  const slice = completed.slice(-Math.max(1, Math.round(days)));
  let high = -Infinity;
  let low = Infinity;
  for (const bar of slice) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0) return undefined;
  return { high, low, days: slice.length };
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export interface ExhaustionInput {
  symbol: string;
  ticker: TickerTick;
  volume: VolumeRead;
  /** Lower-timeframe history for the trap test. Tier 2 only. */
  klines?: Kline[];
  /** Daily history for the horizon extremes. Tier 2 only. */
  daily?: Kline[];
  /** Liquidity map, used to describe the remaining depth. Tier 2 only. */
  liquidity?: LiquidityRead;
  rules: WickRules;
  at: number;
}

/**
 * Builds one gate verdict.
 *
 * `ratio` is the raw measurement over its threshold, unclamped: 0.8 is a gate
 * at 80% of what it needs, 1.6 is a gate that cleared it by 60%. Splitting it
 * into `progress` (capped at 1) and `margin` (what lies beyond 1) keeps the
 * near-miss meter and the conviction score from contaminating each other.
 */
function gate(
  key: GateKey,
  passed: boolean,
  measured: boolean,
  ratio: number,
  detail: string,
): GateRead {
  const safe = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  const cleared = measured && passed;
  return {
    key,
    label: GATE_LABEL[key],
    // An unmeasured gate can never pass, whatever the caller computed.
    passed: cleared,
    measured,
    progress: measured ? Math.min(1, safe) : 0,
    // Saturates at double the threshold; past that, more is not more.
    margin: cleared ? clamp01(safe - 1) : 0,
    detail,
  };
}

/**
 * Runs all four gates and returns the full readout.
 *
 * `armed` is true only when every gate passed, which is the only condition
 * under which the engine will publish a signal.
 */
export function evaluateExhaustion(input: ExhaustionInput): ExhaustionRead {
  const { symbol, ticker, volume, klines, daily, liquidity, rules, at } = input;

  const extreme = readExtreme(ticker);
  const deep = Boolean(klines?.length);

  /* --- gate 1: pinned at the 24h high --- */
  // Distance gates are "smaller is better", so the ratio is inverted: exactly on
  // the threshold scores 1, and touching the level scores 2 (full margin).
  const pin = extreme
    ? gate(
        "pin",
        extreme.bps <= rules.pinBps,
        true,
        2 - extreme.bps / Math.max(0.01, rules.pinBps),
        extreme.bps <= 0.5
          ? `Sweeping the 24h high at ${fmtPrice(extreme.level)}`
          : `${extreme.bps.toFixed(1)} bps below the 24h high ${fmtPrice(extreme.level)} — needs ≤ ${rules.pinBps}`,
      )
    : gate("pin", false, false, 0, "Waiting for a 24h range");

  /* --- gate 2: volume climax, then cooling --- */
  const rvol = volume.rvol;
  const accel = volume.acceleration;
  const climaxHit = rvol !== undefined && rvol >= rules.rvolClimax;
  // Cooling is the exhaustion half: the surge has to be rolling over, not still
  // building, or the move still has fuel behind it.
  const cooling = accel !== undefined && accel <= 0;
  const climax = gate(
    "climax",
    climaxHit && cooling,
    rvol !== undefined && accel !== undefined,
    // Still accelerating is capped below the threshold: the surge has not spent
    // itself yet, so it can never read as a near-complete gate.
    rvol === undefined ? 0 : (rvol / Math.max(1, rules.rvolClimax)) * (cooling ? 1 : 0.5),
    rvol === undefined
      ? "Waiting for a volume baseline"
      : !climaxHit
        ? `RVOL ${Math.round(rvol)}% — needs ≥ ${rules.rvolClimax}%`
        : !cooling
          ? `RVOL ${Math.round(rvol)}% but still accelerating (${accel === undefined ? "—" : `${accel > 0 ? "+" : ""}${Math.round(accel)}`}) — not exhausted yet`
          : `RVOL ${Math.round(rvol)}% and cooling (${Math.round(accel ?? 0)}) — climax spent`,
  );

  /* --- gate 3: the failed-breakout trap --- */
  const trap = klines?.length ? findTrap(klines, TRAP_LOOKBACK, TRAP_SCAN) : undefined;
  const trapGate = gate(
    "trap",
    trap !== undefined && trap.wickPct >= rules.wickPct,
    deep,
    trap ? trap.wickPct / Math.max(1, rules.wickPct) : 0,
    !deep
      ? "Needs kline history — pin this contract to attach it"
      : !trap
        ? `No higher high in the last ${TRAP_SCAN} bars`
        : trap.wickPct >= rules.wickPct
          ? `Higher high at ${fmtPrice(trap.extreme)} rejected — upper wick ${trap.wickPct.toFixed(1)}% of range`
          : `Higher high held — upper wick only ${trap.wickPct.toFixed(1)}%, needs ≥ ${rules.wickPct}%`,
  );

  /* --- gate 4: upside liquidity depletion at the long-horizon high --- */
  const horizon = daily?.length ? readHorizon(daily, rules.horizonDays, at) : undefined;
  // Signed: positive while price is still below the horizon high, negative once
  // it has traded above it.
  const horizonPct =
    horizon !== undefined && ticker.last > 0
      ? ((horizon.high - ticker.last) / ticker.last) * 100
      : undefined;
  // The gate asserts price is AT the long-horizon high, so it is a band and
  // both sides fail. Far below leaves resting liquidity to expand into. Far
  // above means the level was swept long ago and price is in open-sky discovery
  // with nothing overhead to exhaust — the opposite of a spent move, however
  // violent it looks. Clamping the distance at zero collapsed that second case
  // into a perfect score, so the gate passed hardest exactly when its premise
  // was most false.
  const horizonGap = horizonPct === undefined ? undefined : Math.abs(horizonPct);
  const poolLeft = liquidity?.poolAbove;
  const depletion = gate(
    "depletion",
    horizonGap !== undefined && horizonGap <= rules.depletionPct,
    horizon !== undefined && horizonGap !== undefined,
    horizonGap === undefined ? 0 : 2 - horizonGap / Math.max(0.01, rules.depletionPct),
    !horizon || horizonPct === undefined || horizonGap === undefined
      ? "Waiting for daily history"
      : horizonGap <= rules.depletionPct
        ? `At the ${horizon.days}-day high ${fmtPrice(horizon.high)}${poolLeft === undefined ? "" : ` — ${poolLeft}% depth left above`}`
        : horizonPct > 0
          ? `${horizonGap.toFixed(2)}% below the ${horizon.days}-day high — needs ≤ ${rules.depletionPct}%`
          : `${horizonGap.toFixed(2)}% above the ${horizon.days}-day high — price is in discovery with nothing resting overhead`,
  );

  const byKey: Record<GateKey, GateRead> = {
    pin,
    climax,
    trap: trapGate,
    depletion,
  };
  const gates = GATE_ORDER.map((key) => byKey[key]);
  const passedCount = gates.filter((g) => g.passed).length;
  const measuredCount = gates.filter((g) => g.measured).length;
  const armed = passedCount === gates.length;

  // Conviction exists only for an armed setup and starts at 60, so it can never
  // be read as a probability: every armed signal already cleared every
  // threshold, and this says only by how much. An unarmed read scores 0.
  const margin = gates.reduce((sum, g) => sum + g.margin, 0) / gates.length;
  const conviction = armed ? Math.round(60 + 40 * clamp01(margin)) : 0;

  const span = ticker.high - ticker.low;

  return {
    symbol,
    // Short or nothing — the only two states this engine can produce.
    side: armed ? "short" : "none",
    armed,
    gates,
    passedCount,
    measuredCount,
    conviction,
    deep,
    price: ticker.last,
    high24h: ticker.high,
    low24h: ticker.low,
    rangePos: extreme?.rangePos ?? (span > 0 ? clamp01((ticker.last - ticker.low) / span) : 0.5),
    changePct: ticker.open > 0 ? ((ticker.last - ticker.open) / ticker.open) * 100 : 0,
    quoteVolume: ticker.quoteVolume,
    extremeBps: extreme?.bps,
    rvol,
    rvolAcceleration: accel,
    wickPct: trap?.wickPct,
    yearHigh: horizon?.high,
    yearLow: horizon?.low,
    yearDays: horizon?.days,
    at,
  };
}

/**
 * Ranking heuristic that decides which contracts earn tier-2 history.
 *
 * Built from tier-1 inputs only. If selection depended on kline data, a symbol
 * would have to already be watched to qualify for watching, and the watch list
 * would oscillate. Proximity to the 24h HIGH dominates, because that is gate 1
 * and nothing can arm without it — a contract near its 24h low ranks low here,
 * which is correct for a short-only engine.
 */
export function candidacy(input: {
  extremeBps?: number;
  rvol?: number;
  quoteVolume: number;
  pinBps: number;
  rvolClimax: number;
}): number {
  const pin =
    input.extremeBps === undefined ? 0 : clamp01(1 - input.extremeBps / Math.max(1, input.pinBps * 4));
  const rvol = clamp01(((input.rvol ?? 100) - 100) / Math.max(1, input.rvolClimax));
  // Turnover as a mild tiebreaker so a dead book never outranks a live one.
  const liquidity = clamp01(Math.log10(Math.max(1, input.quoteVolume) / 1e6) / 3);
  return pin * 0.6 + rvol * 0.3 + liquidity * 0.1;
}

/** One line per gate, for the alert payload and the remote channels. */
export function reasonsOf(read: ExhaustionRead): string[] {
  return read.gates.map((g) => `${g.label}: ${g.detail}`);
}

/** Headline used by the toast, the desktop notification and the tape. */
export function headlineOf(read: ExhaustionRead): string {
  if (!read.armed) return "No exhaustion setup";
  return `SHORT — bull trap at the 24h high ${fmtPrice(read.high24h)}`;
}

/** Compact turnover line shared by the panel and the alert body. */
export function turnoverLabel(read: ExhaustionRead): string {
  return `${fmtCompactUsd(read.quoteVolume)} 24h`;
}
