/**
 * Market Confluence Analysis — an additional, clearly-labelled analytical
 * module. It READS the engine's data and the always-on instrument streams and
 * never writes back: the four-gate exhaustion engine, its thresholds and its
 * verdicts are untouched by anything here.
 *
 * Each measurement row carries the current value, the previous value, the
 * direction of change, the data timestamp and the reading of what it would
 * mean for a bullish, bearish or neutral case. The roll-up at the bottom is a
 * vote count, NOT a probability of success.
 *
 * Pure module: no React, no sockets.
 */

import type { RadarRead } from "@/lib/radar/types";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { LiquidityRead, OiRead, VwapRead } from "@/lib/wick/types";
import { fmtCompactUsd, fmtPrice, fmtSignedPct } from "@/lib/format";

export type Bias = "bullish" | "bearish" | "neutral";
export type Dir = "up" | "down" | "flat" | "unknown";

export interface ConfluenceRow {
  key: string;
  label: string;
  /** Current value, formatted. "n/a" when the data is not live. */
  current: string;
  previous?: string;
  dir: Dir;
  /** Age of the reading, ms epoch; undefined = no data. */
  at?: number;
  bias: Bias;
  /** What the reading means in each language. */
  bull: string;
  bear: string;
  neutral: string;
}

export interface ConfluenceInput {
  macro?: ExhaustionRead;
  radar?: RadarRead;
  oi?: OiRead;
  oiPrev?: OiRead;
  vwap?: VwapRead;
  structure?: LiquidityRead;
  /** Closed 1H wick signals per side, trailing 24h. */
  upperWicks24h?: number;
  lowerWicks24h?: number;
}

function dirOf(current: number | undefined, previous: number | undefined): Dir {
  if (current === undefined || previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous)) return "unknown";
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

function biasOf(score: number): Bias {
  return score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
}

const NA = "n/a";

