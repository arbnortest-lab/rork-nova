/**
 * Liquidity Exhaustion Engine — shared types.
 *
 * ONE DIRECTION ONLY. This engine trades bull traps: failed breakouts at the
 * 24h high, taken short. Bear traps, capitulation lows and long setups are out
 * of scope by specification, which is why `TrapSide` has no "long" member —
 * a long signal is unrepresentable rather than merely unused.
 *
 * A signal is published when, and only when, all four gates hold at once:
 *
 *   1. PIN        price reaches, sweeps or pins the rolling 24h HIGH
 *   2. CLIMAX     relative volume spikes past the climax bar and is cooling
 *   3. TRAP       a lower-timeframe higher high is rejected by an upper wick
 *                 worth at least 45% of the candle's range
 *   4. DEPLETION  the liquidity pool ABOVE is swept — a long-horizon high with
 *                 no resting depth left to expand into
 *
 * The engine runs in two tiers, because a browser cannot hold kline history for
 * every contract on the venue at once:
 *
 * TIER 1 — BREADTH. Every USDT perpetual, fed by two all-market streams
 *   (`!ticker@arr`, `!markPrice@arr@1s`). Powers gates 1 and 2 for all ~500
 *   symbols simultaneously, which is what ranks candidates for tier 2.
 *
 * TIER 2 — DEPTH. Top-ranked candidates (plus anything pinned) additionally get
 *   kline history, aggregate trades and depth. Powers gates 3 and 4.
 *
 * Every gate reports whether it could actually be measured, so a verdict always
 * travels with its coverage. An unmeasured gate never counts as passed.
 */

export type WickSide = "upper" | "lower" | "none";
export type TrendDir = "bullish" | "bearish" | "ranging";

/**
 * The direction of a published signal.
 *
 * Deliberately has no "long": this engine is short-only, and encoding that in
 * the type means the compiler rejects a long signal rather than trusting every
 * call site to remember.
 */
export type TrapSide = "short" | "none";

/** The price/open-interest matrix. */
export type OiRegime = "new-longs" | "new-shorts" | "short-covering" | "long-liquidation" | "flat";

/* ------------------------------------------------------------------ */
/* Normalised stream payloads                                          */
/* ------------------------------------------------------------------ */

/** One row of `!ticker@arr` — 24h rolling stats. */
export interface TickerTick {
  symbol: string;
  last: number;
  open: number;
  high: number;
  low: number;
  /** Binance's own 24h volume-weighted average price. */
  vwap24h: number;
  quoteVolume: number;
  trades: number;
  at: number;
}

/** One row of `!markPrice@arr@1s`. */
export interface MarkTick {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  /** Percent — converted from the fraction Binance sends. */
  fundingRate: number;
  nextFundingTime: number;
  at: number;
}

/** One aggregate trade from `<symbol>@aggTrade`. */
export interface AggTrade {
  price: number;
  qty: number;
  notional: number;
  /** Binance sends `m` = "buyer is the maker", so an aggressive buy is `m === false`. */
  isBuy: boolean;
  at: number;
}

export interface BookLevel {
  price: number;
  qty: number;
  notional: number;
}

export interface BookSnapshot {
  bids: BookLevel[];
  asks: BookLevel[];
  at: number;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}

export interface OiPoint {
  at: number;
  /** Open interest in contracts. */
  openInterest: number;
  /** Notional in USD, when the endpoint provides it. */
  notional?: number;
}

/* ------------------------------------------------------------------ */
/* Engine outputs                                                      */
/* ------------------------------------------------------------------ */

export interface OiRead {
  openInterest?: number;
  notional?: number;
  change5m?: number;
  change15m?: number;
  change1h?: number;
  change4h?: number;
  change1d?: number;
  regime: OiRegime;
  /** Window behind the headline number, in minutes. */
  headlineWindowMins?: number;
  headlineChange?: number;
  points: number;
}

export interface FundingRead {
  rate?: number;
  countdownMs?: number;
  /** Annualised, assuming the current rate persists across 8h intervals. */
  annualised?: number;
  /** Mean of recent settled rates, when history is loaded. */
  average?: number;
  extreme: boolean;
  crowd: "longs" | "shorts" | "balanced";
  /** Mark-vs-index premium, percent. */
  basis?: number;
}

export interface VolumeRead {
  quoteVolume24h: number;
  /** Instantaneous turnover, USD per second. */
  rate?: number;
  /** Relative volume as a percentage; 100 = normal for this contract. */
  rvol?: number;
  spike: boolean;
  /** Change in RVOL across recent samples — is the surge still building? */
  acceleration?: number;
  trades24h: number;
  tradeRate?: number;
  /** True when RVOL came from kline history rather than the rolling ticker. */
  precise: boolean;
}

