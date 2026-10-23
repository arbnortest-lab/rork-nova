import { describe, expect, it } from "vitest";

import {
  CLUSTER_BIN_PCT,
  EMPTY_DEPTH,
  foldTrade,
  liquidationClusters,
  priceChangeOver,
  pruneBuckets,
  RADAR_WINDOW_MS,
  readDepth,
  readFlowWindow,
  readOiTrend,
  readSqueeze,
  readWalls,
  squeezeLevel,
  squeezeThresholds,
  WALL_STRENGTH,
  whaleThreshold,
  type MinuteBucket,
} from "@/lib/radar/micro";
import type { LiquidationEvent } from "@/lib/radar/types";
import type { AggTrade, BookLevel, BookSnapshot, OiPoint } from "@/lib/wick/types";

const MIN = 60_000;
/** 2023-11-14 22:13:20 UTC. */
const T = 1_700_000_000_000;
/** Weight of book level `i` in the weighted imbalance: e^(-i/6). */
const w = (i: number) => Math.exp(-i / 6);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function level(price: number, notional: number): BookLevel {
  return { price, qty: notional / price, notional };
}

/**
 * A 20-level book around 1.0000 with a 0.0001 tick: bids 0.9999 down, asks
 * 1.0001 up, every level `base` notional unless overridden by index.
 */
function book(opts: { base?: number; bids?: Record<number, number>; asks?: Record<number, number>; levels?: number } = {}): BookSnapshot {
  const base = opts.base ?? 100;
  const n = opts.levels ?? 20;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < n; i++) {
    bids.push(level(+(0.9999 - i * 0.0001).toFixed(4), opts.bids?.[i] ?? base));
    asks.push(level(+(1.0001 + i * 0.0001).toFixed(4), opts.asks?.[i] ?? base));
  }
  return { bids, asks, at: T };
}

function trade(at: number, price: number, notional: number, isBuy: boolean): AggTrade {
  return { price, qty: notional / price, notional, isBuy, at };
}

function liq(at: number, side: "BUY" | "SELL", price: number, notional: number): LiquidationEvent {
  return { symbol: "VETUSDT", side, price, qty: notional / price, notional, at };
}

function oi(at: number, openInterest: number, notional?: number): OiPoint {
  return { at, openInterest, notional };
}

/* ------------------------------------------------------------------ */
/* Depth                                                               */
/* ------------------------------------------------------------------ */

