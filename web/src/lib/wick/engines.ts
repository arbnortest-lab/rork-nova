/**
 * Engines 1-6: open interest, funding, volume, trade flow, delta/CVD and order
 * book. All pure — they take normalised stream data and return a read, so the
 * whole model is unit-testable without a socket.
 */

import { RVOL_LOOKBACK } from "./rules";
import type {
  AggTrade,
  BookLevel,
  BookRead,
  BookSnapshot,
  FlowRead,
  FundingRead,
  Kline,
  MarkTick,
  OiPoint,
  OiRead,
  OiRegime,
  TickerTick,
  VolumeRead,
  Wall,
  WallKind,
  WickSide,
} from "./types";

const MIN = 60_000;

function pct(from: number, to: number): number | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return undefined;
  return ((to - from) / from) * 100;
}

/**
 * Value of the series at (or just before) `at`. Returns undefined when history
 * does not reach back that far, so an unmeasured window never reads as 0%.
 */
function valueAt(points: OiPoint[], at: number): number | undefined {
  let best: OiPoint | undefined;
  for (const p of points) {
    if (p.at <= at && (!best || p.at > best.at)) best = p;
  }
  if (!best) return undefined;
  // Guard against extrapolating from a sample far older than the window.
  if (at - best.at > 6 * 60 * MIN) return undefined;
  return best.openInterest;
}

/* ------------------------------------------------------------------ */
/* 1 — Open interest                                                   */
/* ------------------------------------------------------------------ */

/**
 * Open-interest deltas across the spec's five windows, plus the price/OI
 * regime. `priceChangePct` should cover roughly the same horizon as the
 * headline window so the matrix compares like with like.
 */
export function readOpenInterest(points: OiPoint[], priceChangePct: number): OiRead {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1];
  if (!latest) return { regime: "flat", points: 0 };

  const now = latest.at;
  const oi = latest.openInterest;
  const change5m = pct(valueAt(sorted, now - 5 * MIN) ?? NaN, oi);
  const change15m = pct(valueAt(sorted, now - 15 * MIN) ?? NaN, oi);
  const change1h = pct(valueAt(sorted, now - 60 * MIN) ?? NaN, oi);
  const change4h = pct(valueAt(sorted, now - 240 * MIN) ?? NaN, oi);
  const change1d = pct(valueAt(sorted, now - 1440 * MIN) ?? NaN, oi);

  // Prefer the shortest window that is both available and meaningful.
  const ladder: [number, number | undefined][] = [
    [15, change15m],
    [60, change1h],
    [5, change5m],
    [240, change4h],
    [1440, change1d],
  ];
  const headline = ladder.find(([, v]) => v !== undefined);

  const oiDelta = headline?.[1] ?? 0;
  const oiUp = oiDelta > 0.15;
  const oiDown = oiDelta < -0.15;
  const priceUp = priceChangePct > 0.05;
  const priceDown = priceChangePct < -0.05;

  let regime: OiRegime = "flat";
  if (priceUp && oiUp) regime = "new-longs";
  else if (priceDown && oiUp) regime = "new-shorts";
  else if (priceUp && oiDown) regime = "short-covering";
  else if (priceDown && oiDown) regime = "long-liquidation";

  return {
    openInterest: oi,
    notional: latest.notional,
    change5m,
    change15m,
    change1h,
    change4h,
    change1d,
    regime,
    headlineWindowMins: headline?.[0],
    headlineChange: headline?.[1],
    points: sorted.length,
  };
}

/* ------------------------------------------------------------------ */
/* 2 — Funding rate                                                    */
/* ------------------------------------------------------------------ */

/**
 * Funding read. `history` is the recent settled rates in percent, newest last.
 * `extremeAt` is the |rate| that counts as crowded.
 */