export interface FlowRead {
  buyVolume: number;
  sellVolume: number;
  /** Share of aggressive flow that was buying, 0-100. */
  buyShare: number;
  delta: number;
  /** Cumulative volume delta since the deep watch attached. */
  cvd: number;
  cvdSeries: { at: number; price: number; cvd: number }[];
  divergence: "bullish" | "bearish" | "none";
  largeBuys: number;
  largeSells: number;
  largestNotional: number;
  tradesPerSec: number;
  /** Aggressive flow imbalance, -1 (all selling) to +1 (all buying). */
  imbalance: number;
  /** Heavy one-sided flow that failed to move price. */
  absorption: WickSide;
  samples: number;
}

export type WallKind = "buy" | "sell" | "none";

export interface Wall {
  side: "buy" | "sell";
  price: number;
  notional: number;
  /** Multiple of the mean level notional on that side. */
  strength: number;
  /** Percent away from mid. */
  distance: number;
}

export interface BookRead {
  mid?: number;
  bidNotional: number;
  askNotional: number;
  /** -1 (asks dominate) to +1 (bids dominate). */
  imbalance: number;
  dominantWall: WallKind;
  wall?: Wall;
  walls: Wall[];
  /** Walls that vanished without price trading through them. */
  pulled: number;
  relocated: number;
  /** A wall price reached and ate into without breaking. */
  absorbed: boolean;
  spoofSuspected: boolean;
  spread?: number;
  levels: number;
}

export type LevelKind =
  | "swing-high"
  | "swing-low"
  | "equal-highs"
  | "equal-lows"
  | "pdh"
  | "pdl"
  | "pwh"
  | "pwl"
  | "pmh"
  | "pml";

export interface LiquidityLevel {
  kind: LevelKind;
  price: number;
  /** Percent from current price; negative means below. */
  distance: number;
  touches: number;
  /** 0-1 importance, blending touch count, kind and recency. */
  weight: number;
  side: "above" | "below";
  label: string;
}

export interface LiquidityRead {
  levels: LiquidityLevel[];
  /**
   * Every clustered "Equal highs" price the engine found, including any the
   * visible map trims. The liquidity averages read from here so they do not
   * shift as levels scroll in and out of the table.
   */
  equalHighs: number[];
  equalLows: number[];
  /**
   * Every level the engine clustered, untrimmed, so the verification readout can
   * show what was excluded from the averages and why. Display only — the
   * averages are computed from `equalHighs`/`equalLows`.
   */
  allLevels?: LiquidityLevel[];
  /** Weighted density of resting stop liquidity above price, 0-100. */
  poolAbove: number;
  poolBelow: number;
  nearestResistance?: LiquidityLevel;
  nearestSupport?: LiquidityLevel;
  fakeBreakout: boolean;
  fakeBreakdown: boolean;
  /** Price pressed against a heavy cluster. */
  breakoutZone: boolean;
  breakdownZone: boolean;
}

export interface ProfileRead {
  poc: number;
  vah: number;
  val: number;
  /** Percent from POC; positive means price is above it. */
  pocDistance: number;
  hvn: number[];
  lvn: number[];
  acceptance: "inside" | "above" | "below";
  /** Price sits on a low-volume node, where moves tend to be fast. */
  inLvn: boolean;
  bins: { price: number; volume: number }[];
}

export interface VwapRead {
  /** Session VWAP anchored at the UTC day open. */
  vwap: number;
  upper1: number;
  upper2: number;
  lower1: number;
  lower2: number;
  /** Percent from VWAP. */
  deviation: number;
  /** Deviation in standard deviations. */
  sigma: number;
  position: "above" | "below" | "at";
  /** 0-100, rises as price stretches from the mean. */
  meanReversion: number;
}

export type PivotKind = "HH" | "LH" | "HL" | "LL";

export interface Pivot {
  at: number;
  price: number;
  type: "high" | "low";
  kind: PivotKind;
  /**
   * True for the first pivot of its type, which had no predecessor to be
   * compared against. Seeds are shown but excluded from the trend vote.
   */
  seed?: boolean;
}

export interface StructureRead {
  trend: TrendDir;
  pivots: Pivot[];
  lastHigh?: number;
  lastLow?: number;
  bos: "bullish" | "bearish" | "none";
  choch: "bullish" | "bearish" | "none";
  phase: "compression" | "expansion" | "neutral";
  /** Average true range as a percent of price. */
  atrPct: number;
  falseBreakout: boolean;
  falseBreakdown: boolean;
}

/* ------------------------------------------------------------------ */
/* Exhaustion gates                                                    */
/* ------------------------------------------------------------------ */

export type GateKey = "pin" | "climax" | "trap" | "depletion";

export const GATE_ORDER: GateKey[] = ["pin", "climax", "trap", "depletion"];

export const GATE_LABEL: Record<GateKey, string> = {
  pin: "24h high pin",
  climax: "Volume climax & cooling",
  trap: "Failed breakout trap",
  depletion: "Upside liquidity depletion",
};

