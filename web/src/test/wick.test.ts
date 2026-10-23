import { describe, expect, it } from "vitest";

import {
  readBook,
  readFlow,
  readFunding,
  readOpenInterest,
  readVolume,
  type VolumeSample,
} from "@/lib/wick/engines";
import {
  candidacy,
  evaluateExhaustion,
  findTrap,
  headlineOf,
  readExtreme,
  readHorizon,
  reasonsOf,
  wickShare,
  type ExhaustionInput,
} from "@/lib/wick/exhaustion";
import { isUsdtPerp } from "@/lib/wick/feed";
import { atrPct, findPivots, readLiquidity, readProfile, readStructure, readVwap } from "@/lib/wick/levels";
import { DEFAULT_WICK_RULES, RVOL_LOOKBACK, sanitizeWickRules } from "@/lib/wick/rules";
import type {
  AggTrade,
  BookSnapshot,
  GateKey,
  Kline,
  MarkTick,
  OiPoint,
  TickerTick,
  VolumeRead,
  Wall,
} from "@/lib/wick/types";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_700_000_000_000;
const RULES = DEFAULT_WICK_RULES;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function ticker(patch: Partial<TickerTick> = {}): TickerTick {
  return {
    symbol: "BTCUSDT",
    last: 100,
    open: 100,
    high: 102,
    low: 98,
    vwap24h: 100,
    quoteVolume: 86_400_000,
    trades: 100_000,
    at: T,
    ...patch,
  };
}

/** Klines from a list of highs; low = high - 2, close = high - 1. */
function bars(highs: number[], stepMs = 5 * MIN, startAt = T - highs.length * 5 * MIN): Kline[] {
  return highs.map((h, i) => ({
    openTime: startAt + i * stepMs,
    open: h - 1,
    high: h,
    low: h - 2,
    close: h - 1,
    volume: 100,
    quoteVolume: 100 * (h - 1),
    trades: 50,
  }));
}

function trade(at: number, price: number, notional: number, isBuy: boolean): AggTrade {
  return { at, price, notional, qty: notional / price, isBuy };
}

/** Bullish zigzag with pivot highs at 110/118/126 and pivot lows at 101/109. */
const BULL_HIGHS = [
  100, 102, 104, 106, 110, 108, 105, 103, 108, 112, 118, 116, 113, 111, 116, 120, 126, 124, 121, 119, 124,
];

/* ------------------------------------------------------------------ */
/* Exhaustion fixtures                                                 */
/* ------------------------------------------------------------------ */

function volume(patch: Partial<VolumeRead> = {}): VolumeRead {
  return {
    quoteVolume24h: 86_400_000,
    trades24h: 1_000,
    rvol: 100,
    spike: false,
    acceleration: 0,
    precise: true,
    ...patch,
  };
}

/**
 * One candle. `wick` is the share of the range the rejection takes, so a trap
 * bar can be described by intent rather than by arithmetic.
 */
function candle(openTime: number, low: number, high: number, opts: { wick?: number } = {}): Kline {
  const range = high - low;
  const share = opts.wick ?? 0.2;
  // Body sits below the rejected high by exactly `share` of the range.
  const body = high - range * share;
  return {
    openTime,
    open: body - range * 0.05,
    high,
    low,
    close: body,
    volume: 100,
    quoteVolume: 100 * body,
    trades: 50,
  };
}

/** A flat base of 18 bars, so a trap bar appended to it is a genuine extension. */
function base(level = 100, count = 18): Kline[] {
  return Array.from({ length: count }, (_, i) =>
    candle(T - (count - i) * 5 * MIN, level - 1, level + 1, { wick: 0.2 }),
  );
}

/** Daily bars whose highest high and lowest low are exactly `high` / `low`. */
function dailyBars(high: number, low: number, days = 40): Kline[] {
  return Array.from({ length: days }, (_, i) => ({
    openTime: T - (days - i) * 86_400_000,
    open: (high + low) / 2,
    high: i === days - 1 ? high : high - 5,
    low: i === 0 ? low : low + 5,
    close: (high + low) / 2,
    volume: 1_000,
    quoteVolume: 1_000 * ((high + low) / 2),
    trades: 500,
  }));
}

/**
 * An input with all four gates passing for a short at the 24h high, so each
 * test can break exactly one thing and prove that gate is load-bearing.
 */
function armedShort(patch: Partial<ExhaustionInput> = {}): ExhaustionInput {
  const klines = [...base(100), candle(T - 5 * MIN, 99, 110, { wick: 0.6 })];
  return {
    symbol: "BTCUSDT",
    ticker: ticker({ last: 110, high: 110, low: 90, open: 95, quoteVolume: 500_000_000 }),
    volume: volume({ rvol: 500, acceleration: -40, spike: true }),
    klines,
    daily: dailyBars(110, 40),
    rules: RULES,
    at: T,
    ...patch,
  };
}

function gateOf(read: { gates: { key: GateKey; passed: boolean }[] }, key: GateKey): boolean {
  return read.gates.find((g) => g.key === key)?.passed ?? false;
}

/* ------------------------------------------------------------------ */
/* Universe filter                                                     */
/* ------------------------------------------------------------------ */

