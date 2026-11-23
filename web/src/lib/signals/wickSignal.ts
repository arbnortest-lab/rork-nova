/**
 * Advanced Wick Signal Monitor — pure detection over CLOSED 1H candles.
 *
 * Rules, exactly as specified and deliberately dumb:
 *
 *   • 1H timeframe ONLY — the caller feeds closed 1-hour bars; the visual
 *     chart's timeframe never reaches this code.
 *   • Green candles only: close > open. Red candles are ignored completely.
 *   • Every non-zero wick is a signal. There is NO minimum wick percentage
 *     and nothing is discarded for being small.
 *   • A signal is confirmed and published only after the 1H candle CLOSES.
 *   • Upper and lower wicks are recorded independently (a candle can carry
 *     both). One signal per wick per candle — the id pins symbol, open time
 *     and type, which makes duplicates structurally impossible.
 *
 * An upper wick suggests rejection from above (selling pressure); a lower
 * wick suggests rejection from below (buying pressure). Nothing here claims a
 * reversal — the market context travels alongside each signal, or reads
 * "n/a" when the data is not live.
 *
 * Pure module: no React, no sockets, so it is directly unit-testable.
 */

import type { ChartBar } from "@/lib/radar/types";
import type { MarkTick, OiRead, Wall } from "@/lib/wick/types";

/** Prior closed candles behind the relative-volume baseline. */
export const WICK_RVOL_LOOKBACK = 20;

export type WickType = "upper" | "lower";

export interface WickSignalContext {
  high24h?: number;
  low24h?: number;
  /** Binance's own 24h VWAP, from the ticker. */
  vwap24h?: number;
  mark?: MarkTick;
  oi?: OiRead;
  /** Weighted bid share of resting notional, 0-100; undefined when no book. */
  weightedBidShare?: number;
  /** Live whale walls, when the depth socket is attached. */
  walls: Wall[];
  /** Forced-order notional in the trailing hour, when liquidations are subscribed. */
  liquidationNotional?: number;
  liquidationCount?: number;
}

export interface WickSignal {
  /** Stable identity: symbol, candle open time, wick type. Dedupes on insert. */
  id: string;
  symbol: string;
  type: WickType;
  /** When the closed candle confirmed the signal. */
  signalTime: number;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Absolute wick sizes, in price units. */
  upperWick: number;
  lowerWick: number;
  /** The detected wick's size in price units… */
  wickSize: number;
  /** …in USDT quote terms for the candle's volume… */
  wickUsdt: number;
  /** …as a percent of the candle range. */
  wickPct: number;
  /** Wick-to-range ratio, 0-1. */
  wickRangeRatio: number;
  bodySize: number;
  volume: number;
  quoteVolume: number;
  /** Volume vs the mean of the prior closed 1h candles, percent. */
  rvol: number;
  prevClose: number;
  prevVolume: number;
  /** Percent from the 24h extremes. */
  distHighPct?: number;
  distLowPct?: number;
  /** Percent from the 24h VWAP. */
  distVwapPct?: number;
  weightedBidShare?: number;
  /** Nearest wall in the wick's rejection direction, if the book is live. */
  nearestWall?: Wall;
  oiChange1h?: number;
  fundingRate?: number;
  liquidationNotional?: number;
  liquidationCount?: number;
}

/** Candle body and wicks from OHLC; undefined for a degenerate (zero-range) candle. */
export function wickGeometry(bar: { open: number; high: number; low: number; close: number }):
  | { upper: number; lower: number; body: number; range: number }
  | undefined {
  const { open, high, low, close } = bar;
  if (!(high >= low) || !(high > 0)) return undefined;
  const body = Math.abs(close - open);
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;
  const range = high - low;
  if (range <= 0) return undefined;
  return { upper, lower, body, range };
}

/** Mean base volume of the closed candles before index, oldest-first series. */
export function baselineVolume(bars: ChartBar[], index: number, lookback = WICK_RVOL_LOOKBACK): number | undefined {
  const start = Math.max(0, index - lookback);
  const slice = bars.slice(start, index);
  if (!slice.length) return undefined;
  return slice.reduce((sum, b) => sum + b.volume, 0) / slice.length;
}

function nearestWall(walls: Wall[], type: WickType): Wall | undefined {
  const side = type === "upper" ? "sell" : "buy";
  const candidates = walls.filter((w) => w.side === side && w.distance !== 0);
  if (!candidates.length) return undefined;
  return candidates.reduce((best, w) => (Math.abs(w.distance) < Math.abs(best.distance) ? w : best));
}

/**
 * Every wick signal one CLOSED candle carries — empty for red candles and for
 * green candles with no wick on a side. Context fields are optional on
 * purpose: a signal never waits for context, the context columns simply
 * report "n/a" while the data is missing. `prev` is the candle immediately
 * before `bar`; `baseVolume` the mean volume of the candles before it.
 */