export function readFunding(
  mark: MarkTick | undefined,
  history: number[],
  extremeAt: number,
  now: number,
): FundingRead {
  if (!mark) return { extreme: false, crowd: "balanced" };

  const rate = mark.fundingRate;
  const countdownMs = mark.nextFundingTime > now ? mark.nextFundingTime - now : undefined;
  const average = history.length ? history.reduce((a, b) => a + b, 0) / history.length : undefined;
  const basis =
    mark.indexPrice > 0 ? ((mark.markPrice - mark.indexPrice) / mark.indexPrice) * 100 : undefined;

  return {
    rate,
    countdownMs,
    // Three settlements a day, 365 days.
    annualised: rate * 3 * 365,
    average,
    extreme: Math.abs(rate) >= extremeAt,
    crowd: rate >= extremeAt ? "longs" : rate <= -extremeAt ? "shorts" : "balanced",
    basis,
  };
}

/* ------------------------------------------------------------------ */
/* 3 — Volume analysis                                                 */
/* ------------------------------------------------------------------ */

export interface VolumeSample {
  at: number;
  quoteVolume: number;
  trades: number;
}

/**
 * Relative volume from the rolling 24h ticker.
 *
 * `quoteVolume` is a 24h *rolling* window, so its delta over a minute is
 * (volume traded now) − (volume traded 24h ago that just rolled off). That is
 * noisy on quiet contracts and can even go negative, which is why a negative
 * rate is reported as unmeasured rather than as zero, and why the kline path
 * below is preferred whenever klines are loaded.
 */
export function readVolume(
  ticker: TickerTick,
  samples: VolumeSample[],
  klines: Kline[] | undefined,
  spikeAt: number,
): VolumeRead {
  const base: VolumeRead = {
    quoteVolume24h: ticker.quoteVolume,
    trades24h: ticker.trades,
    spike: false,
    precise: false,
  };

  // Preferred: current (in-progress) bar against the average completed bar.
  if (klines && klines.length >= 8) {
    const current = klines[klines.length - 1];
    // Only the most recent `RVOL_LOOKBACK` completed bars form the baseline.
    // Averaging the whole 500-bar series would measure this bar against a
    // different volume regime: a contract busy for the last eight hours would
    // read as a climax purely because the average is dragged down by a quiet
    // yesterday. The window is also what the indicator and the manual document.
    const history = klines.slice(0, -1).slice(-RVOL_LOOKBACK);
    const avg = history.reduce((a, k) => a + k.quoteVolume, 0) / history.length;
    const span = current.openTime > 0 ? Math.max(1, ticker.at - current.openTime) : 1;
    const barMs = history.length >= 2 ? history[1].openTime - history[0].openTime : span;
    // Scale the partial bar up to a full bar so early ticks are not read as a lull.
    const elapsed = Math.min(1, span / Math.max(1, barMs));
    const projected = elapsed > 0.08 ? current.quoteVolume / elapsed : current.quoteVolume;
    const rvol = avg > 0 ? (projected / avg) * 100 : undefined;

    let acceleration: number | undefined;
    if (history.length >= 2 && avg > 0) {
      const prev = (history[history.length - 1].quoteVolume / avg) * 100;
      if (rvol !== undefined) acceleration = rvol - prev;
    }

    return {
      ...base,
      rate: barMs > 0 ? (projected / barMs) * 1000 : undefined,
      rvol,
      spike: rvol !== undefined && rvol >= spikeAt,
      acceleration,
      tradeRate: barMs > 0 ? (current.trades / barMs) * 1000 : undefined,
      precise: true,
    };
  }

  // Fallback: differentiate the rolling 24h counter.
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const newest = sorted[sorted.length - 1];
  const oldest = sorted[0];
  if (!newest || !oldest || newest.at - oldest.at < 10_000) return base;

  const spanMs = newest.at - oldest.at;
  const dv = newest.quoteVolume - oldest.quoteVolume;
  const dt = newest.trades - oldest.trades;
  const baseline = ticker.quoteVolume / 86_400; // USD per second, 24h average
  if (!(dv > 0) || !(baseline > 0)) return base;

  const rate = dv / (spanMs / 1000);
  const rvol = (rate / baseline) * 100;

  // Acceleration from the two halves of the window.
  let acceleration: number | undefined;
  const mid = oldest.at + spanMs / 2;
  const pivot = sorted.find((s) => s.at >= mid);
  if (pivot && pivot !== newest && pivot !== oldest) {
    const firstRate = (pivot.quoteVolume - oldest.quoteVolume) / ((pivot.at - oldest.at) / 1000);
    const lastRate = (newest.quoteVolume - pivot.quoteVolume) / ((newest.at - pivot.at) / 1000);
    if (firstRate > 0 && lastRate >= 0) {
      acceleration = ((lastRate - firstRate) / baseline) * 100;
    }
  }

  return {
    ...base,
    rate,
    rvol,
    spike: rvol >= spikeAt,
    acceleration,
    tradeRate: dt > 0 ? dt / (spanMs / 1000) : undefined,
    precise: false,
  };
}

