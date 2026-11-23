/**
 * The universe rule: Bitcoin, plus altcoins priced strictly inside
 * $0.001–$7.00. Everything else stays out of the scanner.
 */

import { describe, expect, it } from "vitest";

import {
  BITCOIN_SYMBOL,
  PRICE_BAND_MAX,
  PRICE_BAND_MIN,
  bandPosition,
  inPriceBand,
  isTracked,
  pruneUntracked,
} from "@/lib/wick/universe";

describe("price band", () => {
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

describe("isTracked", () => {
  it("always keeps Bitcoin, whatever it costs", () => {
    expect(isTracked(BITCOIN_SYMBOL, 120_000)).toBe(true);
    expect(isTracked(BITCOIN_SYMBOL, 0)).toBe(true);
  });

  it("keeps altcoins only inside the band", () => {
    expect(isTracked("DOGEUSDT", 0.21)).toBe(true);
    expect(isTracked("1000PEPEUSDT", 0.0091)).toBe(true);
    expect(isTracked("XRPUSDT", 2.9)).toBe(true);
    expect(isTracked("ETHUSDT", 4_210)).toBe(false);
    expect(isTracked("SOLUSDT", 180)).toBe(false);
    expect(isTracked("ADAUSDT", 7)).toBe(false);
    expect(isTracked("ADAUSDT", 7.0001)).toBe(false);
    expect(isTracked("ADAUSDT", 6.98)).toBe(true);
  });

  it("drops a contract the moment it crosses out, and takes it back when it returns", () => {
    expect(isTracked("LINKUSDT", 6.99)).toBe(true);
    expect(isTracked("LINKUSDT", 7.02)).toBe(false);
    expect(isTracked("LINKUSDT", 6.97)).toBe(true);
  });
});

describe("pruneUntracked", () => {
  const stored = [
    { id: "a", symbol: "ETHUSDT", price: 4_100 },
    { id: "b", symbol: "BTCUSDT", price: 118_000 },
    { id: "c", symbol: "DOGEUSDT", price: 0.19 },
    { id: "d", symbol: "SOLUSDT", price: 0 },
    { id: "e", symbol: "BNBUSDT", price: 900 },
  ];

  it("removes records priced outside the band and keeps the rest", () => {
    expect(pruneUntracked(stored).map((x) => x.id)).toEqual(["b", "c", "d"]);
  });

  it("keeps unpriced records rather than guessing", () => {
    expect(pruneUntracked([{ symbol: "ETHUSDT", price: 0 }])).toHaveLength(1);
  });

  it("returns the same shape, untouched", () => {
    const kept = pruneUntracked(stored);
    expect(kept[0]).toBe(stored[1]);
  });
});
