/**
 * Engines 7-10: liquidity mapping, volume profile, VWAP and market structure.
 * All derived from kline history, all pure.
 */

import type {
  Kline,
  LevelKind,
  LiquidityLevel,
  LiquidityRead,
  Pivot,
  PivotKind,
  ProfileRead,
  StructureRead,
  TrendDir,
  VwapRead,
} from "./types";

/** Importance of each level kind as stop-loss magnet. */
const KIND_WEIGHT: Record<LevelKind, number> = {
  "equal-highs": 1,
  "equal-lows": 1,
  pmh: 0.95,
  pml: 0.95,
  pwh: 0.85,
  pwl: 0.85,
  pdh: 0.75,
  pdl: 0.75,
  "swing-high": 0.5,
  "swing-low": 0.5,
};

const KIND_LABEL: Record<LevelKind, string> = {
  "equal-highs": "Equal highs",
  "equal-lows": "Equal lows",
  pmh: "Prev month high",
  pml: "Prev month low",
  pwh: "Prev week high",
  pwl: "Prev week low",
  pdh: "Prev day high",
  pdl: "Prev day low",
  "swing-high": "Swing high",
  "swing-low": "Swing low",
};

/* ------------------------------------------------------------------ */
/* 10 — Market structure                                               */
/* ------------------------------------------------------------------ */

/** Fractal pivots: a high with `k` lower highs either side, and vice versa. */
export function findPivots(klines: Kline[], k = 2): { at: number; price: number; type: "high" | "low" }[] {
  const out: { at: number; price: number; type: "high" | "low" }[] = [];
  for (let i = k; i < klines.length - k; i += 1) {
    const bar = klines[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (klines[j].high >= bar.high) isHigh = false;
      if (klines[j].low <= bar.low) isLow = false;
    }
    if (isHigh) out.push({ at: bar.openTime, price: bar.high, type: "high" });
    if (isLow) out.push({ at: bar.openTime, price: bar.low, type: "low" });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Wilder-free ATR as a percent of the last close. */
export function atrPct(klines: Kline[], period = 14): number {
  if (klines.length < 2) return 0;
  const slice = klines.slice(-(period + 1));
  let sum = 0;
  let n = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].close;
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - prev),
      Math.abs(slice[i].low - prev),
    );
    sum += tr;
    n += 1;
  }
  const last = slice[slice.length - 1].close;
  if (!n || !(last > 0)) return 0;
  return (sum / n / last) * 100;
}

export function readStructure(klines: Kline[]): StructureRead {
  const empty: StructureRead = {
    trend: "ranging",
    pivots: [],
    bos: "none",
    choch: "none",
    phase: "neutral",
    atrPct: 0,
    falseBreakout: false,
    falseBreakdown: false,
  };
  if (klines.length < 20) return empty;

  const raw = findPivots(klines, 2);
  const pivots: Pivot[] = [];
  let prevHigh: number | undefined;
  let prevLow: number | undefined;

  for (const p of raw) {
    if (p.type === "high") {
      const previous = prevHigh;
      const kind: PivotKind = previous === undefined ? "HH" : p.price > previous ? "HH" : "LH";
      pivots.push({ ...p, kind, seed: previous === undefined });
      prevHigh = p.price;
    } else {
      const previous = prevLow;
      const kind: PivotKind = previous === undefined ? "HL" : p.price > previous ? "HL" : "LL";
      pivots.push({ ...p, kind, seed: previous === undefined });
      prevLow = p.price;
    }
  }

  // The first pivot of each type had nothing to compare against, so it must not
  // vote — otherwise every series opens with two free bullish votes and a clean
  // downtrend reads as "ranging".
  const recent = pivots.slice(-8);
  const highs = recent.filter((p) => p.type === "high" && !p.seed);
  const lows = recent.filter((p) => p.type === "low" && !p.seed);
  const upVotes =
    highs.filter((p) => p.kind === "HH").length + lows.filter((p) => p.kind === "HL").length;
  const downVotes =
    highs.filter((p) => p.kind === "LH").length + lows.filter((p) => p.kind === "LL").length;

  let trend: TrendDir = "ranging";
  if (upVotes >= downVotes + 2) trend = "bullish";
  else if (downVotes >= upVotes + 2) trend = "bearish";

  const lastHigh = highs.length ? highs[highs.length - 1].price : undefined;
  const lastLow = lows.length ? lows[lows.length - 1].price : undefined;
  const close = klines[klines.length - 1].close;

  // BOS: close beyond the most recent opposing pivot.
  let bos: StructureRead["bos"] = "none";
  if (lastHigh !== undefined && close > lastHigh) bos = "bullish";
  else if (lastLow !== undefined && close < lastLow) bos = "bearish";

  // CHoCH: a break against the prevailing trend.
  let choch: StructureRead["choch"] = "none";
  if (trend === "bullish" && bos === "bearish") choch = "bearish";
  else if (trend === "bearish" && bos === "bullish") choch = "bullish";

  // Compression vs expansion: recent range against the older range.
  const recentAtr = atrPct(klines, 10);
  const olderAtr = atrPct(klines.slice(0, -10), 20);
  let phase: StructureRead["phase"] = "neutral";
  if (olderAtr > 0) {
    const ratio = recentAtr / olderAtr;
    if (ratio < 0.7) phase = "compression";
    else if (ratio > 1.4) phase = "expansion";
  }

  // False break: a bar pierced the pivot but closed back inside, recently.
  const tail = klines.slice(-6);
  const falseBreakout =
    lastHigh !== undefined && tail.some((b) => b.high > lastHigh && b.close < lastHigh);
  const falseBreakdown =
    lastLow !== undefined && tail.some((b) => b.low < lastLow && b.close > lastLow);

  return {
    trend,
    pivots: pivots.slice(-24),
    lastHigh,
    lastLow,
    bos,
    choch,
    phase,
    atrPct: recentAtr,
    falseBreakout,
    falseBreakdown,
  };
}