/* ------------------------------------------------------------------ */
/* 4 + 5 — Trade flow and delta / CVD                                  */
/* ------------------------------------------------------------------ */

/**
 * Aggressive flow, cumulative delta and price/delta divergence.
 *
 * `largeAt` is the notional above which a print counts as a large trade;
 * callers pass a per-symbol value so BTC and a micro-cap are judged on their
 * own scale.
 */
export function readFlow(trades: AggTrade[], largeAt: number, cvdBase = 0): FlowRead {
  const empty: FlowRead = {
    buyVolume: 0,
    sellVolume: 0,
    buyShare: 50,
    delta: 0,
    cvd: cvdBase,
    cvdSeries: [],
    divergence: "none",
    largeBuys: 0,
    largeSells: 0,
    largestNotional: 0,
    tradesPerSec: 0,
    imbalance: 0,
    absorption: "none",
    samples: 0,
  };
  if (!trades.length) return empty;

  let buyVolume = 0;
  let sellVolume = 0;
  let largeBuys = 0;
  let largeSells = 0;
  let largestNotional = 0;

  for (const t of trades) {
    if (t.isBuy) {
      buyVolume += t.notional;
      if (t.notional >= largeAt) largeBuys += 1;
    } else {
      sellVolume += t.notional;
      if (t.notional >= largeAt) largeSells += 1;
    }
    if (t.notional > largestNotional) largestNotional = t.notional;
  }

  const total = buyVolume + sellVolume;
  const delta = buyVolume - sellVolume;
  const imbalance = total > 0 ? delta / total : 0;

  // Sample the CVD curve into ~24 buckets for divergence and the sparkline.
  const first = trades[0].at;
  const last = trades[trades.length - 1].at;
  const spanMs = Math.max(1, last - first);
  const buckets = Math.min(24, Math.max(4, Math.round(trades.length / 12)));
  const step = spanMs / buckets;
  const series: { at: number; price: number; cvd: number }[] = [];
  let running = cvdBase;
  let edge = first + step;
  let lastPrice = trades[0].price;

  for (const t of trades) {
    running += t.isBuy ? t.notional : -t.notional;
    lastPrice = t.price;
    while (t.at >= edge && series.length < buckets) {
      series.push({ at: edge, price: lastPrice, cvd: running });
      edge += step;
    }
  }
  series.push({ at: last, price: lastPrice, cvd: running });

  // Divergence: compare the price extreme against the CVD extreme across the
  // two halves. Price making a higher high while delta makes a lower high is
  // hidden weakness, and the classic upper-wick tell.
  let divergence: FlowRead["divergence"] = "none";
  if (series.length >= 6) {
    const half = Math.floor(series.length / 2);
    const a = series.slice(0, half);
    const b = series.slice(half);
    const priceHiA = Math.max(...a.map((p) => p.price));
    const priceHiB = Math.max(...b.map((p) => p.price));
    const priceLoA = Math.min(...a.map((p) => p.price));
    const priceLoB = Math.min(...b.map((p) => p.price));
    const cvdHiA = Math.max(...a.map((p) => p.cvd));
    const cvdHiB = Math.max(...b.map((p) => p.cvd));
    const cvdLoA = Math.min(...a.map((p) => p.cvd));
    const cvdLoB = Math.min(...b.map((p) => p.cvd));
    const tol = priceHiA > 0 ? priceHiA * 0.0002 : 0;

    if (priceHiB > priceHiA + tol && cvdHiB < cvdHiA) divergence = "bearish";
    else if (priceLoB < priceLoA - tol && cvdLoB > cvdLoA) divergence = "bullish";
  }

  // Absorption: heavy one-sided aggression that price refused to follow.
  let absorption: WickSide = "none";
  const startPrice = trades[0].price;
  const move = startPrice > 0 ? ((lastPrice - startPrice) / startPrice) * 100 : 0;
  if (total > 0 && Math.abs(imbalance) >= 0.25 && Math.abs(move) < 0.12) {
    absorption = imbalance > 0 ? "upper" : "lower";
  }

  return {
    buyVolume,
    sellVolume,
    buyShare: total > 0 ? (buyVolume / total) * 100 : 50,
    delta,
    cvd: running,
    cvdSeries: series,
    divergence,
    largeBuys,
    largeSells,
    largestNotional,
    tradesPerSec: trades.length / Math.max(1, spanMs / 1000),
    imbalance,
    absorption,
    samples: trades.length,
  };
}

