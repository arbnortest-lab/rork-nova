/**
 * Squeeze Radar — pure micro-structure reducers.
 *
 * Every function here takes normalised stream data and returns a read. No
 * sockets, no timers, no React: the whole layer is testable in isolation and
 * the stream module stays a thin transport.
 *
 *   depth      — weighted book imbalance and cumulative depth rows
 *   walls      — whale walls, reusing the engine's `readBook`
 *   squeeze    — forced-order volume against the contract's own turnover
 *   clusters   — where forced orders piled up, in price buckets
 *   oi         — 5-minute open-interest trend from the history endpoint
 */

import { readBook, readOpenInterest } from "@/lib/wick/engines";
import type { AggTrade, BookRead, BookSnapshot, OiPoint, Wall } from "@/lib/wick/types";

import type {
  DepthRead,
  DepthRow,
  FlowWindow,
  LiqCluster,
  LiquidationEvent,
  OiTrendRead,
  SqueezeLevel,
  SqueezeRead,
} from "./types";

/** Rolling window behind the squeeze meter, flow totals and liquidation list. */
export const RADAR_WINDOW_MS = 60 * 60_000;
/** A level this many times the mean level notional on its side is a wall. */
export const WALL_STRENGTH = 3;
/** Levels nearer the touch matter more; weight decays by e every this many levels. */
const DEPTH_WEIGHT_TAU = 6;
/** Price bucket width for liquidation clusters, percent of price. */
export const CLUSTER_BIN_PCT = 0.2;
/** Points behind the OI trend slope: six 5-minute snapshots. */
const OI_TREND_POINTS = 6;
/** Slope (percent of mean OI over 30 minutes) that counts as a trend. */
const OI_TREND_MIN_PCT = 0.1;

/**
 * A turnover figure the thresholds can scale from. `Math.max(1000, NaN)` is
 * NaN, so a missing or malformed 24h volume must read as zero here or every
 * floor below would silently vanish.
 */
function turnover(quoteVolume24h: number): number {
  return Number.isFinite(quoteVolume24h) && quoteVolume24h > 0 ? quoteVolume24h : 0;
}

/* ------------------------------------------------------------------ */
/* Depth                                                               */
/* ------------------------------------------------------------------ */

function rows(levels: BookSnapshot["bids"], walls: Wall[], side: "buy" | "sell"): DepthRow[] {
  const wallPrices = new Set(walls.filter((w) => w.side === side).map((w) => w.price));
  let total = 0;
  return levels.map((l) => {
    total += l.notional;
    return { ...l, total, wall: wallPrices.has(l.price) };
  });
}

function weighted(levels: BookSnapshot["bids"]): number {
  let sum = 0;
  for (let i = 0; i < levels.length; i++) sum += levels[i].notional * Math.exp(-i / DEPTH_WEIGHT_TAU);
  return sum;
}

export const EMPTY_DEPTH: DepthRead = {
  bids: [],
  asks: [],
  bidNotional: 0,
  askNotional: 0,
  rawBidShare: 50,
  weightedBidShare: 50,
  pressure: "balanced",
  pressurePts: 0,
};

/**
 * Cumulative depth rows plus two imbalance readings: raw (every level equal)
 * and weighted (the touch counts most). The weighted one drives the bar; the
 * raw one is shown beside it so a wall deep in the book cannot hide.
 */
export function readDepth(snapshot: BookSnapshot | undefined, walls: Wall[]): DepthRead {
  if (!snapshot || !snapshot.bids.length || !snapshot.asks.length) return EMPTY_DEPTH;

  const bidNotional = snapshot.bids.reduce((a, l) => a + l.notional, 0);
  const askNotional = snapshot.asks.reduce((a, l) => a + l.notional, 0);
  const total = bidNotional + askNotional;
  const wBid = weighted(snapshot.bids);
  const wAsk = weighted(snapshot.asks);
  const wTotal = wBid + wAsk;

  const rawBidShare = total > 0 ? (bidNotional / total) * 100 : 50;
  const weightedBidShare = wTotal > 0 ? (wBid / wTotal) * 100 : 50;
  const pts = Math.abs(weightedBidShare * 2 - 100);
  const bestBid = snapshot.bids[0].price;
  const bestAsk = snapshot.asks[0].price;
  const mid = (bestBid + bestAsk) / 2;

  return {
    mid,
    spreadPct: mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : undefined,
    bids: rows(snapshot.bids, walls, "buy"),
    asks: rows(snapshot.asks, walls, "sell"),
    bidNotional,
    askNotional,
    rawBidShare,
    weightedBidShare,
    pressure: pts < 4 ? "balanced" : weightedBidShare > 50 ? "bids" : "asks",
    pressurePts: pts,
    at: snapshot.at,
  };
}

/* ------------------------------------------------------------------ */
/* Walls                                                               */
/* ------------------------------------------------------------------ */