describe("readDepth", () => {
  it("returns the empty read for a missing or one-sided book", () => {
    expect(readDepth(undefined, [])).toBe(EMPTY_DEPTH);
    expect(readDepth({ bids: [], asks: [level(1, 1)], at: T }, [])).toBe(EMPTY_DEPTH);
    expect(readDepth({ bids: [level(1, 1)], asks: [], at: T }, [])).toBe(EMPTY_DEPTH);
    expect(EMPTY_DEPTH.pressure).toBe("balanced");
    expect(EMPTY_DEPTH.weightedBidShare).toBe(50);
  });

  it("reads a symmetric book as balanced at 50/50 with mid and spread from the touch", () => {
    const d = readDepth(book(), []);
    expect(d.mid).toBeCloseTo(1.0, 12);
    expect(d.spreadPct).toBeCloseTo(0.02, 9);
    expect(d.rawBidShare).toBeCloseTo(50, 9);
    expect(d.weightedBidShare).toBeCloseTo(50, 9);
    expect(d.pressure).toBe("balanced");
    expect(d.pressurePts).toBeCloseTo(0, 9);
    expect(d.bidNotional).toBe(2000);
    expect(d.askNotional).toBe(2000);
    expect(d.at).toBe(T);
  });

  it("weights levels by rank with e^(-i/6) so size at the touch moves the weighted share more than the raw one", () => {
    const d = readDepth(book({ bids: { 0: 1000 } }), []);
    const raw = ((1000 + 19 * 100) / (1000 + 19 * 100 + 2000)) * 100;
    let wBid = 1000 * w(0);
    for (let i = 1; i < 20; i++) wBid += 100 * w(i);
    let wAsk = 0;
    for (let i = 0; i < 20; i++) wAsk += 100 * w(i);
    const weighted = (wBid / (wBid + wAsk)) * 100;

    expect(d.rawBidShare).toBeCloseTo(raw, 9);
    expect(d.weightedBidShare).toBeCloseTo(weighted, 9);
    expect(d.weightedBidShare).toBeGreaterThan(d.rawBidShare);
    expect(d.pressure).toBe("bids");
    expect(d.pressurePts).toBeCloseTo(Math.abs(weighted * 2 - 100), 9);
  });

  it("discounts the same size parked at the back of the book", () => {
    const touch = readDepth(book({ asks: { 0: 1000 } }), []);
    const deep = readDepth(book({ asks: { 19: 1000 } }), []);
    expect(touch.rawBidShare).toBeCloseTo(deep.rawBidShare, 9);
    expect(touch.weightedBidShare).toBeLessThan(deep.weightedBidShare);
    expect(touch.pressure).toBe("asks");
    // 1000 at level 19 carries e^(-19/6) ~ 4% of its touch weight: not enough to tip the read.
    expect(deep.pressure).toBe("balanced");
  });

  it("calls anything inside 4 points of 50/50 balanced", () => {
    // Weighted share 51.9 -> 3.8 pts: balanced. 52.1 -> 4.2 pts: bids.
    const under = readDepth(book({ levels: 1, bids: { 0: 51.9 }, asks: { 0: 48.1 } }), []);
    const over = readDepth(book({ levels: 1, bids: { 0: 52.1 }, asks: { 0: 47.9 } }), []);
    expect(under.pressurePts).toBeCloseTo(3.8, 9);
    expect(under.pressure).toBe("balanced");
    expect(over.pressurePts).toBeCloseTo(4.2, 9);
    expect(over.pressure).toBe("bids");
  });

  it("accumulates totals from the touch outward and flags wall rows by side", () => {
    const snap = book({ bids: { 2: 900 } });
    const walls = readWalls(snap).book.walls;
    const d = readDepth(snap, walls);
    expect(d.bids.map((r) => r.total)).toEqual([100, 200, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800]);
    expect(d.bids[2].wall).toBe(true);
    expect(d.bids.filter((r) => r.wall)).toHaveLength(1);
    expect(d.asks.some((r) => r.wall)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Walls                                                               */
/* ------------------------------------------------------------------ */

describe("readWalls", () => {
  it("flags a level at or above 3x its side's mean notional and reports strength as that multiple", () => {
    const snap = book({ bids: { 5: 1000 } });
    const r = readWalls(snap);
    // mean = (19 * 100 + 1000) / 20 = 145
    expect(WALL_STRENGTH).toBe(3);
    expect(r.bid).toHaveLength(1);
    expect(r.bid[0].price).toBe(0.9994);
    expect(r.bid[0].strength).toBeCloseTo(1000 / 145, 9);
    expect(r.bid[0].distance).toBeCloseTo(-0.06, 6);
    expect(r.ask).toEqual([]);
    expect(r.book.dominantWall).toBe("buy");
  });

  it("measures each side on its own mean, so a thin side cannot inherit walls from a thick one", () => {
    const r = readWalls(book({ bids: { 0: 290 }, asks: { 0: 50, 1: 50, 2: 50, 3: 50 } }));
    // Bid mean = (290 + 1900) / 20 = 109.5 -> 290 is 2.65x: not a wall.
    expect(r.bid).toEqual([]);
    // Ask mean = (200 + 1600) / 20 = 90 -> a 100 level is 1.1x: not a wall either.
    expect(r.ask).toEqual([]);
  });

  it("orders walls nearest to price first on both sides", () => {
    const r = readWalls(book({ bids: { 8: 800, 3: 700 }, asks: { 6: 900, 1: 600 } }));
    expect(r.bid.map((x) => x.price)).toEqual([0.9996, 0.9991]);
    expect(r.ask.map((x) => x.price)).toEqual([1.0002, 1.0007]);
  });

  it("needs at least four levels a side before judging walls", () => {
    const r = readWalls(book({ levels: 3, bids: { 0: 10_000 } }));
    expect(r.bid).toEqual([]);
    expect(r.book.levels).toBe(6);
  });

  it("counts a wall that vanished without price reaching it as pulled", () => {
    const before = readWalls(book({ asks: { 4: 1000 } }));
    const after = readWalls(book(), { walls: before.book.walls, mid: before.book.mid ?? 1 });
    expect(after.book.pulled).toBe(1);
    expect(after.book.absorbed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Flow buckets                                                        */
/* ------------------------------------------------------------------ */

describe("flow buckets", () => {
  const M = Math.floor(T / MIN) * MIN;

  it("folds prints into their minute with buy/sell notional, counts and whale tallies", () => {
    const buckets = new Map<number, MinuteBucket>();
    foldTrade(buckets, trade(M + 1_000, 0.0230, 100, true), 1_000);
    foldTrade(buckets, trade(M + 2_000, 0.0231, 50, false), 1_000);
    foldTrade(buckets, trade(M + 3_000, 0.0232, 2_000, true), 1_000);
    foldTrade(buckets, trade(M + 59_999, 0.0233, 1_000, false), 1_000);
    foldTrade(buckets, trade(M + 60_000, 0.0234, 10, true), 1_000);

    expect([...buckets.keys()]).toEqual([M, M + MIN]);
    expect(buckets.get(M)).toEqual({ minute: M, buy: 2_100, sell: 1_050, count: 4, whaleBuys: 1, whaleSells: 1, open: 0.023, close: 0.0233 });
    expect(buckets.get(M + MIN)).toMatchObject({ buy: 10, sell: 0, count: 1, open: 0.0234, close: 0.0234 });
  });

  it("sums the rolling hour and drops buckets that fall outside it", () => {
    const buckets = new Map<number, MinuteBucket>();
    foldTrade(buckets, trade(M, 1, 300, true), 1e9);
    foldTrade(buckets, trade(M + 30 * MIN, 1, 100, false), 1e9);
    const inside = readFlowWindow(buckets, M + 59 * MIN);
    expect(inside).toEqual({ buy: 300, sell: 100, count: 2, buyShare: 75, minutes: 2, whaleBuys: 0, whaleSells: 0 });

    // A bucket leaves the window once its whole minute is older than an hour.
    const later = readFlowWindow(buckets, M + 61 * MIN + 1);
    expect(later).toMatchObject({ buy: 0, sell: 100, count: 1, buyShare: 0, minutes: 1 });
    expect(readFlowWindow(new Map(), M).buyShare).toBe(50);

    pruneBuckets(buckets, M + 61 * MIN + 1);
    expect([...buckets.keys()]).toEqual([M + 30 * MIN]);
    expect(RADAR_WINDOW_MS).toBe(60 * MIN);
  });

  it("measures price change from the open of the bucket N minutes back to the latest close", () => {
    const buckets = new Map<number, MinuteBucket>();
    foldTrade(buckets, trade(M, 1.0, 1, true), 1e9);
    foldTrade(buckets, trade(M + 15 * MIN + 5_000, 1.1, 1, true), 1e9);
    expect(priceChangeOver(buckets, M + 15 * MIN + 30_000, 15)).toBeCloseTo(10, 9);
    // The latest bucket may be the current or the previous minute, no older.
    expect(priceChangeOver(buckets, M + 16 * MIN + 30_000, 16)).toBeCloseTo(10, 9);
    expect(priceChangeOver(buckets, M + 17 * MIN + 30_000, 17)).toBeUndefined();
    // The far end tolerates up to two empty minutes forward of the target.
    expect(priceChangeOver(buckets, M + 16 * MIN + 30_000, 17)).toBeCloseTo(10, 9);
    expect(priceChangeOver(buckets, M + 16 * MIN + 30_000, 18)).toBeCloseTo(10, 9);
    expect(priceChangeOver(buckets, M + 16 * MIN + 30_000, 19)).toBeUndefined();
    expect(priceChangeOver(buckets, M + 40 * MIN, 15)).toBeUndefined();
    expect(priceChangeOver(new Map(), M, 15)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Whale threshold                                                     */
/* ------------------------------------------------------------------ */

describe("whaleThreshold", () => {
  const prints = (n: number, notional: number) => Array.from({ length: n }, (_, i) => trade(T + i, 1, notional, i % 2 === 0));

  it("is $1,000 with no turnover and no tape", () => {
    expect(whaleThreshold([])).toBe(1_000);
    expect(whaleThreshold([], 0)).toBe(1_000);
  });

  it("scales the floor with 0.35 x sqrt(24h turnover)", () => {
    expect(whaleThreshold([], 400_000_000)).toBeCloseTo(0.35 * 20_000, 9);
    expect(whaleThreshold([], 20_000_000_000)).toBeCloseTo(0.35 * Math.sqrt(20e9), 6);
    // A $50M/day contract: 0.35 x 7071 ~ $2.5K.
    expect(whaleThreshold([], 50_000_000)).toBeCloseTo(2474.87, 1);
  });

  it("never drops under $1,000 on a thin alt", () => {
    expect(whaleThreshold([], 1_000_000)).toBe(1_000);
    expect(whaleThreshold([], 5_000_000)).toBe(1_000);
    expect(whaleThreshold([], 8_163_265)).toBeCloseTo(1_000, 0);
  });

  it("survives a missing or malformed turnover instead of returning NaN", () => {
    expect(whaleThreshold([], Number.NaN)).toBe(1_000);
    expect(whaleThreshold([], -5)).toBe(1_000);
    expect(whaleThreshold([], Number.POSITIVE_INFINITY)).toBe(1_000);
    expect(squeezeThresholds(Number.NaN)).toEqual({ medAt: 1_000, highAt: 5_000 });
  });

  it("uses fifteen times the median print once twenty prints are on the tape", () => {
    expect(whaleThreshold(prints(19, 500), 0)).toBe(1_000);
    expect(whaleThreshold(prints(20, 500), 0)).toBe(7_500);
    expect(whaleThreshold(prints(20, 10), 0)).toBe(1_000);
    // Median beats the turnover floor only when it is the larger of the two.
    expect(whaleThreshold(prints(20, 500), 400_000_000)).toBe(7_500);
    expect(whaleThreshold(prints(20, 400), 400_000_000)).toBeCloseTo(7_000, 9);
  });

  it("takes the upper median of an even tape", () => {
    const tape = [...prints(10, 10), ...prints(10, 1_000)];
    expect(whaleThreshold(tape, 0)).toBe(15_000);
  });
});

/* ------------------------------------------------------------------ */
/* Squeeze                                                             */
/* ------------------------------------------------------------------ */

describe("squeeze", () => {
  it("derives warm and hot lines from 2.5% and 25% of an average hour's turnover, with floors", () => {
    expect(squeezeThresholds(0)).toEqual({ medAt: 1_000, highAt: 5_000 });
    expect(squeezeThresholds(24_000_000)).toEqual({ medAt: 25_000, highAt: 250_000 });
    const alt = squeezeThresholds(5_000_000);
    expect(alt.medAt).toBeCloseTo(5_208.33, 2);
    expect(alt.highAt).toBeCloseTo(52_083.33, 2);
    expect(squeezeThresholds(2_000_000_000)).toEqual({ medAt: 2_083_333.3333333333, highAt: 20_833_333.333333332 });
  });

  it("grades volume against the lines inclusively", () => {
    expect(squeezeLevel(999, 1_000, 5_000)).toBe("cold");
    expect(squeezeLevel(1_000, 1_000, 5_000)).toBe("warm");
    expect(squeezeLevel(4_999, 1_000, 5_000)).toBe("warm");
    expect(squeezeLevel(5_000, 1_000, 5_000)).toBe("hot");
  });

  it("sums forced buys as shorts liquidated and forced sells as longs, inside the hour only", () => {
    const liqs = [
      liq(T - 70 * MIN, "BUY", 0.024, 50_000),
      liq(T - 50 * MIN, "BUY", 0.024, 300),
      liq(T - 10 * MIN, "BUY", 0.0241, 400),
      liq(T - 1 * MIN, "SELL", 0.0238, 100),
    ];
    const s = readSqueeze(liqs, 0, T);
    expect(s.volume).toBe(800);
    expect(s.shortLiq).toBe(700);
    expect(s.longLiq).toBe(100);
    expect(s.count).toBe(3);
    expect(s.lastAt).toBe(T - MIN);
    expect(s.level).toBe("cold");
    expect(s.direction).toBe("short-squeeze");
    expect(s.medAt).toBe(1_000);
    expect(s.highAt).toBe(5_000);
  });

  it("calls direction from the short share: >= 65% squeeze, <= 35% flush, otherwise mixed", () => {
    expect(readSqueeze([liq(T, "BUY", 1, 65), liq(T, "SELL", 1, 35)], 0, T).direction).toBe("short-squeeze");
    expect(readSqueeze([liq(T, "BUY", 1, 64), liq(T, "SELL", 1, 36)], 0, T).direction).toBe("mixed");
    expect(readSqueeze([liq(T, "BUY", 1, 35), liq(T, "SELL", 1, 65)], 0, T).direction).toBe("long-flush");
    expect(readSqueeze([liq(T, "BUY", 1, 36), liq(T, "SELL", 1, 64)], 0, T).direction).toBe("mixed");
    expect(readSqueeze([], 0, T)).toMatchObject({ volume: 0, direction: "none", level: "cold", count: 0, lastAt: undefined });
  });

  it("reads hot on a thin alt from a few thousand dollars and cold on a major from the same", () => {
    const liqs = [liq(T, "BUY", 1, 6_000)];
    expect(readSqueeze(liqs, 5_000_000, T).level).toBe("warm");
    expect(readSqueeze(liqs, 500_000, T).level).toBe("hot");
    expect(readSqueeze(liqs, 20_000_000_000, T).level).toBe("cold");
  });
});

/* ------------------------------------------------------------------ */
/* Liquidation clusters                                                */
/* ------------------------------------------------------------------ */

describe("liquidationClusters", () => {
  it("bins forced orders in 0.2% price buckets anchored on the current price", () => {
    expect(CLUSTER_BIN_PCT).toBe(0.2);
    const liqs = [
      liq(T - MIN, "SELL", 1.0004, 300),
      liq(T - MIN, "BUY", 1.0007, 100),
      liq(T - 2 * MIN, "BUY", 1.0041, 500),
      liq(T - 3 * MIN, "SELL", 0.9962, 200),
    ];
    const c = liquidationClusters(liqs, 1.0, T);
    expect(c.map((x) => x.price)).toEqual([1.004, 1.0, 0.996]);
    expect(c[0]).toMatchObject({ notional: 500, shortLiq: 500, longLiq: 0, count: 1 });
    expect(c[0].lo).toBeCloseTo(1.003, 12);
    expect(c[0].hi).toBeCloseTo(1.005, 12);
    expect(c[0].distancePct).toBeCloseTo(0.4, 9);
    expect(c[0].share).toBeCloseTo(500 / 1100, 12);
    expect(c[1]).toMatchObject({ notional: 400, longLiq: 300, shortLiq: 100, count: 2, distancePct: 0 });
    expect(c[2].distancePct).toBeCloseTo(-0.4, 9);
    expect(c.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 12);
  });

  it("keeps the heaviest buckets only and shares against everything in the window", () => {
    const liqs = Array.from({ length: 10 }, (_, i) => liq(T, "BUY", 1 + i * 0.01, 100 * (i + 1)));
    const c = liquidationClusters(liqs, 1, T);
    expect(c).toHaveLength(6);
    expect(c.map((x) => x.notional)).toEqual([1000, 900, 800, 700, 600, 500]);
    expect(c[0].share).toBeCloseTo(1000 / 5500, 12);
    expect(liquidationClusters(liqs, 1, T, RADAR_WINDOW_MS, CLUSTER_BIN_PCT, 2)).toHaveLength(2);
  });

  it("ignores stale events, zero prices and a missing current price", () => {
    const liqs = [liq(T - 61 * MIN, "BUY", 1, 100), liq(T, "BUY", 0, 100), liq(T, "BUY", 1.001, 100)];
    expect(liquidationClusters(liqs, 1, T)).toHaveLength(1);
    expect(liquidationClusters(liqs, 0, T)).toEqual([]);
    expect(liquidationClusters([], 1, T)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Open interest                                                       */
/* ------------------------------------------------------------------ */

describe("readOiTrend", () => {
  const series = (values: number[]) => values.map((v, i) => oi(T + i * 5 * MIN, v));

  it("fits a least-squares slope over the last six points and reports it as percent of mean OI", () => {
    const r = readOiTrend(series([1000, 1010, 1020, 1030, 1040, 1050]), undefined, 2, 0);
    // beta = 10 per point, spanned over 5 steps = 50, over mean 1025.
    expect(r.slopePct).toBeCloseTo((50 / 1025) * 100, 9);
    expect(r.trend).toBe("rising");
    expect(r.snapshots).toBe(6);
    expect(r.current).toBe(1050);
    expect(r.notionalUsd).toBe(2100);
    expect(r.at).toBe(T + 25 * MIN);
  });

  it("uses only the newest six points", () => {
    const r = readOiTrend(series([5000, 5000, 5000, 1000, 1000, 1000, 1000, 1000, 1000]), undefined, 1, 0);
    expect(r.slopePct).toBeCloseTo(0, 9);
    expect(r.trend).toBe("flat");
  });

  it("calls flat inside +/-0.1% and falling below it", () => {
    expect(readOiTrend(series([1000, 1000.1, 1000.2, 1000.3, 1000.4, 1000.5]), undefined, 1, 0).trend).toBe("flat");
    expect(readOiTrend(series([1050, 1040, 1030, 1020, 1010, 1000]), undefined, 1, 0).trend).toBe("falling");
  });

  it("needs three points for a slope and reports unknown until then", () => {
    const r = readOiTrend(series([1000, 1100]), undefined, 1, 0);
    expect(r.trend).toBe("unknown");
    expect(r.slopePct).toBeUndefined();
    expect(r.snapshots).toBe(2);
    expect(readOiTrend([], undefined, 1, 0)).toMatchObject({ trend: "unknown", snapshots: 0, current: undefined, notionalUsd: undefined });
  });

  it("appends the live reading only when it is more than a minute newer than the last snapshot", () => {
    const hist = series([1000, 1010, 1020]);
    const last = hist[hist.length - 1].at;
    expect(readOiTrend(hist, oi(last + 30_000, 1500), 1, 0).snapshots).toBe(3);
    expect(readOiTrend(hist, oi(last + 61_000, 1500), 1, 0).snapshots).toBe(4);
    expect(readOiTrend([], oi(T, 1500), 1, 0)).toMatchObject({ snapshots: 1, current: 1500, trend: "unknown" });
  });

  it("prefers the venue's notional and falls back to contracts x price", () => {
    expect(readOiTrend([oi(T, 1000, 12_345)], undefined, 2, 0).notionalUsd).toBe(12_345);
    expect(readOiTrend([oi(T, 1000)], undefined, 2, 0).notionalUsd).toBe(2000);
    expect(readOiTrend([oi(T, 1000)], undefined, 0, 0).notionalUsd).toBeUndefined();
  });

  it("passes the price move through to the regime read", () => {
    const up = readOiTrend(series([1000, 1000, 1000, 1000, 1000, 1010]), undefined, 1, 0.5);
    expect(up.read.regime).toBe("new-longs");
    const down = readOiTrend(series([1000, 1000, 1000, 1000, 1000, 1010]), undefined, 1, -0.5);
    expect(down.read.regime).toBe("new-shorts");
  });
});