/**
 * One gate's verdict.
 *
 * `progress` and `margin` answer different questions and are never mixed:
 *   progress — how close this gate is to passing, 0-1, reaching 1 at the
 *              threshold. Drives the near-miss meter.
 *   margin   — how decisively it passed, 0-1, starting at 0 exactly on the
 *              threshold. Only meaningful once `passed`, and the sole input to
 *              conviction.
 */
export interface GateRead {
  key: GateKey;
  label: string;
  /** True only when the criterion is fully met. */
  passed: boolean;
  /** False when the inputs are not available yet — never counts as passed. */
  measured: boolean;
  progress: number;
  margin: number;
  /** The numbers behind the verdict, so it can be checked by hand. */
  detail: string;
}

/** Everything the focus panel shows for one contract. */
export interface ExhaustionRead {
  symbol: string;
  /** "short" once armed, otherwise none. Never "long" — see `TrapSide`. */
  side: TrapSide;
  /** True only when all four gates passed. */
  armed: boolean;
  gates: GateRead[];
  passedCount: number;
  measuredCount: number;
  /** 0-100, how far past the thresholds the setup is. Only meaningful when armed. */
  conviction: number;
  /** True when tier-2 kline history is attached, so gates 3-4 can be measured. */
  deep: boolean;

  price: number;
  high24h: number;
  low24h: number;
  /** Position in the 24h range, 0 at the low and 1 at the high. */
  rangePos: number;
  changePct: number;
  quoteVolume: number;

  /** Distance to the 24h high, in basis points. */
  extremeBps?: number;
  rvol?: number;
  rvolAcceleration?: number;
  /** Rejection wick as a share of the trap candle's range, percent. */
  wickPct?: number;
  yearHigh?: number;
  yearLow?: number;
  /** Days of daily history behind the long-horizon extremes. */
  yearDays?: number;
  at: number;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface WickRules {
  /** UI + scan refresh cadence, milliseconds (1-5s per spec). */
  refreshMs: number;
  /** Minimum 24h turnover for a contract to be scanned, USD. */
  minVolume: number;

  /** Gate 1 — distance to the 24h high that still counts as pinned, in bps. */
  pinBps: number;
  /** Gate 2 — RVOL that counts as a climax, percent. */
  rvolClimax: number;
  /** Gate 3 — rejection wick as a share of the candle's range, percent. */
  wickPct: number;
  /** Gate 4 — distance to the long-horizon high that counts as swept, percent. */
  depletionPct: number;
  /** Gate 4 — trading days behind the long-horizon high. */
  horizonDays: number;

  /** How many top-ranked symbols get tier-2 kline history. */
  deepWatch: number;
  /** Minutes before the same symbol/side can alert again. */
  cooldownMins: number;
}

export interface WickAlert {
  id: string;
  symbol: string;
  side: TrapSide;
  conviction: number;
  price: number;
  /** The 24h high the setup was pinned against. */
  extreme: number;
  rvol?: number;
  wickPct?: number;
  /** One line per gate, in gate order. */
  reasons: string[];
  at: number;
  seen: boolean;
}

export type SocketState = "idle" | "connecting" | "open" | "retrying" | "blocked";

/** Where tier-1 frames are actually coming from right now. */
export type Transport = "socket" | "rest" | "none";

/** Transport preference. `auto` streams when it can and polls when it cannot. */
export type TransportMode = "auto" | "rest";

export interface FeedStatus {
  market: SocketState;
  deep: SocketState;
  /** Contracts in the tier-1 universe. */
  universe: number;
  /** Contracts with tier-2 microstructure attached. */
  deepCount: number;
  lastTickerAt?: number;
  lastMarkAt?: number;
  lastError?: string;
  /** REST reachability — false when the venue answers 451/blocked. */
  restOk: boolean;
  marketRetries: number;
  deepRetries: number;

  /* --- transport diagnostics --- */
  /** Source delivering tier-1 frames: the stream, the REST poll, or nothing. */
  transport: Transport;
  mode: TransportMode;
  /** Label of the socket endpoint shape last attempted. */
  endpoint?: string;
  /** When the in-flight connection attempt started, for an elapsed readout. */
  connectStartedAt?: number;
  /** Close code from the last market socket close, when the browser gave one. */
  lastCloseCode?: number;
  /**
   * Handshakes that produced no event at all before the watchdog fired. A
   * non-zero count means the connection is being dropped silently rather than
   * refused — typically hostname filtering on `fstream.binance.com`.
   */
  handshakeTimeouts: number;
  /** Last tier-1 REST poll that returned rows. */
  lastPollAt?: number;
  /** Consecutive failed tier-1 polls. */
  pollFailures: number;
  /** Contract receiving REST microstructure while the depth socket is down. */
  restDeepSymbol?: string;
}