/* ------------------------------------------------------------------ */
/* 7 — Liquidity                                                       */
/* ------------------------------------------------------------------ */

/** Group daily bars into period highs/lows (previous completed period). */
function periodExtremes(
  daily: Kline[],
  bucket: (d: Date) => string,
): { high: number; low: number } | undefined {
  if (daily.length < 2) return undefined;
  const groups = new Map<string, { high: number; low: number; at: number }>();
  for (const bar of daily) {
    const key = bucket(new Date(bar.openTime));
    const g = groups.get(key);
    if (!g) groups.set(key, { high: bar.high, low: bar.low, at: bar.openTime });
    else {
      g.high = Math.max(g.high, bar.high);
      g.low = Math.min(g.low, bar.low);
      g.at = Math.max(g.at, bar.openTime);
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.at - b.at);
  // The last group is the period in progress; take the one before it.
  return ordered.length >= 2 ? ordered[ordered.length - 2] : undefined;
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/**
 * Where stop-loss liquidity is likely to be resting.
 *
 * Swing pivots and prior-period extremes are the prices retail stops cluster
 * behind; equal highs/lows are the strongest magnets because two failures at the
 * same price stack orders on top of each other.
 */
export function readLiquidity(klines5m: Kline[], daily: Kline[], price: number): LiquidityRead {
  const empty: LiquidityRead = {
    levels: [],
    equalHighs: [],
    equalLows: [],
    allLevels: [],
    poolAbove: 0,
    poolBelow: 0,
    fakeBreakout: false,
    fakeBreakdown: false,
    breakoutZone: false,
    breakdownZone: false,
  };
  if (klines5m.length < 20 || !(price > 0)) return empty;

  const raw: { kind: LevelKind; price: number; at: number }[] = [];
  const pivots = findPivots(klines5m, 3);
  const newest = klines5m[klines5m.length - 1].openTime;

  for (const p of pivots) {
    raw.push({ kind: p.type === "high" ? "swing-high" : "swing-low", price: p.price, at: p.at });
  }

  const day = periodExtremes(daily, (d) => d.toISOString().slice(0, 10));
  const week = periodExtremes(daily, isoWeek);
  const month = periodExtremes(daily, (d) => d.toISOString().slice(0, 7));
  if (day) {
    raw.push({ kind: "pdh", price: day.high, at: newest });
    raw.push({ kind: "pdl", price: day.low, at: newest });
  }
  if (week) {
    raw.push({ kind: "pwh", price: week.high, at: newest });
    raw.push({ kind: "pwl", price: week.low, at: newest });
  }
  if (month) {
    raw.push({ kind: "pmh", price: month.high, at: newest });
    raw.push({ kind: "pml", price: month.low, at: newest });
  }

  // Cluster nearby prices; a cluster of 2+ swing pivots becomes equal highs/lows.
  const tol = price * 0.0015;
  const clusters: { kind: LevelKind; price: number; at: number; touches: number }[] = [];
  for (const level of raw.sort((a, b) => a.price - b.price)) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.price - level.price) <= tol) {
      last.touches += 1;
      last.at = Math.max(last.at, level.at);
      // A named period extreme outranks a plain swing in the merged label.
      if (KIND_WEIGHT[level.kind] > KIND_WEIGHT[last.kind]) last.kind = level.kind;
      else if (last.kind === "swing-high" && level.kind === "swing-high") last.kind = "equal-highs";
      else if (last.kind === "swing-low" && level.kind === "swing-low") last.kind = "equal-lows";
    } else {
      clusters.push({ ...level, touches: 1 });
    }
  }

  const spanMs = newest - klines5m[0].openTime || 1;
  const levels: LiquidityLevel[] = clusters.map((c) => {
    const recency = Math.min(1, Math.max(0.35, 1 - (newest - c.at) / spanMs));
    const touchBoost = Math.min(1, 0.55 + c.touches * 0.22);
    return {
      kind: c.kind,
      price: c.price,
      distance: ((c.price - price) / price) * 100,
      touches: c.touches,
      weight: Math.min(1, KIND_WEIGHT[c.kind] * touchBoost * recency),
      side: c.price >= price ? "above" : "below",
      label: c.touches > 1 && (c.kind === "equal-highs" || c.kind === "equal-lows")
        ? `${KIND_LABEL[c.kind]} ×${c.touches}`
        : KIND_LABEL[c.kind],
    };
  });

  // Pool density: weight levels by importance, decayed by distance. Liquidity
  // 8% away cannot be swept this hour; liquidity 0.4% away can.
  const near = (l: LiquidityLevel): number => {
    const d = Math.abs(l.distance);
    const decay = Math.exp(-d / 2.2);
    return l.weight * decay;
  };
  const above = levels.filter((l) => l.side === "above");
  const below = levels.filter((l) => l.side === "below");
  const density = (arr: LiquidityLevel[]): number =>
    Math.min(100, Math.round(arr.reduce((a, l) => a + near(l), 0) * 42));

  const resistances = above.sort((a, b) => a.distance - b.distance);
  const supports = below.sort((a, b) => b.distance - a.distance);
  const nearestResistance = resistances[0];
  const nearestSupport = supports[0];

  const structure = readStructure(klines5m);

  // Taken before the visible map is trimmed to twelve rows, so the liquidity
  // averages stay anchored to every equal level rather than to whichever ones
  // happen to be nearest price this second.
  const equalHighs = levels.filter((l) => l.kind === "equal-highs").map((l) => l.price);
  const equalLows = levels.filter((l) => l.kind === "equal-lows").map((l) => l.price);

  return {
    levels: [...resistances.slice(0, 6), ...supports.slice(0, 6)],
    equalHighs,
    equalLows,
    allLevels: levels,
    poolAbove: density(above),
    poolBelow: density(below),
    nearestResistance,
    nearestSupport,
    fakeBreakout: structure.falseBreakout,
    fakeBreakdown: structure.falseBreakdown,
    breakoutZone:
      nearestResistance !== undefined &&
      nearestResistance.distance <= 0.6 &&
      nearestResistance.weight >= 0.5,
    breakdownZone:
      nearestSupport !== undefined &&
      nearestSupport.distance >= -0.6 &&
      nearestSupport.weight >= 0.5,
  };
}

