/**
 * Bullish lower-wick candle signal — an additive radar filter.
 *
 * The ONLY accepted pattern: a fully closed GREEN candle whose lower shadow
 * matches or exceeds the user's reference candle (a hammer-like print whose
 * tail spans most of the bar). Red candles, forming candles, and candles with
 * a smaller lower wick never qualify, and no other pattern is recognised.
 *
 * Reference-candle thresholds, derived from the user's screenshot (tail ≈ 78%
 * of the range, ≈ 4.5× the body):
 *   - the candle is closed and bullish (close > open)
 *   - lower wick ≥ 70% of the bar's full range
 *   - lower wick ≥ 3× the body
 * A larger tail only raises the strength figures shown in the table.
 */

import { CHART_INTERVALS, type ChartBar, type ChartInterval } from "./types";

export const WICK_SIGNAL_MIN_RANGE_SHARE = 0.7;
export const WICK_SIGNAL_MIN_BODY_MULTIPLE = 3;

/** Rows kept in the radar's signal table. */
export const WICK_SIGNALS_KEPT = 50;

export interface LowerWickSignal {
  symbol: string;
  interval: ChartInterval;
  /** Candle open time, ms (venue epoch). */
  time: number;
  /** Candle close time, ms — when the signal became valid. */
  closedAt: number;
  /** Closing (last) price of the candle. */
  close: number;
  /** Lower-shadow size in price terms. */
  wick: number;
  /** Lower shadow as a share of the bar's full range, 0–1. */
  rangeShare: number;
  /** Lower shadow in body multiples. */
  bodyMultiple: number;
}

export function intervalMs(interval: ChartInterval): number {
  return CHART_INTERVALS.find((i) => i.value === interval)?.ms ?? 60_000;
}

/**
 * Evaluate one candle. Returns a signal only when it is fully closed, green,
 * and its lower shadow reaches the reference size; null otherwise.
 */
export function lowerWickSignal(bar: ChartBar, symbol: string, interval: ChartInterval): LowerWickSignal | null {
  const range = bar.high - bar.low;
  const body = bar.close - bar.open;
  // Forming candles and red candles never qualify; a zero range is unusable.
  if (!bar.closed || body <= 0 || range <= 0) return null;
  const wick = Math.min(bar.open, bar.close) - bar.low;
  if (wick <= 0) return null;
  const rangeShare = wick / range;
  const bodyMultiple = wick / body;
  if (rangeShare < WICK_SIGNAL_MIN_RANGE_SHARE || bodyMultiple < WICK_SIGNAL_MIN_BODY_MULTIPLE) return null;
  return {
    symbol,
    interval,
    time: bar.time,
    closedAt: bar.time + intervalMs(interval),
    close: bar.close,
    wick,
    rangeShare,
    bodyMultiple,
  };
}

/**
 * Fold a bar series through the detector, returning signals for closed bars
 * strictly newer than `afterTime` (0 = evaluate the whole history).
 */
export function scanClosedBars(bars: ChartBar[], symbol: string, interval: ChartInterval, afterTime = 0): LowerWickSignal[] {
  const out: LowerWickSignal[] = [];
  for (const bar of bars) {
    if (bar.closed && bar.time > afterTime) {
      const signal = lowerWickSignal(bar, symbol, interval);
      if (signal) out.push(signal);
    }
  }
  return out;
}

/** Open time of the newest already-closed bar, or 0 when none is closed yet. */
export function newestClosedTime(bars: ChartBar[]): number {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].closed) return bars[i].time;
  }
  return 0;
}