export interface WallsRead {
  book: BookRead;
  bid: Wall[];
  ask: Wall[];
}

/** Whale walls on each side, nearest to price first. */
export function readWalls(
  snapshot: BookSnapshot | undefined,
  previous?: { walls: Wall[]; mid: number },
): WallsRead {
  const book = readBook(snapshot, WALL_STRENGTH, previous);
  const bid = book.walls.filter((w) => w.side === "buy").sort((a, b) => b.price - a.price);
  const ask = book.walls.filter((w) => w.side === "sell").sort((a, b) => a.price - b.price);
  return { book, bid, ask };
}

/* ------------------------------------------------------------------ */
/* Flow                                                                */
/* ------------------------------------------------------------------ */

export interface MinuteBucket {
  minute: number;
  buy: number;
  sell: number;
  count: number;
  whaleBuys: number;
  whaleSells: number;
  /** First and last print of the minute, for short-window price change. */
  open: number;
  close: number;
}

/** Fold one print into its minute bucket. Buckets are keyed by minute start. */
export function foldTrade(buckets: Map<number, MinuteBucket>, trade: AggTrade, whaleAt: number): void {
  const minute = Math.floor(trade.at / 60_000) * 60_000;
  let b = buckets.get(minute);
  if (!b) {
    b = { minute, buy: 0, sell: 0, count: 0, whaleBuys: 0, whaleSells: 0, open: trade.price, close: trade.price };
    buckets.set(minute, b);
  }
  b.count += 1;
  b.close = trade.price;
  if (trade.isBuy) {
    b.buy += trade.notional;
    if (trade.notional >= whaleAt) b.whaleBuys += 1;
  } else {
    b.sell += trade.notional;
    if (trade.notional >= whaleAt) b.whaleSells += 1;
  }
}

/** Drop buckets outside the window. */
export function pruneBuckets(buckets: Map<number, MinuteBucket>, now: number, windowMs = RADAR_WINDOW_MS): void {
  const floor = now - windowMs;
  for (const key of buckets.keys()) if (key + 60_000 < floor) buckets.delete(key);
}

export function readFlowWindow(buckets: Map<number, MinuteBucket>, now: number, windowMs = RADAR_WINDOW_MS): FlowWindow {
  const floor = now - windowMs;
  let buy = 0;
  let sell = 0;
  let count = 0;
  let minutes = 0;
  let whaleBuys = 0;
  let whaleSells = 0;
  for (const b of buckets.values()) {
    if (b.minute + 60_000 < floor) continue;
    buy += b.buy;
    sell += b.sell;
    count += b.count;
    whaleBuys += b.whaleBuys;
    whaleSells += b.whaleSells;
    minutes += 1;
  }
  const total = buy + sell;
  return { buy, sell, count, buyShare: total > 0 ? (buy / total) * 100 : 50, minutes, whaleBuys, whaleSells };
}

/**
 * Percent price change across the last `minutes` minutes of prints, or
 * undefined when the tape does not reach back that far.
 */
export function priceChangeOver(buckets: Map<number, MinuteBucket>, now: number, minutes: number): number | undefined {
  const nowMinute = Math.floor(now / 60_000) * 60_000;
  const latest = buckets.get(nowMinute) ?? buckets.get(nowMinute - 60_000);
  if (!latest) return undefined;
  const target = nowMinute - minutes * 60_000;
  let from: MinuteBucket | undefined;
  for (let m = target; m <= target + 2 * 60_000 && !from; m += 60_000) from = buckets.get(m);
  if (!from || from === latest || !(from.open > 0)) return undefined;
  return ((latest.close - from.open) / from.open) * 100;
}

/**
 * The notional above which a print is a whale for this contract: the larger
 * of fifteen times the median print and a turnover-scaled floor
 * (0.35 × √ 24h turnover: about $50K on a $20B/day contract, $2.5K on a
 * $50M/day one), never under $1,000. Judged per contract, so BTC and a
 * sub-cent alt are each measured on their own tape.
 */
export function whaleThreshold(trades: AggTrade[], quoteVolume24h = 0): number {
  const floor = Math.max(1_000, 0.35 * Math.sqrt(turnover(quoteVolume24h)));
  if (trades.length < 20) return floor;
  const sorted = trades.map((t) => t.notional).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 20) return floor;
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(floor, median * 15);
}

/* ------------------------------------------------------------------ */
/* Squeeze                                                             */
/* ------------------------------------------------------------------ */

/**
 * Squeeze thresholds scale with the contract's own 24h turnover: "medium" is
 * 2.5% of an average hour's turnover being force-closed inside the window,
 * "high" is 25%. A $5M/day contract reads warm from about $5K and hot from
 * about $52K; a $2B/day contract needs a thousand times more.
 */