/* ------------------------------------------------------------------ */
/* 8 — Volume profile                                                  */
/* ------------------------------------------------------------------ */

/**
 * Volume profile over the supplied bars. Each bar's volume is spread across the
 * bins its range covers rather than dumped on the typical price, so a wide bar
 * does not create a phantom node.
 */
export function readProfile(klines: Kline[], price: number, binCount = 48): ProfileRead | undefined {
  if (klines.length < 12 || !(price > 0)) return undefined;

  const hi = Math.max(...klines.map((k) => k.high));
  const lo = Math.min(...klines.map((k) => k.low));
  if (!(hi > lo)) return undefined;

  const step = (hi - lo) / binCount;
  const bins = new Array<number>(binCount).fill(0);

  for (const bar of klines) {
    const from = Math.max(0, Math.floor((bar.low - lo) / step));
    const to = Math.min(binCount - 1, Math.floor((bar.high - lo) / step));
    const spread = to - from + 1;
    const share = bar.quoteVolume / spread;
    for (let i = from; i <= to; i += 1) bins[i] += share;
  }

  const priceOf = (i: number): number => lo + step * (i + 0.5);
  const total = bins.reduce((a, b) => a + b, 0);
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i += 1) if (bins[i] > bins[pocIdx]) pocIdx = i;

  // Value area: expand from the POC outward until 70% of volume is enclosed.
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  let acc = bins[pocIdx];
  const target = total * 0.7;
  while (acc < target && (lowIdx > 0 || highIdx < binCount - 1)) {
    const nextLow = lowIdx > 0 ? bins[lowIdx - 1] : -1;
    const nextHigh = highIdx < binCount - 1 ? bins[highIdx + 1] : -1;
    if (nextHigh >= nextLow) {
      highIdx += 1;
      acc += nextHigh;
    } else {
      lowIdx -= 1;
      acc += nextLow;
    }
  }

  const mean = total / binCount;
  const hvn: number[] = [];
  const lvn: number[] = [];
  for (let i = 0; i < binCount; i += 1) {
    if (bins[i] >= mean * 1.6) hvn.push(priceOf(i));
    else if (bins[i] <= mean * 0.35) lvn.push(priceOf(i));
  }

  const poc = priceOf(pocIdx);
  const vah = priceOf(highIdx);
  const val = priceOf(lowIdx);
  const currentIdx = Math.min(binCount - 1, Math.max(0, Math.floor((price - lo) / step)));

  return {
    poc,
    vah,
    val,
    pocDistance: ((price - poc) / poc) * 100,
    hvn,
    lvn,
    acceptance: price > vah ? "above" : price < val ? "below" : "inside",
    inLvn: bins[currentIdx] <= mean * 0.35,
    bins: bins.map((volume, i) => ({ price: priceOf(i), volume })),
  };
}

