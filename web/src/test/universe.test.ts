/**
 * V2 universe rule: exactly two instruments — BTCUSDT and USDCUSDT.
 * The legacy $0.001–$7.00 band helpers remain and are still exercised.
 */

import { describe, expect, it } from "vitest";

import {
  BITCOIN_SYMBOL,
  PRICE_BAND_MAX,
  PRICE_BAND_MIN,
  TRACKED_SYMBOLS,
  USDC_SYMBOL,
  UNIVERSE_LABEL,
  bandPosition,
  inPriceBand,
  isTracked,
  isTrackedSymbol,
  pruneUntracked,
} from "@/lib/wick/universe";

describe("price band (legacy helpers, still active)", () => {
  it("is strictly exclusive at both bounds", () => {
    expect(inPriceBand(PRICE_BAND_MIN)).toBe(false);
    expect(inPriceBand(PRICE_BAND_MAX)).toBe(false);
    expect(inPriceBand(0.0010001)).toBe(true);
    expect(inPriceBand(6.9999)).toBe(true);
    expect(inPriceBand(7.0001)).toBe(false);
    expect(inPriceBand(0.00099)).toBe(false);
  });

  it("rejects unpriced and nonsensical values", () => {
    expect(inPriceBand(0)).toBe(false);
    expect(inPriceBand(-1)).toBe(false);
    expect(inPriceBand(Number.NaN)).toBe(false);
    expect(inPriceBand(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("names where a price sits", () => {
    expect(bandPosition(0)).toBe("unpriced");
    expect(bandPosition(0.0005)).toBe("below");
    expect(bandPosition(0.001)).toBe("below");
    expect(bandPosition(0.5)).toBe("inside");
    expect(bandPosition(7)).toBe("above");
    expect(bandPosition(4_200)).toBe("above");
  });
});

describe("isTracked / isTrackedSymbol (V2 fixed list)", () => {
  it("tracks exactly BTCUSDT and USDCUSDT", () => {
    expect(TRACKED_SYMBOLS).toEqual([BITCOIN_SYMBOL, USDC_SYMBOL]);
    expect(UNIVERSE_LABEL).toBe("BTCUSDT · USDCUSDT");
  });

  it("accepts the two instruments at any price — the band no longer decides membership", () => {
    expect(isTracked("BTCUSDT", 120_000)).toBe(true);
    expect(isTracked("USDCUSDT", 1.0)).toBe(true);
    expect(isTracked("USDCUSDT", 0)).toBe(true);
    expect(isTrackedSymbol("BTCUSDT")).toBe(true);
    expect(isTrackedSymbol("USDCUSDT")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isTrackedSymbol("btcusdt")).toBe(true);
    expect(isTrackedSymbol("BtcUsDt")).toBe(true);
    expect(isTrackedSymbol("usdcusdt")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTrackedSymbol("ETHUSDT")).toBe(false);
    expect(isTrackedSymbol("SOLUSDT")).toBe(false);
    expect(isTrackedSymbol("DOGEUSDT")).toBe(false);
    expect(isTrackedSymbol("")).toBe(false);
    expect(isTracked("ETHUSDT", 4_210)).toBe(false);
    expect(isTracked("DOGEUSDT", 0.21)).toBe(false);
  });
});

describe("pruneUntracked", () => {
  const stored = [
    { id: "a", symbol: "ETHUSDT", price: 4_100 },
    { id: "b", symbol: "BTCUSDT", price: 118_000 },
    { id: "c", symbol: "USDCUSDT", price: 1.0 },
    { id: "d", symbol: "SOLUSDT", price: 0 },
    { id: "e", symbol: "BNBUSDT", price: 900 },
  ];

  it("removes records on untracked contracts and keeps the two instruments", () => {
    expect(pruneUntracked(stored).map((x) => x.id)).toEqual(["b", "c", "d"]);
  });

  it("keeps unpriced records rather than guessing", () => {
    expect(pruneUntracked([{ symbol: "BTCUSDT", price: 0 }])).toHaveLength(1);
    expect(pruneUntracked([{ symbol: "ETHUSDT", price: 0 }])).toHaveLength(1);
  });

  it("returns the same shape, untouched", () => {
    const kept = pruneUntracked(stored);
    expect(kept[0]).toBe(stored[1]);
  });
});