/** The full row set, panel order. Rows with no data still appear, marked so. */
export function buildConfluence(input: ConfluenceInput): ConfluenceRow[] {
  const { macro, radar, oi, oiPrev, vwap, structure, upperWicks24h, lowerWicks24h } = input;
  const rows: ConfluenceRow[] = [];

  /* 1 — price action */
  const price = macro?.price;
  const prevPrice = radar?.recent?.cvdSeries?.length ? undefined : undefined;
  const change = macro?.changePct;
  rows.push({
    key: "price",
    label: "Price action",
    current: price ? fmtPrice(price) : NA,
    previous: prevPrice !== undefined ? fmtPrice(prevPrice) : change !== undefined ? `24h ${fmtSignedPct(change, 2)}` : undefined,
    dir: dirOf(change, 0),
    at: macro?.at,
    bias: biasOf((change ?? 0) > 0.05 ? 1 : (change ?? 0) < -0.05 ? -1 : 0),
    bull: "Uptrend supports breakout follow-through",
    bear: "Downtrend supports failed breakouts",
    neutral: "Range — trade the extremes, not the middle",
  });

  /* 2 — volume / RVOL */
  const rvol = macro?.rvol;
  const rvolAccel = macro?.rvolAcceleration;
  rows.push({
    key: "rvol",
    label: "Volume · RVOL",
    current: rvol === undefined ? NA : `${Math.round(rvol)}%`,
    previous: rvolAccel === undefined ? undefined : `accel ${rvolAccel > 0 ? "+" : ""}${Math.round(rvolAccel)}`,
    dir: dirOf(rvolAccel === undefined ? undefined : rvolAccel, 0),
    at: macro?.at,
    bias: biasOf((rvol ?? 0) >= 300 && (rvolAccel ?? 0) <= 0 ? -1 : (rvol ?? 0) >= 150 ? 1 : 0),
    bull: "Volume expansion confirms the move",
    bear: "Climax + cooling marks exhaustion",
    neutral: "Volume unremarkable",
  });

  /* 3 — VWAP distance */
  const dev = vwap?.deviation;
  rows.push({
    key: "vwap",
    label: "VWAP distance",
    current: dev === undefined ? NA : fmtSignedPct(dev, 2),
    previous: vwap ? `σ ${vwap.sigma.toFixed(2)}` : undefined,
    dir: dirOf(dev, 0),
    at: vwap ? Date.now() : undefined,
    bias: biasOf((dev ?? 0) > 1 ? -1 : (dev ?? 0) < -1 ? 1 : 0),
    bull: "Stretched below VWAP — mean-reversion bid",
    bear: "Stretched above VWAP — mean-reversion offer",
    neutral: "Near value",
  });

  /* 4 — order-book imbalance (weighted) */
  const imb = radar?.depth.weightedBidShare;
  const rawImb = radar?.depth.rawBidShare;
  rows.push({
    key: "imbalance",
    label: "Book imbalance",
    current: imb === undefined ? NA : `${imb.toFixed(1)}% bid`,
    previous: rawImb === undefined ? undefined : `raw ${rawImb.toFixed(1)}%`,
    dir: dirOf(imb, rawImb),
    at: radar?.depth.at,
    bias: biasOf((imb ?? 50) > 60 ? 1 : (imb ?? 50) < 40 ? -1 : 0),
    bull: "Bids dominate the weighted book",
    bear: "Asks dominate the weighted book",
    neutral: "Balanced book",
  });

  /* 5 — bid vs ask liquidity */
  const bidN = radar?.depth.bidNotional;
  const askN = radar?.depth.askNotional;
  rows.push({
    key: "liquidity",
    label: "Bid vs ask liquidity",
    current: bidN === undefined || askN === undefined ? NA : `${fmtCompactUsd(bidN)} / ${fmtCompactUsd(askN)}`,
    previous: undefined,
    dir: dirOf(bidN, askN),
    at: radar?.depth.at,
    bias: biasOf(bidN !== undefined && askN ? (bidN > askN * 1.2 ? 1 : bidN < askN * 0.8 ? -1 : 0) : 0),
    bull: "Resting liquidity stacks on the bid",
    bear: "Resting liquidity stacks on the offer",
    neutral: "Two-sided book",
  });

  /* 6 — whale activity */
  const whales = radar?.whales.length ?? 0;
  const whaleBuys = radar?.flow.whaleBuys ?? 0;
  const whaleSells = radar?.flow.whaleSells ?? 0;
  rows.push({
    key: "whales",
    label: "Whale activity",
    current: whales ? `${whales} prints ≥ ${fmtCompactUsd(radar?.whaleAt ?? 0)}` : NA,
    previous: whaleBuys || whaleSells ? `${whaleBuys}B / ${whaleSells}S (1h)` : undefined,
    dir: dirOf(whaleBuys, whaleSells),
    at: radar?.lastTradeAt,
    bias: biasOf(whaleBuys > whaleSells ? 1 : whaleSells > whaleBuys ? -1 : 0),
    bull: "Large aggressive buying",
    bear: "Large aggressive selling",
    neutral: "No whale prints in the window",
  });

  /* 7 — open interest */
  const oiNow = oi?.change5m ?? oi?.change15m;
  rows.push({
    key: "oi",
    label: "Open interest",
    current:
      oi?.openInterest === undefined
        ? NA
        : `${fmtCompactUsd(oi.notional ?? 0)}${oiNow !== undefined ? ` · ${fmtSignedPct(oiNow, 2)}` : ""}`,
    previous: oiPrev ? `prev ${fmtSignedPct(oiPrev.change5m ?? oiPrev.change15m ?? 0, 2)}` : undefined,
    dir: dirOf(oiNow, oiPrev?.change5m ?? oiPrev?.change15m),
    at: radar?.oiPolledAt,
    bias: biasOf((oiNow ?? 0) > 0.15 ? 1 : (oiNow ?? 0) < -0.15 ? -1 : 0),
    bull: "New positions back the move",
    bear: "Positions closing — move losing fuel",
    neutral: "Open interest steady",
  });

  /* 8 — funding */
  const fr = radar?.mark?.fundingRate ?? undefined;
  rows.push({
    key: "funding",
    label: "Funding rate",
    current: fr === undefined ? NA : `${fr >= 0 ? "+" : ""}${fr.toFixed(4)}%`,
    previous: undefined,
    dir: dirOf(fr, 0),
    at: radar?.mark?.at,
    bias: biasOf((fr ?? 0) > 0.03 ? -1 : (fr ?? 0) < -0.03 ? 1 : 0),
    bull: "Negative funding — shorts pay, squeeze fuel",
    bear: "Positive funding — crowded longs pay",
    neutral: "Funding unremarkable",
  });

  /* 9 — CVD */
  const cvd = radar?.recent.cvd;
  const div = radar?.recent.divergence;
  rows.push({
    key: "cvd",
    label: "CVD",
    current: cvd === undefined ? NA : fmtSignedUsd(cvd),
    previous: div && div !== "none" ? `${div} divergence` : undefined,
    dir: dirOf(cvd, 0),
    at: radar?.lastTradeAt,
    bias: biasOf((cvd ?? 0) > 0 ? 1 : (cvd ?? 0) < 0 ? -1 : 0),
    bull: "Aggressive buyers in control",
    bear: "Aggressive sellers in control",
    neutral: "Delta balanced",
  });

  /* 10 — liquidation clusters */
  const clusters = radar?.clusters ?? [];
  const clusterTop = clusters[0];
  rows.push({
    key: "clusters",
    label: "Liquidation clusters",
    current: clusterTop ? `${clusters.length} · ${fmtCompactUsd(clusterTop.notional)} @ ${fmtPrice(clusterTop.price)}` : NA,
    previous: undefined,
    dir: clusters.length ? "up" : "unknown",
    at: radar?.liquidations[0]?.at,
    bias: clusterTop ? (clusterTop.shortLiq >= clusterTop.longLiq ? "bullish" : "bearish") : "neutral",
    bull: "Short liquidations cluster overhead — squeeze magnet",
    bear: "Long liquidations cluster below — flush magnet",
    neutral: "No forced-order cluster in the window",
  });

  /* 11 — squeeze */
  const sq = radar?.squeeze;
  rows.push({
    key: "squeeze",
    label: "Squeeze activity",
    current: sq ? `${sq.level.toUpperCase()} · ${fmtCompactUsd(sq.volume)}` : NA,
    previous: sq?.direction && sq.direction !== "none" ? sq.direction.replace("-", " ") : undefined,
    dir: sq?.level === "hot" ? "up" : sq?.level === "warm" ? "flat" : "unknown",
    at: sq?.lastAt,
    bias: biasOf(sq?.direction === "short-squeeze" ? 1 : sq?.direction === "long-flush" ? -1 : 0),
    bull: "Forced buying — short squeeze in progress",
    bear: "Forced selling — long flush in progress",
    neutral: "Liquidation pressure quiet",
  });

  /* 12 — 24h high/low position */
  const rangePos = macro?.rangePos;
  rows.push({
    key: "range",
    label: "24h range position",
    current: rangePos === undefined ? NA : `${Math.round(rangePos * 100)}%`,
    previous: macro ? `H ${fmtPrice(macro.high24h)} · L ${fmtPrice(macro.low24h)}` : undefined,
    dir: dirOf(rangePos, 0.5),
    at: macro?.at,
    bias: biasOf((rangePos ?? 0.5) > 0.9 ? -1 : (rangePos ?? 0.5) < 0.1 ? 1 : 0),
    bull: "Near the 24h low — stops below, upside room",
    bear: "Near the 24h high — breakout-squeeze zone",
    neutral: "Mid-range",
  });

  /* 13 — support / resistance */
  const sup = structure?.nearestSupport;
  const res = structure?.nearestResistance;
  rows.push({
    key: "levels",
    label: "Support / resistance",
    current: sup || res ? `${sup ? `S ${fmtPrice(sup.price)}` : "S n/a"} · ${res ? `R ${fmtPrice(res.price)}` : "R n/a"}` : NA,
    previous: structure ? `${structure.levels.length} mapped levels` : undefined,
    dir: "unknown",
    at: macro?.at,
    bias: "neutral",
    bull: "Support holding above maps the upside path",
    bear: "Resistance capping maps the rejection path",
    neutral: "Structure informational only",
  });

  /* 14 — wick activity */
  const up = upperWicks24h ?? 0;
  const low = lowerWicks24h ?? 0;
  rows.push({
    key: "wicks",
    label: "1H wick activity (24h)",
    current: upperWicks24h === undefined && lowerWicks24h === undefined ? NA : `${up} upper · ${low} lower`,
    previous: undefined,
    dir: dirOf(up, low),
    bias: biasOf(low > up ? 1 : up > low ? -1 : 0),
    bull: "Lower-wick rejections dominate — buyers defending",
    bear: "Upper-wick rejections dominate — sellers capping",
    neutral: "Wick activity balanced",
  });

  return rows;
}

function fmtSignedUsd(v: number): string {
  return `${v >= 0 ? "+" : ""}${fmtCompactUsd(v)}`;
}

export interface ConfluenceVote {
  bullish: number;
  bearish: number;
  neutral: number;
}

/** Straight vote count across rows with a bias — an additional score, never a probability. */
export function confluenceVote(rows: ConfluenceRow[]): ConfluenceVote {
  const vote: ConfluenceVote = { bullish: 0, bearish: 0, neutral: 0 };
  for (const row of rows) vote[row.bias] += 1;
  return vote;
}