/* ------------------------------------------------------------------ */
/* 9 — VWAP                                                            */
/* ------------------------------------------------------------------ */

/**
 * Session VWAP anchored at the most recent UTC midnight, with standard-deviation
 * bands. Falls back to the whole supplied series when the anchor would leave too
 * few bars to be meaningful.
 */
export function readVwap(klines: Kline[], price: number): VwapRead | undefined {
  if (klines.length < 6 || !(price > 0)) return undefined;

  const last = klines[klines.length - 1].openTime;
  const dayStart = Date.UTC(
    new Date(last).getUTCFullYear(),
    new Date(last).getUTCMonth(),
    new Date(last).getUTCDate(),
  );
  let session = klines.filter((k) => k.openTime >= dayStart);
  if (session.length < 6) session = klines.slice(-Math.min(klines.length, 96));

  let pv = 0;
  let vol = 0;
  for (const bar of session) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume > 0 ? bar.volume : bar.quoteVolume;
    pv += typical * v;
    vol += v;
  }
  if (!(vol > 0)) return undefined;
  const vwap = pv / vol;

  let varSum = 0;
  for (const bar of session) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume > 0 ? bar.volume : bar.quoteVolume;
    varSum += v * (typical - vwap) ** 2;
  }
  const sd = Math.sqrt(varSum / vol);
  const deviation = ((price - vwap) / vwap) * 100;
  const sigma = sd > 0 ? (price - vwap) / sd : 0;

  return {
    vwap,
    upper1: vwap + sd,
    upper2: vwap + sd * 2,
    lower1: vwap - sd,
    lower2: vwap - sd * 2,
    deviation,
    sigma,
    position: Math.abs(deviation) < 0.05 ? "at" : deviation > 0 ? "above" : "below",
    // Saturates around 2.5σ, where a snap back to the mean is the base case.
    meanReversion: Math.min(100, Math.round((Math.abs(sigma) / 2.5) * 100)),
  };
}