describe("USDT perpetual filter", () => {
  it("accepts plain USDT perpetuals", () => {
    expect(isUsdtPerp("BTCUSDT")).toBe(true);
    expect(isUsdtPerp("1000PEPEUSDT")).toBe(true);
  });

  it("rejects dated contracts, USDC margin and COIN-M", () => {
    expect(isUsdtPerp("BTCUSDT_260925")).toBe(false);
    expect(isUsdtPerp("BTCUSDC")).toBe(false);
    expect(isUsdtPerp("BTCUSD_PERP")).toBe(false);
    expect(isUsdtPerp("ETHUSD")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 1 — Open interest                                                   */
/* ------------------------------------------------------------------ */

describe("open interest engine", () => {
  const points: OiPoint[] = [
    { at: T - 60 * MIN, openInterest: 1000 },
    { at: T - 15 * MIN, openInterest: 1100 },
    { at: T, openInterest: 1200, notional: 120_000 },
  ];

  it("computes each window it has history for and leaves the rest undefined", () => {
    const read = readOpenInterest(points, 1);
    expect(read.change15m).toBeCloseTo(9.09, 1);
    expect(read.change1h).toBeCloseTo(20, 5);
    // 24h of history was never sampled — that must not read as 0%.
    expect(read.change1d).toBeUndefined();
    expect(read.change4h).toBeUndefined();
    expect(read.openInterest).toBe(1200);
    expect(read.notional).toBe(120_000);
  });

  it("prefers the 15m window for the headline", () => {
    const read = readOpenInterest(points, 1);
    expect(read.headlineWindowMins).toBe(15);
    expect(read.headlineChange).toBeCloseTo(9.09, 1);
  });

  it("maps the price/OI matrix", () => {
    expect(readOpenInterest(points, 1).regime).toBe("new-longs");
    expect(readOpenInterest(points, -1).regime).toBe("new-shorts");

    const falling: OiPoint[] = [
      { at: T - 15 * MIN, openInterest: 1200 },
      { at: T, openInterest: 1000 },
    ];
    expect(readOpenInterest(falling, 1).regime).toBe("short-covering");
    expect(readOpenInterest(falling, -1).regime).toBe("long-liquidation");
  });

  it("reads flat when neither side is moving", () => {
    const flat: OiPoint[] = [
      { at: T - 15 * MIN, openInterest: 1000 },
      { at: T, openInterest: 1000 },
    ];
    expect(readOpenInterest(flat, 0).regime).toBe("flat");
  });

  it("returns an empty read with no samples", () => {
    const read = readOpenInterest([], 5);
    expect(read.openInterest).toBeUndefined();
    expect(read.headlineChange).toBeUndefined();
    expect(read.points).toBe(0);
  });

  it("only computes a window when a sample sits near its start", () => {
    // One reading 25h old plus one now. The daily window has a valid baseline;
    // the short windows must stay unmeasured rather than reuse the 25h sample.
    const stale: OiPoint[] = [
      { at: T - 25 * 60 * MIN, openInterest: 500 },
      { at: T, openInterest: 900 },
    ];
    const read = readOpenInterest(stale, 1);
    expect(read.change1d).toBeCloseTo(80, 5);
    expect(read.change15m).toBeUndefined();
    expect(read.change1h).toBeUndefined();
    expect(read.change4h).toBeUndefined();
    expect(read.headlineWindowMins).toBe(1440);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — Funding                                                         */
/* ------------------------------------------------------------------ */

describe("funding engine", () => {
  function mark(rate: number, next = T + 3 * 3_600_000): MarkTick {
    return { symbol: "BTCUSDT", markPrice: 100.05, indexPrice: 100, fundingRate: rate, nextFundingTime: next, at: T };
  }

  it("flags crowded longs and annualises the rate", () => {
    const read = readFunding(mark(0.083), [], 0.05, T);
    expect(read.extreme).toBe(true);
    expect(read.crowd).toBe("longs");
    // Three settlements a day.
    expect(read.annualised).toBeCloseTo(0.083 * 3 * 365, 5);
    expect(read.countdownMs).toBe(3 * 3_600_000);
  });

  it("flags crowded shorts on deeply negative funding", () => {
    const read = readFunding(mark(-0.12), [], 0.05, T);
    expect(read.crowd).toBe("shorts");
    expect(read.extreme).toBe(true);
  });

  it("stays balanced inside the threshold", () => {
    const read = readFunding(mark(0.01), [], 0.05, T);
    expect(read.crowd).toBe("balanced");
    expect(read.extreme).toBe(false);
  });

  it("computes mark-vs-index basis and averages history", () => {
    const read = readFunding(mark(0.02), [0.01, 0.03, 0.05], 0.05, T);
    expect(read.basis).toBeCloseTo(0.05, 5);
    expect(read.average).toBeCloseTo(0.03, 5);
  });

  it("drops the countdown once the settlement has passed", () => {
    expect(readFunding(mark(0.02, T - 1000), [], 0.05, T).countdownMs).toBeUndefined();
  });

  it("returns an unmeasured read with no mark tick", () => {
    const read = readFunding(undefined, [], 0.05, T);
    expect(read.rate).toBeUndefined();
    expect(read.crowd).toBe("balanced");
  });
});

/* ------------------------------------------------------------------ */
/* 3 — Volume                                                          */
/* ------------------------------------------------------------------ */

describe("volume engine", () => {
  it("scales a partial kline up to a full bar before comparing", () => {
    // Seven completed bars at 100, current bar half elapsed with 50 traded.
    const history: Kline[] = Array.from({ length: 7 }, (_, i) => ({
      openTime: T - (8 - i) * 5 * MIN,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      quoteVolume: 100,
      trades: 10,
    }));
    const current: Kline = { ...history[0], openTime: T - 2.5 * MIN, quoteVolume: 50, trades: 5 };
    const read = readVolume(ticker(), [], [...history, current], 250);
    expect(read.precise).toBe(true);
    expect(read.rvol).toBeCloseTo(100, 0);
    expect(read.spike).toBe(false);
  });

  it("marks a spike when the projected bar runs hot", () => {
    const history: Kline[] = Array.from({ length: 7 }, (_, i) => ({
      openTime: T - (8 - i) * 5 * MIN,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      quoteVolume: 100,
      trades: 10,
    }));
    const current: Kline = { ...history[0], openTime: T - 2.5 * MIN, quoteVolume: 200, trades: 40 };
    const read = readVolume(ticker(), [], [...history, current], 250);
    expect(read.rvol).toBeCloseTo(400, 0);
    expect(read.spike).toBe(true);
  });

  it(`measures the baseline over the newest ${RVOL_LOOKBACK} bars, not the whole series`, () => {
    // 400 quiet bars, then 100 busy ones. The busy stretch is the current
    // regime, and the newest bar matches it exactly, so RVOL is ~100%.
    // Averaging all 499 completed bars instead would compare this bar against a
    // regime that ended hours ago and report a 3.5x climax out of nothing —
    // which is how a quiet-then-active contract used to fake gate 2.
    const series: Kline[] = Array.from({ length: 500 }, (_, i) => {
      const qv = i < 400 ? 100 : 1_000;
      return {
        openTime: T + i * 5 * MIN,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: qv / 100,
        quoteVolume: qv,
        trades: 50,
      };
    });
    const current = series[series.length - 1];
    const read = readVolume(ticker({ at: current.openTime + 5 * MIN }), [], series, 300);

    expect(read.precise).toBe(true);
    expect(read.rvol).toBeCloseTo(100, 0);
    expect(read.spike).toBe(false);
  });

  it("still reports a genuine climax against the recent regime", () => {
    // Same recent regime, but this bar is four times it. That is a real spike.
    const series: Kline[] = Array.from({ length: 500 }, (_, i) => ({
      openTime: T + i * 5 * MIN,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      quoteVolume: i === 499 ? 4_000 : 1_000,
      trades: 50,
    }));
    const current = series[series.length - 1];
    const read = readVolume(ticker({ at: current.openTime + 5 * MIN }), [], series, 300);

    expect(read.rvol).toBeCloseTo(400, 0);
    expect(read.spike).toBe(true);
  });

  it("differentiates the rolling 24h counter when klines are absent", () => {
    const samples: VolumeSample[] = [
      { at: T - 60_000, quoteVolume: 1_000_000, trades: 100 },
      { at: T, quoteVolume: 1_120_000, trades: 200 },
    ];
    // 86.4M over 24h = $1,000/s baseline; 120k in 60s = $2,000/s.
    const read = readVolume(ticker(), samples, undefined, 250);
    expect(read.precise).toBe(false);
    expect(read.rvol).toBeCloseTo(200, 5);
    expect(read.tradeRate).toBeCloseTo(100 / 60, 5);
  });

  it("reports no RVOL when the rolling counter went backwards", () => {
    // Volume from 24h ago rolling off can exceed volume traded now.
    const samples: VolumeSample[] = [
      { at: T - 60_000, quoteVolume: 1_200_000, trades: 100 },
      { at: T, quoteVolume: 1_000_000, trades: 120 },
    ];
    expect(readVolume(ticker(), samples, undefined, 250).rvol).toBeUndefined();
  });

  it("waits for a wide enough sample window", () => {
    const samples: VolumeSample[] = [
      { at: T - 2_000, quoteVolume: 1_000_000, trades: 100 },
      { at: T, quoteVolume: 1_500_000, trades: 200 },
    ];
    expect(readVolume(ticker(), samples, undefined, 250).rvol).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 4 + 5 — Trade flow and delta                                        */
/* ------------------------------------------------------------------ */

describe("trade flow and delta engine", () => {
  it("splits aggressive buying from selling and reports the share", () => {
    const trades: AggTrade[] = [
      trade(T - 3000, 100, 6_000, true),
      trade(T - 2000, 100, 4_000, false),
      trade(T - 1000, 100, 0, true),
    ];
    const read = readFlow(trades, 1_000_000);
    expect(read.buyVolume).toBe(6_000);
    expect(read.sellVolume).toBe(4_000);
    expect(read.buyShare).toBeCloseTo(60, 5);
    expect(read.delta).toBe(2_000);
    expect(read.imbalance).toBeCloseTo(0.2, 5);
  });

  it("counts large prints on each side against the supplied bar", () => {
    const trades: AggTrade[] = [
      trade(T - 3000, 100, 250_000, true),
      trade(T - 2000, 100, 300_000, false),
      trade(T - 1000, 100, 1_000, true),
    ];
    const read = readFlow(trades, 200_000);
    expect(read.largeBuys).toBe(1);
    expect(read.largeSells).toBe(1);
    expect(read.largestNotional).toBe(300_000);
  });

  it("carries a CVD base forward so the curve survives buffer trimming", () => {
    const trades: AggTrade[] = [trade(T, 100, 5_000, true)];
    expect(readFlow(trades, 1e9, 40_000).cvd).toBe(45_000);
  });

  it("detects bearish divergence when price makes a higher high on weaker delta", () => {
    const trades: AggTrade[] = [];
    let at = T - 120_000;
    // Phase 1: price 100 -> 103 on steady buying.
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 100 + (i / 39) * 3, 1_000, true));
      at += 1_000;
    }
    // Phase 2: pull back to 101 on selling — delta gives up most of its gain.
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 103 - (i / 39) * 2, 750, false));
      at += 1_000;
    }
    // Phase 3: new high at 104, but on much weaker buying.
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 101 + (i / 39) * 3, 375, true));
      at += 1_000;
    }

    const read = readFlow(trades, 1e9);
    expect(read.divergence).toBe("bearish");
    expect(read.samples).toBe(120);
    expect(read.cvdSeries.length).toBeGreaterThanOrEqual(6);
  });

  it("detects bullish divergence on the mirror case", () => {
    const trades: AggTrade[] = [];
    let at = T - 120_000;
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 100 - (i / 39) * 3, 1_000, false));
      at += 1_000;
    }
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 97 + (i / 39) * 2, 750, true));
      at += 1_000;
    }
    for (let i = 0; i < 40; i += 1) {
      trades.push(trade(at, 99 - (i / 39) * 3, 375, false));
      at += 1_000;
    }
    expect(readFlow(trades, 1e9).divergence).toBe("bullish");
  });

  it("flags absorption when one-sided aggression cannot move price", () => {
    const trades: AggTrade[] = [];
    for (let i = 0; i < 60; i += 1) trades.push(trade(T - 60_000 + i * 1_000, 100, 5_000, true));
    const read = readFlow(trades, 1e9);
    expect(read.absorption).toBe("upper");
    expect(read.imbalance).toBeCloseTo(1, 5);
  });

  it("does not call absorption when price actually moved", () => {
    const trades: AggTrade[] = [];
    for (let i = 0; i < 60; i += 1) trades.push(trade(T - 60_000 + i * 1_000, 100 + i * 0.1, 5_000, true));
    expect(readFlow(trades, 1e9).absorption).toBe("none");
  });

  it("returns an empty read with no trades", () => {
    const read = readFlow([], 1_000);
    expect(read.samples).toBe(0);
    expect(read.buyShare).toBe(50);
    expect(read.divergence).toBe("none");
  });
});

