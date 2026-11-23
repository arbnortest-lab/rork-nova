/**
 * Wick Signal Monitor rules, unit-tested against hand-computed candles:
 * closed 1H candles only, green candles only, every non-zero wick recorded
 * (upper and lower independently), stable dedupe ids, relative volume and a
 * CSV that carries every column.
 */

import { describe, expect, it } from "vitest";

import {
  WICK_RVOL_LOOKBACK,
  baselineVolume,
  detectClosedCandleSignals,
  detectHistory,
  signalsToCsv,
  wickGeometry,
} from "@/lib/signals/wickSignal";
import type { ChartBar } from "@/lib/radar/types";
import type { WickSignalContext } from "@/lib/signals/wickSignal";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 20, 12);

function bar(overrides: Partial<ChartBar> & { time?: number } = {}): ChartBar {
  return {
    time: overrides.time ?? T0,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 100,
    quoteVolume: 10_000,
    closed: true,
    ...overrides,
  };
}

const NO_CONTEXT: WickSignalContext = { walls: [] };

/** A green candle with both wicks: open 100, close 100.5, high 101, low 99. */
const GREEN_BOTH = bar();

describe("wickGeometry", () => {
  it("splits body and wicks", () => {
    expect(wickGeometry(GREEN_BOTH)).toEqual({ upper: 0.5, lower: 1, body: 0.5, range: 2 });
  });

  it("returns undefined for a degenerate candle", () => {
    expect(wickGeometry({ open: 100, high: 100, low: 100, close: 100 })).toBeUndefined();
    expect(wickGeometry({ open: 100, high: 99, low: 101, close: 100 })).toBeUndefined();
  });
});

describe("detectClosedCandleSignals", () => {
  it("emits upper and lower wicks independently for one green candle", () => {
    const out = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    expect(out.map((s) => s.type).sort()).toEqual(["lower", "upper"]);
    const upper = out.find((s) => s.type === "upper")!;
    expect(upper.wickSize).toBe(0.5);
    expect(upper.upperWick).toBe(0.5);
    expect(upper.lowerWick).toBe(1);
    expect(upper.wickPct).toBeCloseTo(25, 6);
    expect(upper.wickRangeRatio).toBeCloseTo(0.25, 6);
  });

  it("ignores red candles completely, however long the wick", () => {
    const red = bar({ open: 100.5, close: 100, high: 103, low: 97 });
    expect(detectClosedCandleSignals("BTCUSDT", red, undefined, undefined, NO_CONTEXT)).toEqual([]);
  });

  it("ignores unclosed candles — nothing publishes before the 1H close", () => {
    const forming = bar({ closed: false });
    expect(detectClosedCandleSignals("BTCUSDT", forming, undefined, undefined, NO_CONTEXT)).toEqual([]);
  });

  it("records every non-zero wick, with no minimum percentage", () => {
    // A 1e-6 upper wick on a 2-unit range is still a signal — and the
    // candle's 1-unit lower wick is recorded alongside it.
    const tiny = bar({ high: 100.5 + 1e-6 });
    const out = detectClosedCandleSignals("BTCUSDT", tiny, undefined, undefined, NO_CONTEXT);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("upper");
    expect(out[0].wickSize).toBeCloseTo(1e-6, 12);
  });

  it("skips a side with zero wick but keeps the other", () => {
    const flatTop = bar({ open: 100, close: 100.5, high: 100.5, low: 99 });
    const out = detectClosedCandleSignals("BTCUSDT", flatTop, undefined, undefined, NO_CONTEXT);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("lower");
  });

  it("derives times from the candle open, one full hour later", () => {
    const [only] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    expect(only.openTime).toBe(T0);
    expect(only.closeTime).toBe(T0 + HOUR);
    expect(only.signalTime).toBe(T0 + HOUR);
  });

  it("dedupes structurally — the id pins symbol, open time and wick type", () => {
    const a = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    const b = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    const [upper] = a.filter((s) => s.type === "upper");
    expect(upper.id).toBe(`BTCUSDT:${T0}:upper`);
    // A different candle hour can never collide.
    const next = detectClosedCandleSignals("BTCUSDT", bar({ time: T0 + HOUR }), undefined, undefined, NO_CONTEXT);
    expect(next.every((s) => !a.some((x) => x.id === s.id))).toBe(true);
  });

  it("computes relative volume against the mean of the prior candles", () => {
    const base = 100;
    const [sig] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, base, NO_CONTEXT);
    expect(sig.rvol).toBeCloseTo(100, 6);
    const [spike] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, 50, NO_CONTEXT);
    expect(spike.rvol).toBeCloseTo(200, 6);
    const [none] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    expect(Number.isNaN(none.rvol)).toBe(true);
  });

  it("carries quote-weighted wick notional and optional context, or leaves it unset", () => {
    const [sig] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, {
      walls: [],
      high24h: 101,
      low24h: 99,
      vwap24h: 100.25,
    });
    expect(sig.wickUsdt).toBeCloseTo(sig.wickSize * GREEN_BOTH.volume, 9);
    expect(sig.distHighPct).toBeCloseTo(0, 6);
    expect(sig.distLowPct).toBeCloseTo(0, 6);
    expect(sig.distVwapPct).not.toBeUndefined();
    expect(sig.weightedBidShare).toBeUndefined();
    expect(sig.fundingRate).toBeUndefined();
  });

  it("picks the nearest wall in the wick's rejection direction", () => {
    const walls = [
      { side: "sell" as const, price: 105, notional: 1_000_000, strength: 1, distance: 4.5 },
      { side: "sell" as const, price: 102, notional: 2_000_000, strength: 1, distance: 1.5 },
      { side: "buy" as const, price: 98, notional: 3_000_000, strength: 1, distance: -1 },
    ];
    const out = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, { walls });
    const upper = out.find((s) => s.type === "upper")!;
    const lower = out.find((s) => s.type === "lower")!;
    expect(upper.nearestWall?.price).toBe(102);
    expect(lower.nearestWall?.price).toBe(98);
  });
});