/* ------------------------------------------------------------------ */
/* 6 — Order book                                                      */
/* ------------------------------------------------------------------ */

function findWalls(levels: BookLevel[], side: "buy" | "sell", mid: number, minStrength: number): Wall[] {
  if (levels.length < 4) return [];
  const mean = levels.reduce((a, l) => a + l.notional, 0) / levels.length;
  if (!(mean > 0)) return [];
  return levels
    .filter((l) => l.notional >= mean * minStrength)
    .map((l) => ({
      side,
      price: l.price,
      notional: l.notional,
      strength: l.notional / mean,
      distance: mid > 0 ? ((l.price - mid) / mid) * 100 : 0,
    }))
    .sort((a, b) => b.notional - a.notional);
}

/**
 * Book read with wall lifecycle. `previous` is the prior snapshot's walls, used
 * to tell a pulled wall (vanished without trading) from an absorbed one (price
 * reached it and ate through) and from a relocation (reappeared nearby).
 */
export function readBook(
  snapshot: BookSnapshot | undefined,
  minStrength: number,
  previous?: { walls: Wall[]; mid: number },
): BookRead {
  const empty: BookRead = {
    bidNotional: 0,
    askNotional: 0,
    imbalance: 0,
    dominantWall: "none",
    walls: [],
    pulled: 0,
    relocated: 0,
    absorbed: false,
    spoofSuspected: false,
    levels: 0,
  };
  if (!snapshot || !snapshot.bids.length || !snapshot.asks.length) return empty;

  const bestBid = snapshot.bids[0].price;
  const bestAsk = snapshot.asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const bidNotional = snapshot.bids.reduce((a, l) => a + l.notional, 0);
  const askNotional = snapshot.asks.reduce((a, l) => a + l.notional, 0);
  const total = bidNotional + askNotional;

  const buyWalls = findWalls(snapshot.bids, "buy", mid, minStrength);
  const sellWalls = findWalls(snapshot.asks, "sell", mid, minStrength);
  const walls = [...buyWalls, ...sellWalls].sort((a, b) => b.notional - a.notional);
  const top = walls[0];

  let pulled = 0;
  let relocated = 0;
  let absorbed = false;

  if (previous?.walls.length) {
    const tol = mid * 0.0006;
    for (const before of previous.walls) {
      const still = walls.find((w) => w.side === before.side && Math.abs(w.price - before.price) <= tol);
      if (still) continue;
      const near = walls.find(
        (w) => w.side === before.side && Math.abs(w.price - before.price) <= mid * 0.004,
      );
      // Price traded through it → absorbed. Otherwise it was cancelled.
      const tradedThrough =
        before.side === "sell" ? bestBid >= before.price : bestAsk <= before.price;
      if (tradedThrough) absorbed = true;
      else if (near) relocated += 1;
      else pulled += 1;
    }
  }

  return {
    mid,
    bidNotional,
    askNotional,
    imbalance: total > 0 ? (bidNotional - askNotional) / total : 0,
    dominantWall: (top?.side ?? "none") as WallKind,
    wall: top,
    walls: walls.slice(0, 6),
    pulled,
    relocated,
    absorbed,
    // A wall that keeps appearing and cancelling without ever being hit.
    spoofSuspected: pulled >= 2 || (pulled >= 1 && relocated >= 1),
    spread: mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : undefined,
    levels: snapshot.bids.length + snapshot.asks.length,
  };
}
