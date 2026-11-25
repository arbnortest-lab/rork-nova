import { describe, expect, it } from "vitest";

import type { ChartBar } from "@/lib/radar/types";
import {
  intervalMs,
  lowerWickSignal,
  newestClosedTime,
  scanClosedBars,
} from "@/lib/radar/wickSignal";

function bar(over: Partial<ChartBar> = {}): ChartBar {
  return {
    time: 1_700_000_000_000,
    open: 100,
    high: 101,
    low: 90,
    close: 100.5,
    volume: 1,
    quoteVolume: 100,
    closed: true,
    ...over,
  };
}

describe("lowerWickSignal", () => {
  it("accepts the reference-shaped candle: green, tail ≈ 78% of range", () => {
    // open 100, close 100.5, high 101, low 90 → body 0.5, tail 10, range 11
    const s = lowerWickSignal(bar(), "BTCUSDT", "1m");
    expect(s).not.toBeNull();
    expect(s!.wick).toBe(10);
    expect(s!.rangeShare).toBeCloseTo(10 / 11, 6);
    expect(s!.bodyMultiple).toBe(20);
    expect(s!.closedAt).toBe(1_700_000_000_000 + 60_000);
  });

  it("rejects red candles even with a huge tail", () => {
    expect(lowerWickSignal(bar({ open: 100.5, close: 100 }), "BTCUSDT", "1m")).toBeNull();
  });

  it("rejects forming candles even when the shape qualifies", () => {
    expect(lowerWickSignal(bar({ closed: false }), "BTCUSDT", "1m")).toBeNull();
  });

  it("rejects a lower wick below the reference size — small tail on a big body", () => {
    // body 9, tail 2.5 → share ≈ 0.22, multiple ≈ 0.28
    expect(lowerWickSignal(bar({ high: 110, low: 97.5, close: 109 }), "BTCUSDT", "1m")).toBeNull();
  });

  it("rejects when the tail dominates the range but the body dwarfs it", () => {
    // body 9, tail 9, upper 0 → share 0.5 < 0.7
    expect(lowerWickSignal(bar({ open: 100, close: 109, high: 109, low: 91 }), "BTCUSDT", "1m")).toBeNull();
  });

  it("rejects when the tail is 3× the body but under 70% of range", () => {
    // body 1, tail 3.5, upper 1 → multiple 3.5, share 0.636
    expect(lowerWickSignal(bar({ open: 100, close: 101, high: 102, low: 96.5 }), "BTCUSDT", "1m")).toBeNull();
  });

  it("accepts exactly-at-threshold tails (share ≥0.7, multiple ≥3)", () => {
    // body 2, tail 6 (3× body), upper 0.5 → range 8.5, share 0.706.
    const s = lowerWickSignal(bar({ open: 100, close: 102, high: 102.5, low: 94 }), "BTCUSDT", "1m");
    expect(s).not.toBeNull();
    expect(s!.bodyMultiple).toBe(3);
  });

  it("rejects doji-flat and zero-range candles", () => {
    expect(lowerWickSignal(bar({ open: 100, close: 100, high: 101, low: 90 }), "BTCUSDT", "1m")).toBeNull();
    expect(lowerWickSignal(bar({ open: 100, close: 100, high: 100, low: 100 }), "BTCUSDT", "1m")).toBeNull();
  });

  it("scales strength with tail size — bigger tail, higher multiples", () => {
    const small = lowerWickSignal(bar({ open: 100, close: 100.5, high: 101, low: 96.5 }), "BTCUSDT", "1m")!;
    const big = lowerWickSignal(bar(), "BTCUSDT", "1m")!;
    expect(big.rangeShare).toBeGreaterThan(small.rangeShare);
    expect(big.bodyMultiple).toBeGreaterThan(small.bodyMultiple);
  });
});

describe("scanClosedBars / newestClosedTime", () => {
  const bars = [
    bar({ time: 1000 }),
    bar({ time: 2000, closed: false }),
    bar({ time: 3000 }),
    bar({ time: 4000, open: 101, close: 100, closed: true }), // red
  ];

  it("scans only closed bars and only ones newer than the watermark", () => {
    const all = scanClosedBars(bars, "BTCUSDT", "1m", 0);
    expect(all.map((s) => s.time)).toEqual([1000, 3000]);
    expect(scanClosedBars(bars, "BTCUSDT", "1m", 1000).map((s) => s.time)).toEqual([3000]);
  });

  it("marks the newest closed bar as the baseline, skipping the forming one", () => {
    // Baseline tracks closure, not qualification — the red bar at 4000 is closed.
    expect(newestClosedTime(bars)).toBe(4000);
    expect(newestClosedTime([])).toBe(0);
  });

  it("maps intervals to venue ms", () => {
    expect(intervalMs("1m")).toBe(60_000);
    expect(intervalMs("1h")).toBe(3_600_000);
  });
});