describe("baselineVolume", () => {
  const bars: ChartBar[] = Array.from({ length: 30 }, (_, i) =>
    bar({ time: T0 - (30 - i) * HOUR, volume: 10 + i }),
  );

  it("averages the WICK_RVOL_LOOKBACK closed candles before the index", () => {
    expect(WICK_RVOL_LOOKBACK).toBe(20);
    const mean = baselineVolume(bars, 29)!;
    expect(mean).toBeCloseTo(
      bars.slice(9, 29).reduce((s, b) => s + b.volume, 0) / 20,
      6,
    );
  });

  it("uses what exists when fewer candles precede the index", () => {
    expect(baselineVolume(bars, 1)).toBeCloseTo(bars[0].volume, 6);
  });

  it("returns undefined with no history", () => {
    expect(baselineVolume(bars, 0)).toBeUndefined();
  });
});

describe("detectHistory", () => {
  it("walks a closed slice oldest-first and skips red and forming candles", () => {
    const bars: ChartBar[] = [
      bar({ time: T0 - 2 * HOUR, open: 100, close: 100.4, high: 100.6, low: 99.8 }), // green, both wicks
      bar({ time: T0 - HOUR, open: 100.4, close: 100.1, high: 101, low: 99.9 }), // red
      bar({ time: T0, open: 100.1, close: 100.3, high: 100.4, low: 100.2, closed: false }), // forming
      bar({ time: T0 + HOUR, open: 100.3, close: 100.8, high: 101.2, low: 100.3 }), // green, upper only
    ];
    const out = detectHistory("USDCUSDT", bars, NO_CONTEXT);
    expect(out.map((s) => s.id)).toEqual([
      `USDCUSDT:${T0 - 2 * HOUR}:upper`,
      `USDCUSDT:${T0 - 2 * HOUR}:lower`,
      `USDCUSDT:${T0 + HOUR}:upper`,
    ]);
    // The last candle's baseline is the mean of the three prior candles.
    const last = out[2];
    expect(last.rvol).toBeCloseTo(100, 6);
  });
});

describe("signalsToCsv", () => {
  it("has 28 columns and round-trips the fields it carries", () => {
    const [sig] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, 100, NO_CONTEXT);
    const csv = signalsToCsv([sig]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split(",")).toHaveLength(28);
    const cells = lines[1].split(",");
    expect(cells[1]).toBe("BTCUSDT");
    expect(cells[2]).toBe("UPPER");
    expect(Number(cells[11])).toBeCloseTo(sig.wickSize, 9); // wick_size
    expect(Number(cells[16])).toBeCloseTo(100, 1); // rvol_pct
    expect(new Date(cells[0]).getTime()).toBe(sig.signalTime);
  });

  it("leaves missing optional context empty, never zero", () => {
    const [sig] = detectClosedCandleSignals("BTCUSDT", GREEN_BOTH, undefined, undefined, NO_CONTEXT);
    const cells = signalsToCsv([sig]).split("\r\n")[1].split(",");
    // weighted_bid_share, wall_price, wall_notional, oi_change_1h_pct,
    // funding_rate and liquidation_notional columns are empty, never zero.
    expect(cells[23]).toBe("");
    expect(cells[24]).toBe("");
    expect(cells[25]).toBe("");
    expect(cells[26]).toBe("");
    expect(cells[27]).toBe("");
  });
});