export function detectClosedCandleSignals(
  symbol: string,
  bar: ChartBar,
  prev: ChartBar | undefined,
  baseVolume: number | undefined,
  context: WickSignalContext,
): WickSignal[] {
  if (!bar.closed) return [];
  if (!(bar.close > bar.open)) return []; // green candles only; red and doji are out

  const geom = wickGeometry(bar);
  if (!geom) return [];

  const rvol = baseVolume !== undefined && baseVolume > 0 ? (bar.volume / baseVolume) * 100 : NaN;
  const closeTime = bar.time + 3_600_000;
  const range = geom.range;

  const build = (type: WickType, wickSize: number): WickSignal => ({
    id: `${symbol}:${bar.time}:${type}`,
    symbol,
    type,
    signalTime: closeTime,
    openTime: bar.time,
    closeTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    upperWick: geom.upper,
    lowerWick: geom.lower,
    wickSize,
    // The wick in quote terms for the candle: price distance × candle volume,
    // the notional that traded through the rejection.
    wickUsdt: wickSize * bar.volume,
    wickPct: (wickSize / range) * 100,
    wickRangeRatio: wickSize / range,
    bodySize: geom.body,
    volume: bar.volume,
    quoteVolume: bar.quoteVolume,
    rvol,
    prevClose: prev?.close ?? NaN,
    prevVolume: prev?.volume ?? NaN,
    distHighPct: context.high24h && context.high24h > 0 ? ((bar.high - context.high24h) / context.high24h) * 100 : undefined,
    distLowPct: context.low24h && context.low24h > 0 ? ((bar.low - context.low24h) / context.low24h) * 100 : undefined,
    distVwapPct: context.vwap24h && context.vwap24h > 0 ? ((bar.close - context.vwap24h) / context.vwap24h) * 100 : undefined,
    weightedBidShare: context.weightedBidShare,
    nearestWall: nearestWall(context.walls, type),
    oiChange1h: context.oi?.change1h,
    fundingRate: context.mark?.fundingRate,
    liquidationNotional: context.liquidationNotional,
    liquidationCount: context.liquidationCount,
  });

  const out: WickSignal[] = [];
  if (geom.upper > 0) out.push(build("upper", geom.upper));
  if (geom.lower > 0) out.push(build("lower", geom.lower));
  return out;
}

/**
 * Detect over a whole closed history slice (oldest first), newest signals
 * last. Used to seed the monitor from REST history and unit-tested against
 * hand-computed candles.
 */
export function detectHistory(symbol: string, bars: ChartBar[], context: WickSignalContext): WickSignal[] {
  const out: WickSignal[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar.closed) continue;
    out.push(...detectClosedCandleSignals(symbol, bar, bars[i - 1], baselineVolume(bars, i), context));
  }
  return out;
}

/** RFC-4180 CSV of the signal table. */
export function signalsToCsv(signals: WickSignal[]): string {
  const head = [
    "signal_time",
    "pair",
    "wick_type",
    "candle_open",
    "candle_close",
    "open",
    "high",
    "low",
    "close",
    "upper_wick",
    "lower_wick",
    "wick_size",
    "wick_pct",
    "wick_range_ratio",
    "body",
    "volume",
    "rvol_pct",
    "prev_close",
    "prev_volume",
    "dist_24h_high_pct",
    "dist_24h_low_pct",
    "dist_vwap_pct",
    "weighted_bid_share",
    "wall_price",
    "wall_notional",
    "oi_change_1h_pct",
    "funding_rate_pct",
    "liquidation_notional_1h",
  ].join(",");
  const rows = signals.map((s) =>
    [
      new Date(s.signalTime).toISOString(),
      s.symbol,
      s.type.toUpperCase(),
      new Date(s.openTime).toISOString(),
      new Date(s.closeTime).toISOString(),
      s.open,
      s.high,
      s.low,
      s.close,
      s.upperWick,
      s.lowerWick,
      s.wickSize,
      s.wickPct.toFixed(2),
      s.wickRangeRatio.toFixed(4),
      s.bodySize,
      s.volume,
      Number.isFinite(s.rvol) ? s.rvol.toFixed(1) : "",
      Number.isFinite(s.prevClose) ? s.prevClose : "",
      Number.isFinite(s.prevVolume) ? s.prevVolume : "",
      s.distHighPct?.toFixed(3) ?? "",
      s.distLowPct?.toFixed(3) ?? "",
      s.distVwapPct?.toFixed(3) ?? "",
      s.weightedBidShare?.toFixed(1) ?? "",
      s.nearestWall?.price ?? "",
      s.nearestWall?.notional ?? "",
      s.oiChange1h?.toFixed(3) ?? "",
      s.fundingRate?.toFixed(4) ?? "",
      s.liquidationNotional ?? "",
    ]
      .map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : String(v)))
      .join(","),
  );
  return [head, ...rows].join("\r\n");
}
