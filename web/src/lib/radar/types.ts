/**
 * Squeeze Radar — shared types for the micro-structure layer.
 *
 * The macro layer (Liquidity Exhaustion Engine) scans every contract on two
 * all-market streams. The radar is the micro layer underneath it: when a
 * contract reaches 3 of 4 gates it is ARMED, and only then does the radar open
 * live depth, trades and mark-price streams for that one contract. Everything
 * here describes what those streams are reduced to.
 */

import type { AggTrade, BookLevel, BookRead, FlowRead, MarkTick, OiRead, OiPoint, SocketState, Wall } from "@/lib/wick/types";

/** Why a contract has radar streams attached right now. */
export type RadarState =
  /** All four exhaustion gates passed. */
  | "signal"
  /** Three of four gates — the micro layer attaches here. */
  | "armed"
  /** Not armed, but the trader is looking at it or holding it open. */
  | "watch";

export const RADAR_STATE_LABEL: Record<RadarState, string> = {
  signal: "SIGNAL 4/4",
  armed: "ARMED 3/4",
  watch: "WATCH",
};

/** One forced order from `!forceOrder@arr`. `BUY` = a short was liquidated. */
export interface LiquidationEvent {
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  notional: number;
  at: number;
}

export type SqueezeLevel = "cold" | "warm" | "hot";

export interface SqueezeRead {
  /** Forced-order notional inside the rolling window, USD. */
  volume: number;
  /** Shorts liquidated (forced buys) — the fuel of a short squeeze. */
  shortLiq: number;
  /** Longs liquidated (forced sells). */
  longLiq: number;
  level: SqueezeLevel;
  /** Thresholds the level is judged against, derived from the contract's own turnover. */
  medAt: number;
  highAt: number;
  count: number;
  lastAt?: number;
  direction: "short-squeeze" | "long-flush" | "mixed" | "none";
}

/** A price bucket where forced orders clustered. */
export interface LiqCluster {
  price: number;
  lo: number;
  hi: number;
  notional: number;
  longLiq: number;
  shortLiq: number;
  count: number;
  /** Share of all liquidation notional in the window, 0-1. */
  share: number;
  /** Percent from the current price; negative means below. */
  distancePct: number;
}

export interface DepthRow extends BookLevel {
  /** Cumulative notional from the top of the book down to this level. */
  total: number;
  /** True when this level is a whale wall. */
  wall: boolean;
}

export interface DepthRead {
  mid?: number;
  spreadPct?: number;
  bids: DepthRow[];
  asks: DepthRow[];
  bidNotional: number;
  askNotional: number;
  /** Bid share of resting notional, 0-100, every level counted equally. */
  rawBidShare: number;
  /** Bid share with levels near the touch weighted more, 0-100. */
  weightedBidShare: number;
  /** Who dominates the weighted book, and by how many points. */
  pressure: "bids" | "asks" | "balanced";
  pressurePts: number;
  at?: number;
}

export type OiTrend = "rising" | "falling" | "flat" | "unknown";

export interface OiTrendRead {
  trend: OiTrend;
  /** Regression slope over the last 30 minutes as percent of mean OI. */
  slopePct?: number;
  snapshots: number;
  read: OiRead;
  /** Latest value, contracts. */
  current?: number;
  /** Latest value in USD, when the price is known. */
  notionalUsd?: number;
  at?: number;
}

/** Aggressive flow over the rolling window, built from minute buckets. */
export interface FlowWindow {
  buy: number;
  sell: number;
  count: number;
  /** 0-100. */
  buyShare: number;
  /** Minutes with data inside the window. */
  minutes: number;
  whaleBuys: number;
  whaleSells: number;
}

export interface ChartBar {
  /** Bar open time, ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closed: boolean;
}

export type ChartInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export const CHART_INTERVALS: { value: ChartInterval; label: string; ms: number }[] = [
  { value: "1m", label: "1m", ms: 60_000 },
  { value: "5m", label: "5m", ms: 5 * 60_000 },
  { value: "15m", label: "15m", ms: 15 * 60_000 },
  { value: "30m", label: "30m", ms: 30 * 60_000 },
  { value: "1h", label: "1H", ms: 60 * 60_000 },
  { value: "4h", label: "4H", ms: 4 * 60 * 60_000 },
  { value: "1d", label: "1D", ms: 24 * 60 * 60_000 },
];

/** Everything the radar shows for one attached contract. */
export interface RadarRead {
  symbol: string;
  state: RadarState;
  attachedAt: number;
  /** Macro-layer gates passed, 0-4. */
  gates: number;

  depth: DepthRead;
  book: BookRead;
  bidWalls: Wall[];
  askWalls: Wall[];

  /** 1h aggressive flow from minute buckets. */
  flow: FlowWindow;
  /** Short-window read over the newest raw prints: CVD, absorption, divergence. */
  recent: FlowRead;
  /** Newest prints first, for the tape. */
  trades: AggTrade[];
  /** Newest large prints first. */
  whales: AggTrade[];
  /** Notional above which a print counts as a whale. */
  whaleAt: number;

  squeeze: SqueezeRead;
  /** Newest first. */
  liquidations: LiquidationEvent[];
  clusters: LiqCluster[];

  oi: OiTrendRead;
  /** When the open-interest endpoints were last asked, whether or not they answered. */
  oiPolledAt?: number;
  mark?: MarkTick;

  lastDepthAt?: number;
  lastTradeAt?: number;
}

/**
 * Binance's routed futures endpoints. `/public` serves the book streams
 * (depth, book ticker, raw trades); `/market` serves everything else
 * (aggregate trades, mark price, klines, tickers, liquidations). A stream
 * subscribed on the wrong route is acknowledged and never delivered.
 */
export type StreamRoute = "public" | "market";

/** One socket's health. */
export interface SocketStatus {
  state: SocketState;
  /** Streams the socket is subscribed to right now. */
  streams: number;
  retries: number;
  endpoint?: string;
  openedAt?: number;
  lastMessageAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** Messages received since the socket opened. */
  messages: number;
}

/** Both radar sockets combined, with the per-route detail alongside. */
export interface RadarStreamStatus extends SocketStatus {
  routes: Record<StreamRoute, SocketStatus>;
}

export interface RadarChart {
  symbol: string;
  interval: ChartInterval;
  bars: ChartBar[];
  loadedAt: number;
  loading: boolean;
  error?: string;
}

/** Live OI point from REST, same shape as the history points. */
export type OiSample = OiPoint;