/* ------------------------------------------------------------------ */
/* 6 — Order book                                                      */
/* ------------------------------------------------------------------ */

describe("order book engine", () => {
  const snapshot: BookSnapshot = {
    bids: [
      { price: 100, qty: 1, notional: 100 },
      { price: 99, qty: 1, notional: 99 },
      { price: 98, qty: 1, notional: 98 },
      { price: 97, qty: 1, notional: 97 },
    ],
    asks: [
      { price: 101, qty: 1, notional: 101 },
      { price: 102, qty: 1, notional: 102 },
      { price: 103, qty: 1, notional: 103 },
      { price: 104, qty: 40, notional: 4_160 },
    ],
    at: T,
  };

  it("finds the dominant wall and measures it against the book", () => {
    const read = readBook(snapshot, 3);
    expect(read.dominantWall).toBe("sell");
    expect(read.wall?.price).toBe(104);
    expect(read.wall?.strength).toBeGreaterThan(3);
    expect(read.wall?.distance).toBeCloseTo(3.48, 1);
    expect(read.mid).toBeCloseTo(100.5, 5);
    // Asks massively outweigh bids here.
    expect(read.imbalance).toBeLessThan(-0.5);
  });

  it("respects the strength threshold", () => {
    expect(readBook(snapshot, 20).wall).toBeUndefined();
    expect(readBook(snapshot, 20).dominantWall).toBe("none");
  });

  it("calls a vanished wall pulled when price never reached it", () => {
    const previous = { walls: [{ side: "sell", price: 104, notional: 4_160, strength: 4, distance: 3.5 } as Wall], mid: 100.5 };
    const thin: BookSnapshot = { ...snapshot, asks: snapshot.asks.map((a) => ({ ...a, qty: 1, notional: a.price })) };
    const read = readBook(thin, 3, previous);
    expect(read.pulled).toBe(1);
    expect(read.absorbed).toBe(false);
  });

  it("calls it absorbed when price traded through instead", () => {
    const previous = { walls: [{ side: "sell", price: 104, notional: 4_160, strength: 4, distance: 3.5 } as Wall], mid: 100.5 };
    const through: BookSnapshot = {
      bids: [
        { price: 104.5, qty: 1, notional: 104.5 },
        { price: 104.4, qty: 1, notional: 104.4 },
        { price: 104.3, qty: 1, notional: 104.3 },
        { price: 104.2, qty: 1, notional: 104.2 },
      ],
      asks: [
        { price: 104.6, qty: 1, notional: 104.6 },
        { price: 104.7, qty: 1, notional: 104.7 },
        { price: 104.8, qty: 1, notional: 104.8 },
        { price: 104.9, qty: 1, notional: 104.9 },
      ],
      at: T,
    };
    const read = readBook(through, 3, previous);
    expect(read.absorbed).toBe(true);
    expect(read.pulled).toBe(0);
  });

  it("suspects spoofing when several walls vanish untouched", () => {
    const previous = {
      walls: [
        { side: "sell", price: 104, notional: 4_160, strength: 4, distance: 3.5 } as Wall,
        { side: "sell", price: 106, notional: 4_000, strength: 4, distance: 5.5 } as Wall,
      ],
      mid: 100.5,
    };
    const thin: BookSnapshot = { ...snapshot, asks: snapshot.asks.map((a) => ({ ...a, qty: 1, notional: a.price })) };
    const read = readBook(thin, 3, previous);
    expect(read.pulled).toBe(2);
    expect(read.spoofSuspected).toBe(true);
  });

  it("returns an empty read for a one-sided or missing book", () => {
    expect(readBook(undefined, 3).levels).toBe(0);
    expect(readBook({ bids: [], asks: snapshot.asks, at: T }, 3).levels).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 10 — Market structure                                               */
/* ------------------------------------------------------------------ */

describe("market structure engine", () => {
  it("finds fractal pivots", () => {
    const pivots = findPivots(bars(BULL_HIGHS), 2);
    const highs = pivots.filter((p) => p.type === "high").map((p) => p.price);
    const lows = pivots.filter((p) => p.type === "low").map((p) => p.price);
    expect(highs).toEqual([110, 118, 126]);
    expect(lows).toEqual([101, 109]);
  });

  it("reads higher highs and higher lows as an uptrend", () => {
    const read = readStructure(bars(BULL_HIGHS));
    expect(read.trend).toBe("bullish");
    expect(read.lastHigh).toBe(126);
    expect(read.lastLow).toBe(109);
    expect(read.bos).toBe("none");
    expect(read.atrPct).toBeGreaterThan(0);
  });

  it("reads a mirrored series as a downtrend", () => {
    const read = readStructure(bars(BULL_HIGHS.map((h) => 240 - h)));
    expect(read.trend).toBe("bearish");
  });

  it("marks a break of structure when price closes beyond the last pivot", () => {
    const read = readStructure(bars([...BULL_HIGHS, 128, 132, 136]));
    expect(read.bos).toBe("bullish");
    expect(read.choch).toBe("none");
  });

  it("marks a change of character when an uptrend breaks downward", () => {
    const read = readStructure(bars([...BULL_HIGHS, 116, 108, 100, 95]));
    expect(read.trend).toBe("bullish");
    expect(read.bos).toBe("bearish");
    expect(read.choch).toBe("bearish");
  });

  it("detects a false breakout that closed back inside", () => {
    // Final bar spikes above the 126 pivot but closes below it.
    const series = bars(BULL_HIGHS);
    series.push({
      openTime: T,
      open: 120,
      high: 130,
      low: 119,
      close: 121,
      volume: 100,
      quoteVolume: 12_000,
      trades: 50,
    });
    expect(readStructure(series).falseBreakout).toBe(true);
  });

  it("detects range compression", () => {
    // Wide bars first, then a tight coil.
    const wide = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 120 : 100));
    const tight = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 110.4 : 110));
    expect(readStructure(bars([...wide, ...tight])).phase).toBe("compression");
  });

  it("returns a neutral read when there is not enough history", () => {
    const read = readStructure(bars([100, 101, 102]));
    expect(read.trend).toBe("ranging");
    expect(read.pivots).toEqual([]);
  });

  it("measures ATR as a percentage of price", () => {
    // Every bar spans exactly 2 on a ~100 close.
    expect(atrPct(bars([100, 100, 100, 100, 100, 100]), 5)).toBeCloseTo(2 / 99 * 100, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 7 — Liquidity                                                       */
/* ------------------------------------------------------------------ */

describe("liquidity engine", () => {
  const daily: Kline[] = [
    // Two prior days plus today, so "previous day" is unambiguous.
    { openTime: Date.UTC(2024, 0, 1), open: 90, high: 95, low: 85, close: 92, volume: 1, quoteVolume: 1, trades: 1 },
    { openTime: Date.UTC(2024, 0, 2), open: 92, high: 130, low: 88, close: 120, volume: 1, quoteVolume: 1, trades: 1 },
    { openTime: Date.UTC(2024, 0, 3), open: 120, high: 125, low: 118, close: 122, volume: 1, quoteVolume: 1, trades: 1 },
  ];

  it("maps swing pivots and prior-period extremes on both sides of price", () => {
    const read = readLiquidity(bars(BULL_HIGHS), daily, 112);
    expect(read.levels.length).toBeGreaterThan(2);
    expect(read.nearestResistance?.price).toBeGreaterThan(112);
    expect(read.nearestSupport?.price).toBeLessThan(112);
    for (const level of read.levels) {
      expect(level.side).toBe(level.price >= 112 ? "above" : "below");
      expect(level.weight).toBeGreaterThan(0);
      expect(level.weight).toBeLessThanOrEqual(1);
    }
  });

  it("labels the previous day high and low", () => {
    const read = readLiquidity(bars(BULL_HIGHS), daily, 112);
    const labels = read.levels.map((l) => l.label);
    expect(labels.some((l) => l.includes("Prev day"))).toBe(true);
  });

  it("keeps liquidity pools inside 0-100", () => {
    const read = readLiquidity(bars(BULL_HIGHS), daily, 112);
    expect(read.poolAbove).toBeGreaterThanOrEqual(0);
    expect(read.poolAbove).toBeLessThanOrEqual(100);
    expect(read.poolBelow).toBeGreaterThanOrEqual(0);
    expect(read.poolBelow).toBeLessThanOrEqual(100);
  });

  it("merges repeated failures at one price into equal highs", () => {
    // Two pivot highs a hair apart -> one clustered level with two touches.
    const twin = [100, 102, 104, 110, 106, 102, 100, 104, 110.05, 106, 102, 100, 101, 102, 103, 102, 101, 100, 101, 102, 103];
    const read = readLiquidity(bars(twin), daily, 100);
    const equal = read.levels.find((l) => l.kind === "equal-highs");
    expect(equal).toBeDefined();
    expect(equal?.touches).toBe(2);
    expect(equal?.label).toContain("×2");
  });

  it("weights a nearby level above a distant one", () => {
    const read = readLiquidity(bars(BULL_HIGHS), daily, 112);
    const above = read.levels.filter((l) => l.side === "above");
    expect(above[0].distance).toBeLessThanOrEqual(above[above.length - 1].distance);
  });

  it("returns an empty map without enough history", () => {
    const read = readLiquidity(bars([100, 101]), [], 100);
    expect(read.levels).toEqual([]);
    expect(read.poolAbove).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 8 — Volume profile                                                  */
/* ------------------------------------------------------------------ */

describe("volume profile engine", () => {
  /** 20 heavy bars pinned in 100-101, two thin bars stretching up to 110. */
  function profileBars(): Kline[] {
    const dense: Kline[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: T - (22 - i) * 5 * MIN,
      open: 100.5,
      high: 101,
      low: 100,
      close: 100.5,
      volume: 1_000,
      quoteVolume: 1_000,
      trades: 10,
    }));
    const thin: Kline[] = Array.from({ length: 2 }, (_, i) => ({
      openTime: T - (2 - i) * 5 * MIN,
      open: 101,
      high: 110,
      low: 100,
      close: 109,
      volume: 10,
      quoteVolume: 10,
      trades: 2,
    }));
    return [...dense, ...thin];
  }

  it("puts the point of control in the dense band", () => {
    const read = readProfile(profileBars(), 100.5);
    expect(read).toBeDefined();
    expect(read?.poc).toBeGreaterThanOrEqual(100);
    expect(read?.poc).toBeLessThanOrEqual(101);
  });

  it("orders the value area and reports acceptance", () => {
    const read = readProfile(profileBars(), 100.5);
    expect(read?.vah).toBeGreaterThanOrEqual(read?.val ?? 0);
    expect(read?.acceptance).toBe("inside");
    expect(read?.pocDistance).toBeCloseTo(0, 0);
  });

  it("reports rejection when price is stranded outside value", () => {
    const read = readProfile(profileBars(), 109.5);
    expect(read?.acceptance).toBe("above");
    expect(read?.pocDistance).toBeGreaterThan(5);
    // The stretch above the dense band is a low-volume node.
    expect(read?.inLvn).toBe(true);
  });

  it("spreads each bar across the bins it actually covers", () => {
    const read = readProfile(profileBars(), 100.5);
    const total = read?.bins.reduce((a, b) => a + b.volume, 0) ?? 0;
    // 20 dense bars at 1000 plus 2 thin bars at 10.
    expect(total).toBeCloseTo(20_020, 0);
  });

  it("returns undefined without enough bars", () => {
    expect(readProfile(bars([100, 101, 102]), 100)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 9 — VWAP                                                            */
/* ------------------------------------------------------------------ */

describe("VWAP engine", () => {
  function flatBars(): Kline[] {
    const day = Date.UTC(2024, 5, 1);
    return Array.from({ length: 12 }, (_, i) => ({
      openTime: day + i * 5 * MIN,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 10,
      quoteVolume: 1_000,
      trades: 5,
    }));
  }

  it("anchors at the session and reports the deviation", () => {
    const read = readVwap(flatBars(), 101);
    expect(read?.vwap).toBeCloseTo(100, 5);
    expect(read?.deviation).toBeCloseTo(1, 5);
    expect(read?.position).toBe("above");
  });

  it("reads below the mean on the other side", () => {
    expect(readVwap(flatBars(), 99)?.position).toBe("below");
  });

  it("builds bands and a mean-reversion score once there is dispersion", () => {
    const day = Date.UTC(2024, 5, 1);
    const spread: Kline[] = Array.from({ length: 12 }, (_, i) => {
      const p = 100 + (i % 2 === 0 ? -4 : 4);
      return {
        openTime: day + i * 5 * MIN,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: 10,
        quoteVolume: 1_000,
        trades: 5,
      };
    });
    const read = readVwap(spread, 110);
    expect(read?.upper1).toBeGreaterThan(read?.vwap ?? 0);
    expect(read?.lower1).toBeLessThan(read?.vwap ?? 0);
    expect(read?.sigma).toBeGreaterThan(1);
    expect(read?.meanReversion).toBeGreaterThan(0);
    expect(read?.meanReversion).toBeLessThanOrEqual(100);
  });

  it("returns undefined without enough bars", () => {
    expect(readVwap(bars([100, 101]), 100)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Gate 1 — the 24h extreme                                            */
/* ------------------------------------------------------------------ */

describe("24h high", () => {
  it("always measures the high, never the low", () => {
    // A contract sitting on its 24h LOW is not a short candidate: it should
    // report the full distance up to the high and fail gate 1, not flip sides.
    const atLow = readExtreme(ticker({ last: 98, high: 102, low: 98 }));
    expect(atLow?.level).toBe(102);
    expect(atLow?.bps).toBeGreaterThan(400);

    const atHigh = readExtreme(ticker({ last: 101.9, high: 102, low: 98 }));
    expect(atHigh?.level).toBe(102);
    expect(atHigh?.bps).toBeLessThan(15);
  });

  it("reports a sweep beyond the high as zero distance, never negative", () => {
    // The ticker's rolling high can lag the last print during a sweep.
    const read = readExtreme(ticker({ last: 103, high: 102, low: 98 }));
    expect(read?.bps).toBe(0);
  });

  it("measures distance in basis points of price", () => {
    const read = readExtreme(ticker({ last: 100, high: 100.1, low: 90 }));
    expect(read?.bps).toBeCloseTo(10, 6);
  });

  it("returns nothing without a usable range", () => {
    expect(readExtreme(ticker({ last: 0 }))).toBeUndefined();
    expect(readExtreme(ticker({ high: 90, low: 100 }))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Gate 3 — the wick rejection trap                                    */
/* ------------------------------------------------------------------ */

describe("wick share", () => {
  it("always measures the upper wick", () => {
    const bar: Kline = { openTime: T, open: 100, high: 110, low: 98, close: 100, volume: 1, quoteVolume: 1, trades: 1 };
    // Body top is 100, so the upper wick is 10 of a 12 range.
    expect(wickShare(bar)).toBeCloseTo((10 / 12) * 100, 6);
  });

  it("returns zero for a zero-range bar", () => {
    const flat: Kline = { openTime: T, open: 100, high: 100, low: 100, close: 100, volume: 1, quoteVolume: 1, trades: 1 };
    expect(wickShare(flat)).toBe(0);
  });
});

describe("trap detection", () => {
  it("requires both halves: a higher high and a rejection", () => {
    const rejected = [...base(100), candle(T, 99, 110, { wick: 0.6 })];
    expect(findTrap(rejected)?.wickPct).toBeGreaterThan(45);

    // Same new high, but it closed on its highs — continuation, not a trap.
    const held = [...base(100), candle(T, 99, 110, { wick: 0.02 })];
    expect(findTrap(held)?.wickPct).toBeLessThan(45);
  });

  it("ignores a long wick on a bar that never extended the range", () => {
    const inside = [...base(100), candle(T, 99.2, 100.5, { wick: 0.9 })];
    expect(findTrap(inside)).toBeUndefined();
  });

  it("ignores a capitulation low — a lower low is not this engine's setup", () => {
    // A bar that flushes well below the range with a big lower wick would be a
    // textbook bear trap. Short-only: it must not register as a trap at all.
    const flushed: Kline[] = [
      ...base(100),
      { openTime: T, open: 99.5, high: 100.2, low: 90, close: 99.4, volume: 100, quoteVolume: 9_940, trades: 50 },
    ];
    expect(findTrap(flushed)).toBeUndefined();
  });

  it("only looks at the newest bars, so an old rejection goes stale", () => {
    const stale = [
      ...base(100),
      candle(T - 4 * 5 * MIN, 99, 110, { wick: 0.9 }),
      ...Array.from({ length: 4 }, (_, i) => candle(T - (3 - i) * 5 * MIN, 99, 101, { wick: 0.1 })),
    ];
    expect(findTrap(stale, 12, 3)).toBeUndefined();
  });

  it("returns nothing without enough history", () => {
    expect(findTrap(base(100, 4))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Gate 4 — long-horizon liquidity depletion                           */
/* ------------------------------------------------------------------ */

describe("horizon extremes", () => {
  it("returns the highest high and lowest low of the window", () => {
    const read = readHorizon(dailyBars(120, 40), 365);
    expect(read?.high).toBe(120);
    expect(read?.low).toBe(40);
    expect(read?.days).toBe(40);
  });

  it("only reads back as far as the window allows", () => {
    const read = readHorizon(dailyBars(120, 40, 100), 10);
    expect(read?.days).toBe(10);
  });

  it("returns nothing without daily history", () => {
    expect(readHorizon([], 365)).toBeUndefined();
  });

  it("excludes the in-progress day, so today cannot define its own horizon", () => {
    // A year capped at 100, then today breaks out to 150 on its own.
    const history: Kline[] = Array.from({ length: 300 }, (_, i) => ({
      openTime: T - (300 - i) * DAY,
      open: 90,
      high: 100,
      low: 80,
      close: 95,
      volume: 10,
      quoteVolume: 1_000,
      trades: 10,
    }));
    const today: Kline = {
      openTime: T,
      open: 99,
      high: 150,
      low: 98,
      close: 149,
      volume: 10,
      quoteVolume: 1_000,
      trades: 10,
    };
    // `now` sits one hour into the final bar, so that bar is still forming.
    const read = readHorizon([...history, today], 365, T + 60 * MIN);
    expect(read?.high).toBe(100);
    expect(read?.days).toBe(300);
  });

  it("counts a day once it has actually closed", () => {
    const bars = dailyBars(120, 40, 10);
    const last = bars[bars.length - 1];
    // Past the close of the final bar, every bar is complete.
    const read = readHorizon(bars, 365, last.openTime + DAY + 1);
    expect(read?.days).toBe(10);
    expect(read?.high).toBe(120);
  });

  it("returns nothing when no day has closed yet", () => {
    const only: Kline[] = [
      { openTime: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, quoteVolume: 1, trades: 1 },
    ];
    expect(readHorizon(only, 365, T + 60 * MIN)).toBeUndefined();
  });
});

describe("gate 4 self-reference", () => {
  /** A year of quiet days topped at `cap`, then a forming day that breaks out. */
  function breakoutDaily(cap: number, todayHigh: number): Kline[] {
    const history: Kline[] = Array.from({ length: 300 }, (_, i) => ({
      openTime: T - (300 - i) * DAY,
      open: cap - 10,
      high: cap,
      low: cap - 20,
      close: cap - 5,
      volume: 10,
      quoteVolume: 1_000,
      trades: 10,
    }));
    return [
      ...history,
      {
        openTime: T,
        open: cap - 1,
        high: todayHigh,
        low: cap - 2,
        close: todayHigh - 1,
        volume: 10,
        quoteVolume: 1_000,
        trades: 10,
      },
    ];
  }

  it("refuses gate 4 on a fresh breakout into open sky", () => {
    // Price is at an all-time high having swept nothing: there is no resting
    // liquidity ABOVE because nobody has ever traded up there. Letting today's
    // own high stand in for the yearly high made this read as "depleted", which
    // inverted the gate — it passed hardest exactly when the premise failed.
    const read = evaluateExhaustion(
      armedShort({
        ticker: ticker({ last: 149.9, high: 150, low: 98, open: 99, quoteVolume: 500_000_000 }),
        daily: breakoutDaily(100, 150),
        at: T + 60 * MIN,
      }),
    );
    expect(gateOf(read, "depletion")).toBe(false);
    expect(read.armed).toBe(false);
  });

  it("still passes gate 4 when price returns to a historical high", () => {
    // Same shape, but the level being tested was set on a completed day, so
    // there genuinely is spent liquidity at it.
    const read = evaluateExhaustion(
      armedShort({
        ticker: ticker({ last: 100, high: 100, low: 80, open: 85, quoteVolume: 500_000_000 }),
        daily: breakoutDaily(100, 99),
        at: T + 60 * MIN,
      }),
    );
    expect(gateOf(read, "depletion")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The exhaustion model                                                */
/* ------------------------------------------------------------------ */

describe("exhaustion engine", () => {
  it("arms only when all four gates pass", () => {
    const read = evaluateExhaustion(armedShort());
    expect(read.armed).toBe(true);
    expect(read.side).toBe("short");
    expect(read.passedCount).toBe(4);
    for (const gate of read.gates) expect(gate.passed).toBe(true);
  });

  it("never arms a long, however perfect the mirror setup is", () => {
    // The exact bear-trap mirror of `armedShort`: price pinned to the 24h low,
    // a climactic cooling volume spike, a rejected lower low, and the yearly
    // low swept. A two-sided engine would arm this. This one must not.
    const capitulation: Kline[] = [
      ...base(100),
      { openTime: T - 5 * MIN, open: 99.5, high: 100.2, low: 90, close: 99.4, volume: 100, quoteVolume: 9_940, trades: 50 },
    ];
    const read = evaluateExhaustion(
      armedShort({
        ticker: ticker({ last: 90, high: 110, low: 90, open: 105, quoteVolume: 500_000_000 }),
        klines: capitulation,
        daily: dailyBars(160, 90),
      }),
    );
    expect(read.armed).toBe(false);
    expect(read.side).toBe("none");
    // Gate 1 measures the distance UP to the 24h high, which is enormous here.
    expect(gateOf(read, "pin")).toBe(false);
    expect(gateOf(read, "trap")).toBe(false);
  });

  it("refuses to arm when price is mid-range, however extreme everything else is", () => {
    const read = evaluateExhaustion(
      armedShort({ ticker: ticker({ last: 100, high: 110, low: 90, quoteVolume: 500_000_000 }) }),
    );
    expect(gateOf(read, "pin")).toBe(false);
    expect(read.armed).toBe(false);
    expect(read.side).toBe("none");
    expect(read.conviction).toBe(0);
  });

  it("refuses to arm on a volume spike that is still accelerating", () => {
    // The trap needs spent fuel; a surge still building is not exhaustion.
    const read = evaluateExhaustion(
      armedShort({ volume: volume({ rvol: 800, acceleration: 120, spike: true }) }),
    );
    expect(gateOf(read, "climax")).toBe(false);
    expect(read.armed).toBe(false);
  });

  it("refuses to arm below the climax threshold", () => {
    const read = evaluateExhaustion(
      armedShort({ volume: volume({ rvol: 180, acceleration: -10 }) }),
    );
    expect(gateOf(read, "climax")).toBe(false);
    expect(read.armed).toBe(false);
  });

  it("refuses to arm when the new high closed strong", () => {
    const read = evaluateExhaustion(
      armedShort({ klines: [...base(100), candle(T - 5 * MIN, 99, 110, { wick: 0.05 })] }),
    );
    expect(gateOf(read, "trap")).toBe(false);
    expect(read.armed).toBe(false);
  });

  it("holds the 45% wick floor exactly", () => {
    const at45 = [...base(100), candle(T - 5 * MIN, 99, 110, { wick: 0.45 })];
    expect(gateOf(evaluateExhaustion(armedShort({ klines: at45 })), "trap")).toBe(true);

    const under = [...base(100), candle(T - 5 * MIN, 99, 110, { wick: 0.449 })];
    expect(gateOf(evaluateExhaustion(armedShort({ klines: under })), "trap")).toBe(false);
  });

  it("refuses to arm when there is still room to the long-horizon extreme", () => {
    // Price at the 24h high, but well below the yearly high — depth remains.
    const read = evaluateExhaustion(armedShort({ daily: dailyBars(400, 40) }));
    expect(gateOf(read, "depletion")).toBe(false);
    expect(read.armed).toBe(false);
  });

  it("never passes a gate it could not measure", () => {
    const read = evaluateExhaustion(armedShort({ klines: undefined, daily: undefined }));
    expect(read.deep).toBe(false);
    expect(gateOf(read, "trap")).toBe(false);
    expect(gateOf(read, "depletion")).toBe(false);
    expect(read.armed).toBe(false);
    expect(read.measuredCount).toBe(2);
    for (const gate of read.gates) {
      if (!gate.measured) {
        expect(gate.passed).toBe(false);
        expect(gate.progress).toBe(0);
        expect(gate.margin).toBe(0);
      }
    }
  });

  it("gives every gate a detail line that names its numbers", () => {
    for (const gate of evaluateExhaustion(armedShort()).gates) {
      expect(gate.detail.length).toBeGreaterThan(0);
    }
    // And a near miss says what it is still waiting for.
    const miss = evaluateExhaustion(armedShort({ volume: volume({ rvol: 180, acceleration: -10 }) }));
    expect(miss.gates.find((g) => g.key === "climax")?.detail).toContain("needs");
  });

  it("scores conviction only for an armed setup, and never as a probability", () => {
    const armed = evaluateExhaustion(armedShort());
    expect(armed.conviction).toBeGreaterThanOrEqual(60);
    expect(armed.conviction).toBeLessThanOrEqual(100);

    const idle = evaluateExhaustion(armedShort({ volume: volume({ rvol: 100, acceleration: 0 }) }));
    expect(idle.conviction).toBe(0);
  });

  it("rates a deeper sweep above a marginal one", () => {
    const marginal = evaluateExhaustion(
      armedShort({ volume: volume({ rvol: 300, acceleration: 0, spike: true }) }),
    );
    const decisive = evaluateExhaustion(
      armedShort({ volume: volume({ rvol: 900, acceleration: -200, spike: true }) }),
    );
    expect(decisive.conviction).toBeGreaterThan(marginal.conviction);
  });

  it("keeps progress below 1 for an unpassed gate and awards margin only past it", () => {
    const miss = evaluateExhaustion(armedShort({ volume: volume({ rvol: 150, acceleration: -10 }) }));
    const climax = miss.gates.find((g) => g.key === "climax");
    expect(climax?.progress).toBeGreaterThan(0);
    expect(climax?.progress).toBeLessThan(1);
    expect(climax?.margin).toBe(0);
  });

  it("carries the measurements the panel and the manual quote", () => {
    const read = evaluateExhaustion(armedShort());
    expect(read.rvol).toBe(500);
    expect(read.wickPct).toBeGreaterThan(45);
    expect(read.extremeBps).toBe(0);
    expect(read.yearHigh).toBe(110);
    expect(read.rangePos).toBeCloseTo(1, 6);
    expect(read.quoteVolume).toBe(500_000_000);
  });

  it("publishes one reason per gate, in gate order", () => {
    const reasons = reasonsOf(evaluateExhaustion(armedShort()));
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toContain("24h high pin");
    expect(reasons[3]).toContain("Upside liquidity depletion");
  });

  it("always headlines a short, and says nothing when unarmed", () => {
    expect(headlineOf(evaluateExhaustion(armedShort()))).toContain("SHORT");
    const idle = evaluateExhaustion(armedShort({ volume: volume({ rvol: 100 }) }));
    expect(headlineOf(idle)).toBe("No exhaustion setup");
  });
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

describe("engine configuration", () => {
  it("falls back to defaults for junk input", () => {
    expect(sanitizeWickRules(null)).toEqual(DEFAULT_WICK_RULES);
    expect(sanitizeWickRules("nope")).toEqual(DEFAULT_WICK_RULES);
    expect(sanitizeWickRules({})).toEqual(DEFAULT_WICK_RULES);
  });

  it("clamps out-of-range values", () => {
    const r = sanitizeWickRules({
      minVolume: -10,
      pinBps: 0,
      rvolClimax: 1,
      depletionPct: 99,
      horizonDays: 5_000,
      deepWatch: 900,
      cooldownMins: 0,
    });
    expect(r.minVolume).toBe(0);
    expect(r.pinBps).toBe(0.5);
    expect(r.rvolClimax).toBe(150);
    expect(r.depletionPct).toBe(10);
    expect(r.horizonDays).toBe(365);
    expect(r.deepWatch).toBe(24);
    expect(r.cooldownMins).toBe(1);
  });

  it("will not let the wick floor be configured below the 45% specification", () => {
    expect(sanitizeWickRules({ wickPct: 10 }).wickPct).toBe(45);
    expect(sanitizeWickRules({ wickPct: 60 }).wickPct).toBe(60);
  });

  it("rejects a refresh cadence that is not an offered option", () => {
    expect(sanitizeWickRules({ refreshMs: 37 }).refreshMs).toBe(DEFAULT_WICK_RULES.refreshMs);
    expect(sanitizeWickRules({ refreshMs: 5_000 }).refreshMs).toBe(5_000);
  });

  it("rounds the deep-watch slot count to a whole number", () => {
    expect(sanitizeWickRules({ deepWatch: 7.6 }).deepWatch).toBe(8);
  });

  it("ranks candidacy on proximity to the 24h high above all else", () => {
    const common = { quoteVolume: 50_000_000, pinBps: RULES.pinBps, rvolClimax: RULES.rvolClimax };
    const pinned = candidacy({ ...common, extremeBps: 0, rvol: 100 });
    const midRange = candidacy({ ...common, extremeBps: 400, rvol: 900 });
    // A contract on its high with flat volume outranks a busy mid-range one,
    // because nothing can arm without gate 1.
    expect(pinned).toBeGreaterThan(midRange);
    expect(pinned).toBeLessThanOrEqual(1);
    expect(midRange).toBeGreaterThanOrEqual(0);
  });

  it("ranks a hotter RVOL above a colder one, all else equal", () => {
    const common = { quoteVolume: 10_000_000, extremeBps: 2, pinBps: RULES.pinBps, rvolClimax: RULES.rvolClimax };
    expect(candidacy({ ...common, rvol: 450 })).toBeGreaterThan(candidacy({ ...common, rvol: 150 }));
  });
});