export function squeezeThresholds(quoteVolume24h: number): { medAt: number; highAt: number } {
  const hourly = turnover(quoteVolume24h) / 24;
  return { medAt: Math.max(1_000, hourly * 0.025), highAt: Math.max(5_000, hourly * 0.25) };
}

export function squeezeLevel(volume: number, medAt: number, highAt: number): SqueezeLevel {
  if (volume >= highAt) return "hot";
  if (volume >= medAt) return "warm";
  return "cold";
}

export function readSqueeze(
  liqs: LiquidationEvent[],
  quoteVolume24h: number,
  now: number,
  windowMs = RADAR_WINDOW_MS,
): SqueezeRead {
  const { medAt, highAt } = squeezeThresholds(quoteVolume24h);
  const floor = now - windowMs;
  let shortLiq = 0;
  let longLiq = 0;
  let count = 0;
  let lastAt: number | undefined;
  for (const l of liqs) {
    if (l.at < floor) continue;
    count += 1;
    if (l.side === "BUY") shortLiq += l.notional;
    else longLiq += l.notional;
    if (!lastAt || l.at > lastAt) lastAt = l.at;
  }
  const volume = shortLiq + longLiq;
  let direction: SqueezeRead["direction"] = "none";
  if (volume > 0) {
    const shortShare = shortLiq / volume;
    direction = shortShare >= 0.65 ? "short-squeeze" : shortShare <= 0.35 ? "long-flush" : "mixed";
  }
  return { volume, shortLiq, longLiq, level: squeezeLevel(volume, medAt, highAt), medAt, highAt, count, lastAt, direction };
}

/* ------------------------------------------------------------------ */
/* Liquidation clusters                                                */
/* ------------------------------------------------------------------ */

/**
 * Forced orders bucketed by price around the current price. The all-market
 * stream is a snapshot (at most one order per contract per second), so this
 * is a floor on the real density — enough to see where the stops sat.
 */
export function liquidationClusters(
  liqs: LiquidationEvent[],
  price: number,
  now: number,
  windowMs = RADAR_WINDOW_MS,
  binPct = CLUSTER_BIN_PCT,
  limit = 6,
): LiqCluster[] {
  if (!(price > 0) || !liqs.length) return [];
  const floor = now - windowMs;
  const width = price * (binPct / 100);
  const bins = new Map<number, LiqCluster>();
  let total = 0;

  for (const l of liqs) {
    if (l.at < floor || !(l.price > 0)) continue;
    const idx = Math.round((l.price - price) / width);
    let c = bins.get(idx);
    if (!c) {
      const center = price + idx * width;
      c = {
        price: center,
        lo: center - width / 2,
        hi: center + width / 2,
        notional: 0,
        longLiq: 0,
        shortLiq: 0,
        count: 0,
        share: 0,
        distancePct: ((center - price) / price) * 100,
      };
      bins.set(idx, c);
    }
    c.notional += l.notional;
    c.count += 1;
    if (l.side === "BUY") c.shortLiq += l.notional;
    else c.longLiq += l.notional;
    total += l.notional;
  }

  const out = [...bins.values()].sort((a, b) => b.notional - a.notional).slice(0, limit);
  for (const c of out) c.share = total > 0 ? c.notional / total : 0;
  return out;
}

/* ------------------------------------------------------------------ */
/* Open interest                                                       */
/* ------------------------------------------------------------------ */

function slopePct(points: OiPoint[]): number | undefined {
  const tail = points.slice(-OI_TREND_POINTS);
  if (tail.length < 3) return undefined;
  const n = tail.length;
  const xs = tail.map((_, i) => i);
  const ys = tail.map((p) => p.openInterest);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  if (!(meanY > 0)) return undefined;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return undefined;
  // Slope per point, scaled to the full span of the tail and the mean level.
  return ((num / den) * (n - 1) * 100) / meanY;
}

/**
 * 5-minute open-interest trend. `hist` is the `openInterestHist` series
 * (5m period, oldest first); `live` is the latest `openInterest` reading,
 * appended when it is newer than the last snapshot.
 */
export function readOiTrend(
  hist: OiPoint[],
  live: OiPoint | undefined,
  price: number,
  priceChangePct: number,
): OiTrendRead {
  const points = [...hist].sort((a, b) => a.at - b.at);
  if (live && (!points.length || live.at > points[points.length - 1].at + 60_000)) points.push(live);
  const latest = points[points.length - 1];
  const slope = slopePct(points);
  let trend: OiTrendRead["trend"] = "unknown";
  if (slope !== undefined) trend = slope > OI_TREND_MIN_PCT ? "rising" : slope < -OI_TREND_MIN_PCT ? "falling" : "flat";

  return {
    trend,
    slopePct: slope,
    snapshots: points.length,
    read: readOpenInterest(points, priceChangePct),
    current: latest?.openInterest,
    notionalUsd: latest ? (latest.notional ?? (price > 0 ? latest.openInterest * price : undefined)) : undefined,
    at: latest?.at,
  };
}
