/**
 * Bullish lower-wick candle signal — an additive radar filter.
 *
 * The ONLY accepted pattern: a fully closed GREEN candle whose lower shadow
 * matches the general shape of the user's reference candle — the tail below
 * the body is the candle's dominant feature. Detection is purely
 * shape-based and scale-invariant: there are NO fixed thresholds (no minimum
 * percentage of range, no body multiplier), so a small candle with the same
 * structure qualifies exactly like a large one. A larger tail only reads as
 * a stronger signal in the table.
 *
 * Rule, in full:
 *   1. the candle is fully CLOSED (checked by the monitor, never the forming bar)
 *   2. the candle is GREEN (close > open)
 *   3. a lower wick extends below the body (open − low > 0)
 *   4. the wick dominates the candle's shape: tail > body AND tail > upper
 *      shadow — the reference candle's structure, at any absolute size
 */

/** Timeframes the independent monitor watches, each closed independently. */
export type MonitorInterval = "15m" | "1h" | "4h";

export const MONITOR_INTERVALS: MonitorInterval[] = ["15m", "1h", "4h"];

export const INTERVAL_MS: Record<MonitorInterval, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
};

/** Rows kept in the radar's signal table. */
export const WICK_SIGNALS_KEPT = 100;

export interface LowerWickSignal {
  symbol: string;
  interval: MonitorInterval;
  /** Candle close time, ms (venue epoch) — when the signal became valid. */
  closedAt: number;
  /** Closing (last) price of the candle. */
  close: number;
  /** Lower-shadow size in price terms. */
  wick: number;
  /** Lower shadow as a share of the bar's full range, 0–1 (display only). */
  rangeShare: number;
  /** Lower shadow in body multiples (display only). */
  bodyMultiple: number;
}

/** Shape read of one OHLC set, independent of its absolute size. */
export interface WickShape {
  wick: number;
  body: number;
  upper: number;
  rangeShare: number;
  bodyMultiple: number;
}

/**
 * The candle-shape test. Returns null for anything that is not a green
 * candle with a dominant lower wick; otherwise the shape figures.
 */
export function wickShape(o: number, h: number, l: number, c: number): WickShape | null {
  if (![o, h, l, c].every(Number.isFinite)) return null;
  const body = c - o;
  if (body <= 0) return null; // red or flat candle — never
  const wick = o - l;
  if (wick <= 0) return null; // no lower wick below the body
  const upper = h - c;
  if (!(wick > body) || !(wick > upper)) return null; // tail must dominate, reference shape
  const range = h - l;
  return {
    wick,
    body,
    upper,
    rangeShare: range > 0 ? wick / range : 0,
    bodyMultiple: wick / body,
  };
}

/**
 * Evaluate one fully closed candle. Callers must only pass CLOSED candles —
 * the forming bar never reaches this function.
 */
export function lowerWickSignal(
  symbol: string,
  interval: MonitorInterval,
  openTime: number,
  closeTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
): LowerWickSignal | null {
  const shape = wickShape(o, h, l, c);
  if (!shape) return null;
  return {
    symbol,
    interval,
    closedAt: closeTime,
    close: c,
    wick: shape.wick,
    rangeShare: shape.rangeShare,
    bodyMultiple: shape.bodyMultiple,
  };
}
