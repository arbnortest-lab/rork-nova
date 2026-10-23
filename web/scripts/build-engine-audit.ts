/**
 * Builds `public/nova-engine-audit.pdf` — the Mathematical & Logical Audit
 * Report for the Nova DCA unified engine (macro gates + squeeze radar).
 *
 * Two rules keep the document honest:
 *
 *   1. Every worked example is COMPUTED by the shipped engine functions at
 *      build time. The numbers in the PDF are outputs of the code, not
 *      arithmetic done by hand.
 *   2. Every constant quoted from a module this script cannot import (the React
 *      providers, the Cloudflare scanner) is pinned against the source text.
 *      If someone changes the constant without rebuilding the report, the
 *      build fails instead of shipping a stale number.
 *
 *   bun --tsconfig-override tsconfig.app.json scripts/build-engine-audit.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rgb } from "pdf-lib";

import { CLUSTER_MAX_USD, CLUSTER_MIN_USD, DOMINANCE_MIN, FETCH_FLOOR_USD } from "../../functions/_lib/flow";
import {
  CLUSTER_BIN_PCT,
  liquidationClusters,
  RADAR_WINDOW_MS,
  readDepth,
  readOiTrend,
  readSqueeze,
  readWalls,
  squeezeThresholds,
  WALL_STRENGTH,
  whaleThreshold,
} from "../src/lib/radar/micro";
import { LIQUIDATION_STREAM, microStreams } from "../src/lib/radar/stream";
import { readFlow, readVolume } from "../src/lib/wick/engines";
import {
  candidacy,
  evaluateExhaustion,
  findTrap,
  readExtreme,
  readHorizon,
  wickShare,
  type ExhaustionRead,
} from "../src/lib/wick/exhaustion";
import { DAILY_MAX_AGE_MS, KLINE_MAX_AGE_MS } from "../src/lib/wick/feed";
import { setupFellApart } from "../src/lib/wick/rearm";
import { DEFAULT_WICK_RULES, RVOL_LOOKBACK, TRAP_LOOKBACK, TRAP_SCAN } from "../src/lib/wick/rules";
import type { AggTrade, BookLevel, BookSnapshot, Kline, OiPoint, TickerTick, VolumeRead } from "../src/lib/wick/types";
import { GATE_LABEL } from "../src/lib/wick/types";
import { PRICE_BAND_MAX, PRICE_BAND_MIN } from "../src/lib/wick/universe";
import type { LiquidationEvent } from "../src/lib/radar/types";
import { AMBER, CONTENT_W, DARK, Doc, GREEN, MARGIN, MUTED, PAGE, PAPER, RED, sanitize } from "./pdf-kit";

const VERSION = "v1.1";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(ROOT, "../public/nova-engine-audit.pdf");
const R = DEFAULT_WICK_RULES;

/* ------------------------------------------------------------------ */
/* Source pins — constants quoted from modules this script cannot import */
/* ------------------------------------------------------------------ */

const sources = new Map<string, string>();
async function source(rel: string): Promise<string> {
  const abs = path.resolve(ROOT, "..", rel);
  let text = sources.get(abs);
  if (text === undefined) {
    text = await readFile(abs, "utf8");
    sources.set(abs, text);
  }
  return text;
}

/** Returns `value` only if `pattern` still appears in `file`; otherwise the build fails loudly. */
async function pin<T>(file: string, pattern: RegExp, value: T): Promise<T> {
  const text = await source(file);
  if (!pattern.test(text)) {
    throw new Error(`audit out of date: ${file} no longer matches ${pattern}`);
  }
  return value;
}

const P = {
  radarArmAt: await pin("src/store/RadarProvider.tsx", /RADAR_ARM_AT = 3;/, 3),
  radarGraceMin: await pin("src/store/RadarProvider.tsx", /RADAR_GRACE_MS = 2 \* 60_000;/, 2),
  publishMs: await pin("src/store/RadarProvider.tsx", /PUBLISH_MS = 250;/, 250),
  oiHistSec: await pin("src/store/RadarProvider.tsx", /OI_HIST_MS = 60_000;/, 60),
  oiLiveSec: await pin("src/store/RadarProvider.tsx", /OI_LIVE_MS = 20_000;/, 20),
  rawTrades: await pin("src/store/RadarProvider.tsx", /RAW_TRADES = 600;/, 600),
  whalesKept: await pin("src/store/RadarProvider.tsx", /WHALES_KEPT = 40;/, 40),
  liqsKept: await pin("src/store/RadarProvider.tsx", /LIQS_KEPT = 500;/, 500),
  chartBarsMax: await pin("src/store/RadarProvider.tsx", /CHART_BARS_MAX = 420;/, 420),
  holdsMax: await pin("src/store/RadarProvider.tsx", /\.slice\(-12\)/, 12),
  depthTau: await pin("src/lib/radar/micro.ts", /DEPTH_WEIGHT_TAU = 6;/, 6),
  oiTrendPoints: await pin("src/lib/radar/micro.ts", /OI_TREND_POINTS = 6;/, 6),
  oiTrendMinPct: await pin("src/lib/radar/micro.ts", /OI_TREND_MIN_PCT = 0\.1;/, 0.1),
  pressureBalancedPts: await pin("src/lib/radar/micro.ts", /pts < 4 \? "balanced"/, 4),
  whaleMedianMultiple: await pin("src/lib/radar/micro.ts", /median \* 15\)/, 15),
  whaleSqrtFactor: await pin("src/lib/radar/micro.ts", /0\.35 \* Math\.sqrt/, 0.35),
  whaleMinPrints: await pin("src/lib/radar/micro.ts", /trades\.length < 20\) return floor/, 20),
  squeezeMedShare: await pin("src/lib/radar/micro.ts", /hourly \* 0\.025\)/, 0.025),
  squeezeHighShare: await pin("src/lib/radar/micro.ts", /hourly \* 0\.25\)/, 0.25),
  squeezeShortShare: await pin("src/lib/radar/micro.ts", /shortShare >= 0\.65/, 0.65),
  squeezeLongShare: await pin("src/lib/radar/micro.ts", /shortShare <= 0\.35/, 0.35),
  clusterLimit: await pin("src/lib/radar/micro.ts", /limit = 6,/, 6),
  oiHistPoints: await pin("src/lib/radar/rest.ts", /limit = 36\)/, 36),
  staleSec: await pin("src/lib/radar/stream.ts", /STALE_MS = 30_000;/, 30),
  frameSpacingMs: await pin("src/lib/radar/stream.ts", /FRAME_SPACING_MS = 260;/, 260),
  frameBatch: await pin("src/lib/radar/stream.ts", /FRAME_BATCH = 40;/, 40),
  radarBlockedAfter: await pin("src/lib/radar/stream.ts", /this\.retries >= 6 \? "blocked"/, 6),
  connectTimeoutSec: await pin("src/lib/wick/feed.ts", /CONNECT_TIMEOUT_MS = 7_000;/, 7),
  restPollSec: await pin("src/lib/wick/feed.ts", /REST_POLL_MS = 4_000;/, 4),
  socketProbeSec: await pin("src/lib/wick/feed.ts", /SOCKET_PROBE_MS = 90_000;/, 90),
  socketFreshSec: await pin("src/lib/wick/feed.ts", /now - this\.lastTickerAt < 10_000/, 10),
  klineTtlSec: await pin("src/lib/wick/feed.ts", /KLINE_TTL_MS = 25_000;/, 25),
  dailyTtlMin: await pin("src/lib/wick/feed.ts", /DAILY_TTL_MS = 30 \* 60_000;/, 30),
  dailyLimit: await pin("src/lib/wick/feed.ts", /DAILY_LIMIT = 400;/, 400),
  klineLimit: await pin("src/lib/wick/feed.ts", /interval=5m&limit=500/, 500),
  volSamples: await pin("src/lib/wick/feed.ts", /MAX_VOL_SAMPLES = 24;/, 24),
  volSampleSec: await pin("src/lib/wick/feed.ts", /now - this\.lastVolSampleAt >= 5_000/, 5),
  pollFailBlock: await pin("src/lib/wick/feed.ts", /this\.pollFailures >= 2/, 2),
  deepRefreshSec: await pin("src/store/WickProvider.tsx", /DEEP_REFRESH_MS = 25_000;/, 25),
  maxAlerts: await pin("src/store/WickProvider.tsx", /MAX_ALERTS = 200;/, 200),
  hysteresis: await pin("src/store/WickProvider.tsx", /\(isDeep \? 0\.06 : 0\)/, 0.06),
  pinnedMax: await pin("src/store/WickProvider.tsx", /\[\.\.\.current, symbol\]\.slice\(-8\)/, 8),
  rearmFails: await pin("src/lib/wick/rearm.ts", /g\.measured && !g\.passed\)\.length >= 2/, 2),
  liqTol: await pin("src/lib/wick/levels.ts", /const tol = price \* 0\.0015;/, 0.15),
  liqDecay: await pin("src/lib/wick/levels.ts", /Math\.exp\(-d \/ 2\.2\)/, 2.2),
  liqScale: await pin("src/lib/wick/levels.ts", /\* 42\)/, 42),
  wallTol: await pin("src/lib/wick/engines.ts", /const tol = mid \* 0\.0006;/, 0.06),
  wallNear: await pin("src/lib/wick/engines.ts", /<= mid \* 0\.004,/, 0.4),
  wallsKept: await pin("src/lib/wick/engines.ts", /walls: walls\.slice\(0, 6\)/, 6),
  minWallLevels: await pin("src/lib/wick/engines.ts", /levels\.length < 4\) return \[\]/, 4),
  oiUpPct: await pin("src/lib/wick/engines.ts", /oiDelta > 0\.15;/, 0.15),
  priceUpPct: await pin("src/lib/wick/engines.ts", /priceChangePct > 0\.05;/, 0.05),
  oiExtrapHours: await pin("src/lib/wick/engines.ts", /at - best\.at > 6 \* 60 \* MIN/, 6),
  absorptionImb: await pin("src/lib/wick/engines.ts", /Math\.abs\(imbalance\) >= 0\.25/, 0.25),
  absorptionMove: await pin("src/lib/wick/engines.ts", /Math\.abs\(move\) < 0\.12/, 0.12),
  divergenceTol: await pin("src/lib/wick/engines.ts", /priceHiA \* 0\.0002/, 0.02),
  rvolElapsedMin: await pin("src/lib/wick/engines.ts", /elapsed > 0\.08/, 0.08),
  rvolMinBars: await pin("src/lib/wick/engines.ts", /klines\.length >= 8/, 8),
  fallbackMinSpanSec: await pin("src/lib/wick/engines.ts", /newest\.at - oldest\.at < 10_000/, 10),
  chainBeforeMin: await pin("../functions/scanner.ts", /WINDOW_BEFORE_MS = 15 \* 60_000;/, 15),
  chainAfterMin: await pin("../functions/scanner.ts", /WINDOW_AFTER_MS = 2 \* 60_000;/, 2),
  chainMediumUsd: await pin("../functions/_lib/flow.ts", /dominantUsd >= 300_000/, 300_000),
  chainMediumDom: await pin("../functions/_lib/flow.ts", /dominance >= 0\.5 &&/, 0.5),
  pineClose: await pin("public/nova-exhaustion-trap.pine", /confirmClose = input\.bool\(true/, true),
  pineCooldownBars: await pin("public/nova-exhaustion-trap.pine", /cooldownBars = input\.int\(20/, 20),
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const fmt = (n: number, d = 2): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n: number, d = 0): string => `$${fmt(n, d)}`;
const px = (n: number): string => n.toFixed(6);
const pct = (n: number, d = 2): string => `${fmt(n, d)}%`;
const yn = (b: boolean): string => (b ? "PASS" : "fail");
const compact = (n: number): string => {
  if (n >= 1e9) return `$${fmt(n / 1e9, n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${fmt(n / 1e6, n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${fmt(n / 1e3, n >= 1e4 ? 0 : 1)}K`;
  return `$${fmt(n, 0)}`;
};

/* ------------------------------------------------------------------ */
/* Worked examples — executed against the shipped engine               */
/* ------------------------------------------------------------------ */

const BAR = 300_000;
const DAY = 86_400_000;
const LAST_OPEN = Date.UTC(2026, 9, 18, 14, 35);
const NOW = LAST_OPEN + 120_000; // 40% of the way through the forming 5m bar
const SYMBOL = "VETUSDT";

function kline(i: number, n: number, quoteVolume: number, ohlc: [number, number, number, number]): Kline {
  const [open, high, low, close] = ohlc;
  return {
    openTime: LAST_OPEN - (n - 1 - i) * BAR,
    open,
    high,
    low,
    close,
    volume: quoteVolume / open,
    quoteVolume,
    trades: 180,
  };
}

const FLAT: [number, number, number, number] = [0.0066, 0.00661, 0.00659, 0.006605];
/** The trap bar: a higher high (0.006720) rejected to a close at 0.006660 — upper wick is half the range. */
const TRAP_BAR: [number, number, number, number] = [0.00664, 0.00672, 0.0066, 0.00666];
/** Same higher high, but the bar closed near its top — a breakout that held. */
const HELD_BAR: [number, number, number, number] = [0.00664, 0.00672, 0.0066, 0.0067];

/** 120 five-minute bars: 119 completed at ~$20k each (one exception) plus the forming bar. */
function series(prevQuote: number, last: [number, number, number, number]): Kline[] {
  const n = 120;
  const out: Kline[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i === n - 1) out.push(kline(i, n, 30_000, last));
    else if (i === n - 2) out.push(kline(i, n, prevQuote, FLAT));
    else out.push(kline(i, n, 20_000, FLAT));
  }
  return out;
}

const ticker: TickerTick = {
  symbol: SYMBOL,
  last: 0.006718,
  open: 0.0063,
  high: 0.00672,
  low: 0.0061,
  vwap24h: 0.0064,
  quoteVolume: 5_000_000,
  trades: 52_000,
  at: NOW,
};

/** 400 daily bars; the last one is the in-progress UTC day. One completed day carries the horizon high. */
const daily: Kline[] = (() => {
  const dayOpen = Date.UTC(2026, 9, 18);
  const out: Kline[] = [];
  for (let j = 0; j < 400; j += 1) {
    const openTime = dayOpen - (399 - j) * DAY;
    const base = 0.0058 + 0.0004 * Math.sin(j / 37);
    const high = j === 380 ? 0.006725 : j === 399 ? 0.00672 : base + 0.0001;
    out.push({ openTime, open: base, high, low: base - 0.0002, close: base + 0.00005, volume: 1, quoteVolume: 1, trades: 1 });
  }
  return out;
})();

const unmeasuredVolume: VolumeRead = { quoteVolume24h: ticker.quoteVolume, trades24h: ticker.trades, spike: false, precise: false };

function evaluate(opts: { klines?: Kline[]; daily?: Kline[]; volume?: VolumeRead; ticker?: TickerTick }): ExhaustionRead {
  const t = opts.ticker ?? ticker;
  return evaluateExhaustion({
    symbol: SYMBOL,
    ticker: t,
    volume: opts.volume ?? unmeasuredVolume,
    klines: opts.klines,
    daily: opts.daily,
    rules: R,
    at: NOW,
  });
}

/* --- gate 1 --- */
const ex1 = readExtreme(ticker);
if (!ex1) throw new Error("gate 1 example did not measure");
const g1 = evaluate({}).gates[0];

/* --- gate 2, kline path --- */
const accelerating = series(24_000, TRAP_BAR);
const cooling = series(90_000, TRAP_BAR);
const volA = readVolume(ticker, [], accelerating, R.rvolClimax);
const volB = readVolume(ticker, [], cooling, R.rvolClimax);
const histA = accelerating.slice(0, -1).slice(-RVOL_LOOKBACK);
const histB = cooling.slice(0, -1).slice(-RVOL_LOOKBACK);
const avgA = histA.reduce((a, k) => a + k.quoteVolume, 0) / histA.length;
const avgB = histB.reduce((a, k) => a + k.quoteVolume, 0) / histB.length;
const g2A = evaluate({ volume: volA }).gates[1];
const g2B = evaluate({ volume: volB }).gates[1];

/* --- gate 2, ticker fallback --- */
const t0 = NOW - 60_000;
const fallbackSamples = [
  { at: t0, quoteVolume: 5_000_000, trades: 52_000 },
  { at: t0 + 30_000, quoteVolume: 5_002_000, trades: 52_030 },
  { at: t0 + 60_000, quoteVolume: 5_006_000, trades: 52_090 },
];
const volF = readVolume(ticker, fallbackSamples, undefined, R.rvolClimax);

/* --- gate 3 --- */
const trapHit = findTrap(cooling, TRAP_LOOKBACK, TRAP_SCAN);
const held = series(90_000, HELD_BAR);
const trapHeld = findTrap(held, TRAP_LOOKBACK, TRAP_SCAN);
const noHH = series(90_000, [0.00664, 0.0066, 0.00655, 0.00657]);
const trapNone = findTrap(noHH, TRAP_LOOKBACK, TRAP_SCAN);
const g3Hit = evaluate({ klines: cooling, volume: volB }).gates[2];
const g3Held = evaluate({ klines: held, volume: volB }).gates[2];
const g3None = evaluate({ klines: noHH, volume: volB }).gates[2];
if (!trapHit || !trapHeld) throw new Error("gate 3 examples did not find the higher high");

/* --- gate 4 --- */
const horizon = readHorizon(daily, R.horizonDays, NOW);
if (!horizon) throw new Error("gate 4 example did not measure");
const g4At = evaluate({ daily }).gates[3];
const g4Below = evaluate({ daily, ticker: { ...ticker, last: 0.0066, high: 0.0066 } }).gates[3];
const g4Above = evaluate({ daily, ticker: { ...ticker, last: 0.0068, high: 0.0068 } }).gates[3];
const gapAt = ((horizon.high - ticker.last) / ticker.last) * 100;
const gapBelow = ((horizon.high - 0.0066) / 0.0066) * 100;
const gapAbove = ((horizon.high - 0.0068) / 0.0068) * 100;

/* --- full verdict --- */
const signal = evaluate({ klines: cooling, daily, volume: volB });
const threeOfFour = evaluate({ klines: held, daily, volume: volB });
const fellApart = evaluate({
  klines: noHH,
  daily,
  volume: volA,
  ticker: { ...ticker, last: 0.0066, high: 0.00672 },
});
if (!signal.armed || signal.passedCount !== 4) throw new Error("full-verdict example did not arm");
if (threeOfFour.passedCount !== 3) throw new Error("three-of-four example is wrong");
if (!setupFellApart(fellApart)) throw new Error("fell-apart example is wrong");
const meanMargin = signal.gates.reduce((s, g) => s + g.margin, 0) / signal.gates.length;

/* --- candidacy --- */
const candA = candidacy({ extremeBps: ex1.bps, rvol: volB.rvol, quoteVolume: 5_000_000, pinBps: R.pinBps, rvolClimax: R.rvolClimax });
const candB = candidacy({ extremeBps: 40, rvol: 600, quoteVolume: 1e9, pinBps: R.pinBps, rvolClimax: R.rvolClimax });

/* --- depth, walls --- */
const bidNotional = [1800, 2200, 1500, 2600, 1900, 1700, 2100, 2400, 1600, 2000, 1800, 2300, 1500, 1900, 2200, 1700, 2000, 2100, 1800, 1900];
const askNotional = [1600, 1900, 2100, 1500, 2300, 1800, 2000, 9800, 1700, 2200, 1900, 1600, 2000, 2400, 1800, 2100, 1700, 1900, 2200, 1800];
const level = (price: number, notional: number): BookLevel => ({ price, qty: notional / price, notional });
const book: BookSnapshot = {
  bids: bidNotional.map((n, i) => level(0.00665 - i * 0.000001, n)),
  asks: askNotional.map((n, i) => level(0.006651 + i * 0.000001, n)),
  at: NOW,
};
const walls = readWalls(book);
const depth = readDepth(book, walls.book.walls);
const askMean = askNotional.reduce((a, b) => a + b, 0) / askNotional.length;
const bidMean = bidNotional.reduce((a, b) => a + b, 0) / bidNotional.length;
const weights = Array.from({ length: 20 }, (_, i) => Math.exp(-i / P.depthTau));
const weightTotal = weights.reduce((a, b) => a + b, 0);
const cumulative = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / weightTotal);
const wBid = bidNotional.reduce((a, n, i) => a + n * weights[i], 0);
const wAsk = askNotional.reduce((a, n, i) => a + n * weights[i], 0);
if (!depth.mid || walls.ask.length !== 1) throw new Error("depth example is wrong");

/* --- whale thresholds --- */
const turnovers = [5e6, 2e7, 5e7, 2e8, 1e9, 5e9, 2e10];
const whaleRows = turnovers.map((q) => {
  const floor = whaleThreshold([], q);
  const prints: AggTrade[] = Array.from({ length: 41 }, (_, i) => ({ price: 0.00665, qty: 1, notional: 60 + i * 3, isBuy: i % 2 === 0, at: NOW - i * 1000 }));
  const median = prints.map((t) => t.notional).sort((a, b) => a - b)[Math.floor(prints.length / 2)];
  return { q, floor, median, withMedian: whaleThreshold(prints, q) };
});

/* --- squeeze thresholds + read --- */
const squeezeRows = turnovers.map((q) => ({ q, ...squeezeThresholds(q) }));
const liqs: LiquidationEvent[] = [
  { symbol: SYMBOL, side: "BUY", price: 0.006662, qty: 1, notional: 4_000, at: NOW - 6 * 60_000 },
  { symbol: SYMBOL, side: "BUY", price: 0.006665, qty: 1, notional: 2_500, at: NOW - 9 * 60_000 },
  { symbol: SYMBOL, side: "SELL", price: 0.006623, qty: 1, notional: 1_800, at: NOW - 14 * 60_000 },
  { symbol: SYMBOL, side: "SELL", price: 0.006648, qty: 1, notional: 900, at: NOW - 20 * 60_000 },
  { symbol: SYMBOL, side: "BUY", price: 0.006702, qty: 1, notional: 1_200, at: NOW - 31 * 60_000 },
  { symbol: SYMBOL, side: "BUY", price: 0.00666, qty: 1, notional: 3_300, at: NOW - 44 * 60_000 },
  { symbol: SYMBOL, side: "SELL", price: 0.00659, qty: 1, notional: 2_000, at: NOW - 75 * 60_000 },
];
const squeeze = readSqueeze(liqs, 5_000_000, NOW);
const clusterPrice = 0.00665;
const clusters = liquidationClusters(liqs, clusterPrice, NOW);
const binWidth = clusterPrice * (CLUSTER_BIN_PCT / 100);

/* --- open interest trend --- */
const oiHist: OiPoint[] = Array.from({ length: 6 }, (_, i) => ({ at: NOW - (5 - i) * 5 * 60_000, openInterest: 1_000_000 + i * 1_200 }));
const oiRising = readOiTrend(oiHist, undefined, 0.00665, 0.3);
const oiFlatHist: OiPoint[] = oiHist.map((p, i) => ({ ...p, openInterest: 1_000_000 + (i % 2) * 300 }));
const oiFlat = readOiTrend(oiFlatHist, undefined, 0.00665, 0.3);
if (oiRising.slopePct === undefined || oiFlat.slopePct === undefined) throw new Error("oi example is wrong");

/* --- aggressive flow --- */
const tape: AggTrade[] = Array.from({ length: 12 }, (_, i) => ({
  price: 0.00665,
  qty: 1,
  notional: i % 3 === 2 ? 300 : 900,
  isBuy: i % 3 !== 2,
  at: NOW - (11 - i) * 2_500,
}));
const flow = readFlow(tape, 1_000);

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

const doc = await Doc.create();
const buildDate = new Date().toISOString().slice(0, 10);

// Identifiers are written with backticks for readability in this source; the
// typeset prose should not show them. Formula blocks (`code`) are left alone.
const plain = (text: string): string => text.replace(/`/g, "");
{
  const body = doc.body.bind(doc);
  doc.body = (text, opts) => body(plain(text), opts);
  const callout = doc.callout.bind(doc);
  doc.callout = (title, lines, accent) => callout(title, lines.map(plain), accent);
  const defs = doc.defs.bind(doc);
  doc.defs = (rows, labelWidth) => defs(rows.map(([k, v]) => [plain(k), plain(v)] as [string, string]), labelWidth);
  const table = doc.table.bind(doc);
  doc.table = (columns, rows) => table(columns, rows.map((r) => r.map(plain)));
  const bullets = doc.bullets.bind(doc);
  doc.bullets = (items, opts) => bullets(items.map(plain), opts);
  const sub = doc.sub.bind(doc);
  doc.sub = (text) => sub(plain(text));
}

/** Live test counts, so the verification table cannot quietly go stale. */
async function testCount(files: string[]): Promise<number> {
  let n = 0;
  for (const file of files) {
    const text = await source(`src/test/${file}`).catch(() => "");
    n += (text.match(/^\s*(test|it)\(/gm) ?? []).length;
    // A parametrised block counts once per case row.
    for (const block of text.matchAll(/^\s*(?:test|it)\.each[^\n]*\n([\s\S]*?)^\s*\]\)\(/gm)) {
      n += (block[1].match(/^\s*\[/gm) ?? []).length;
    }
  }
  return n;
}
const tests = {
  wick: await testCount(["wick.test.ts"]),
  feed: await testCount(["feedFreshness.test.ts"]),
  universe: await testCount(["universe.test.ts"]),
  btcTrap: await testCount(["btcTrap.test.tsx"]),
  onchain: await testCount(["onchainFlow.test.ts", "onchainSchedule.test.ts", "onchainClient.test.ts", "onchainTokens.test.ts"]),
  misc: await testCount(["journal.test.ts", "format.test.ts"]),
  radar: await testCount(["radar.test.ts", "radarMicro.test.ts", "radarStream.test.ts"]),
};

/** Formula block: refuses lines the monospaced box cannot hold, and leaves air below. */
const CODE_MAX = 90;
const overlong: string[] = [];
function code(lines: string[]): void {
  for (const line of lines) {
    if (sanitize(line).length > CODE_MAX) overlong.push(`${sanitize(line).length}: ${line}`);
  }
  doc.code(lines);
  doc.space(4);
}

/* ---------------- cover ---------------- */
{
  const page = doc.current;
  page.drawRectangle({ x: 0, y: PAGE.h - 236, width: PAGE.w, height: 236, color: DARK });
  page.drawRectangle({ x: MARGIN.x, y: PAGE.h - 236, width: 3, height: 236, color: AMBER });
  page.drawText("NOVA DCA", { x: MARGIN.x + 22, y: PAGE.h - 102, size: 36, font: doc.fonts.sansBold, color: PAPER });
  page.drawText("UNIFIED ENGINE AUDIT", { x: MARGIN.x + 22, y: PAGE.h - 138, size: 20, font: doc.fonts.sansBold, color: AMBER });
  page.drawText("MATHEMATICAL & LOGICAL AUDIT REPORT - EVERY FORMULA, EVERY GUARD", {
    x: MARGIN.x + 22,
    y: PAGE.h - 166,
    size: 8.6,
    font: doc.fonts.mono,
    color: rgb(0.62, 0.66, 0.72),
  });
  page.drawText(`REPORT ${VERSION.toUpperCase()}  -  BUILT ${buildDate}  -  MACRO ENGINE + SQUEEZE RADAR`, {
    x: MARGIN.x + 22,
    y: PAGE.h - 194,
    size: 7.6,
    font: doc.fonts.monoBold,
    color: rgb(0.62, 0.66, 0.72),
  });

  doc.space(250);
  doc.body(
    "This report transcribes every calculation the dashboard performs between a Binance frame and a verdict: the " +
      "four exhaustion gates, the verdict and conviction arithmetic, the candidate ranking, the alert state machine, " +
      "and the Squeeze Radar's depth, wall, whale, squeeze, liquidation-cluster and open-interest reads. Each " +
      "formula names the file and function it lives in so it can be checked against the source line by line.",
  );
  doc.callout("How the numbers in this report were produced", [
    "Every worked example was computed by executing the shipped engine functions at build time: the figures are " +
      "outputs of the code, not hand arithmetic. Constants quoted from modules the build cannot import are pinned " +
      "against the source text, and the build fails if any of them changes without this report being regenerated.",
    `Shipped defaults apply throughout: pin ${R.pinBps} bps, RVOL ${R.rvolClimax}%, wick ${R.wickPct}%, depletion ` +
      `${R.depletionPct}%, horizon ${R.horizonDays} days, cooldown ${R.cooldownMins} min, minimum turnover ${compact(R.minVolume)}.`,
  ]);
  doc.space(6);
  doc.callout(
    "Headline findings (detail in section 14)",
    [
      "Depth imbalance weights levels by rank from the touch (e^(-i/6)), not by price distance; the mark price is " +
        "not an input. Whale walls are a 3x mean-level test with no absolute dollar floor. Squeeze has two " +
        "thresholds (warm, hot) - 'low' is everything beneath warm. Liquidation clusters use a hard 60-minute " +
        "window with no intra-window decay and re-centre on the live price. No composite 'confluence score' " +
        "exists: conviction (60-100) is the only composite number and exists only at 4/4.",
    ],
    RED,
  );
  doc.space(2);
  doc.sub("Contents");
  doc.rule();
}
const tocY = doc.cursor - 2;
doc.newPage();

/* ================================================================== */
/* 01 Scope, method & terminology                                      */
/* ================================================================== */

doc.heading("Scope, method & terminology", { newPage: false });

doc.body(
  "The engine has two layers and a handful of add-ons. The MACRO layer (Liquidity Exhaustion Engine) scores every " +
    "tracked contract on four gates from two all-market streams plus cached kline history. The MICRO layer (Squeeze " +
    "Radar) attaches live depth, trades, mark price and liquidation streams to a contract only once it reaches " +
    `${P.radarArmAt} of 4 gates, and reduces them to the Confluence Matrix columns. The radar never feeds back into ` +
    "the gates: nothing it computes can arm, alert or re-rank a contract.",
);

doc.sub("Source map");
doc.table(
  [
    { header: "Component", width: 118 },
    { header: "File", width: 150, mono: true },
    { header: "Functions audited", width: CONTENT_W - 268, mono: true },
  ],
  [
    ["Gates 1-4, verdict", "src/lib/wick/exhaustion.ts", "readExtreme, wickShare, findTrap, readHorizon, gate, evaluateExhaustion, candidacy"],
    ["Volume, flow, book, OI", "src/lib/wick/engines.ts", "readVolume, readFlow, readBook, findWalls, readOpenInterest, readFunding"],
    ["Liquidity map (gate-4 text)", "src/lib/wick/levels.ts", "readLiquidity, findPivots, readStructure"],
    ["Thresholds & sanitiser", "src/lib/wick/rules.ts", "DEFAULT_WICK_RULES, sanitizeWickRules"],
    ["Re-arm rule", "src/lib/wick/rearm.ts", "setupFellApart"],
    ["Universe", "src/lib/wick/universe.ts", "isTracked, inPriceBand"],
    ["Transport & freshness", "src/lib/wick/feed.ts", "WickFeed, klineFresh, dailyFresh, normalisers"],
    ["Scan loop, alerts, ranking", "src/store/WickProvider.tsx", "runPass, raise"],
    ["Radar reducers", "src/lib/radar/micro.ts", "readDepth, readWalls, whaleThreshold, squeezeThresholds, readSqueeze, liquidationClusters, readOiTrend"],
    ["Radar transport", "src/lib/radar/stream.ts", "RadarStream, ingest*"],
    ["Radar orchestration", "src/store/RadarProvider.tsx", "attach/detach, publish"],
    ["On-chain add-on", "functions/_lib/flow.ts", "analyze"],
  ],
);

doc.sub("Terminology - the words in the UI versus the names in the code");
doc.table(
  [
    { header: "UI / spec term", width: 120 },
    { header: "Code", width: 150, mono: true },
    { header: "Meaning", width: CONTENT_W - 270 },
  ],
  [
    ["PASS (per gate)", "GateRead.passed", "measured AND criterion met. An unmeasured gate is neither passed nor failed."],
    ["IDLE", "passedCount < 3", "Fewer than three measured passes. No radar streams (unless focused or held)."],
    ["ARMED 3/4", "passedCount >= RADAR_ARM_AT", "Radar attaches. In the code this is RadarState 'armed'; ExhaustionRead.armed is still false."],
    ["SIGNAL 4/4", "ExhaustionRead.armed === true", "All four gates passed. Side = short. Alert raised subject to cooldown and re-arm. RadarState 'signal'."],
    ["Conviction", "ExhaustionRead.conviction", "60-100 at 4/4, 0 otherwise. How far past the thresholds, never a probability."],
    ["Progress", "GateRead.progress", "0-1, reaches 1 at the threshold. Near-miss meter only."],
    ["Margin", "GateRead.margin", "0-1, how far PAST the threshold (saturates at 2x). Sole input to conviction."],
  ],
);

doc.sub("Notation used in the formulas");
doc.defs(
  [
    ["P", "last traded price from the venue's 24h ticker (field c), or the live mid in the radar"],
    ["H24, L24, O24", "rolling 24-hour high, low and open from the same ticker (fields h, l, o)"],
    ["Q24", "rolling 24-hour quote turnover in USD (field q)"],
    ["bps", "basis points: 1 bps = 0.01% = 1/10,000"],
    ["clamp01(x)", "min(1, max(0, x)); NaN and non-finite values become 0"],
    ["bar", "a 5-minute kline unless stated; 'completed' excludes the bar still forming"],
  ],
  110,
);

/* ================================================================== */
/* 02 Universe, inputs & normalisation                                 */
/* ================================================================== */

doc.heading("Universe, inputs & normalisation");

doc.sub("Which contracts are scored");
code([
  "tracked(symbol, P)  =  symbol == BTCUSDT",
  `                    or ${PRICE_BAND_MIN} < P < ${PRICE_BAND_MAX}          (strict, both bounds excluded)`,
  "",
  "scored only if   USDT perpetual (no '_' delivery suffix)",
  `             and Q24 >= minVolume (${compact(R.minVolume)} default)`,
  "             and the ticker row has P > 0",
]);
doc.body(
  "The band is re-tested against the live price on every scan pass. A contract that crosses out of the band leaves " +
    "the scanner on the next tick and returns only once its price is back inside. The price is the contract's own " +
    "quote (for 1000PEPEUSDT that is the x1000 contract price).",
);

doc.sub("Two tiers of data");
doc.table(
  [
    { header: "Tier", width: 58 },
    { header: "Source", width: 190, mono: true },
    { header: "Feeds", width: CONTENT_W - 248 },
  ],
  [
    ["1 breadth", "!ticker@arr + !markPrice@arr@1s (one socket on /market), REST /ticker/24hr + /premiumIndex as safety net", "Gate 1, gate 2 (fallback path), ranking. Every contract."],
    ["2 depth", `/fapi/v1/klines 5m x ${P.klineLimit} and 1d x ${P.dailyLimit}, cached REST`, `Gate 2 (precise path), gates 3-4. Top ${R.deepWatch} ranked + pinned (max ${P.pinnedMax}) + focused.`],
    ["radar", `/public: <s>@depth20@100ms. /market: <s>@aggTrade, <s>@markPrice@1s, ${LIQUIDATION_STREAM}, <focus>@kline_<tf>`, "Confluence Matrix and the detail panel. Only contracts at 3/4 or better, focused or held."],
  ],
);

doc.callout("Venue routing (since March 2026)", [
  "Binance split its futures socket into routed entry points. An unrouted wss://fstream.binance.com/stream " +
    "connection now serves only the /public group (depth, book ticker, raw trades); every /market stream - " +
    "aggTrade, markPrice, klines, tickers, forceOrder - is still acknowledged on it and never delivered. The " +
    "macro feed opens its tier-1 socket on /market; the radar runs one socket per route and partitions its " +
    "stream set by name (streamRoute in stream.ts), so a stream can never be subscribed on the silent endpoint.",
]);
doc.space(4);

doc.sub("Normalisation at the edge (feed.ts, stream.ts)");
code([
  "funding %          =  r * 100                      (venue sends a fraction)",
  "level notional     =  price * qty           (levels with price <= 0 or qty <= 0 dropped)",
  "trade notional     =  p * q",
  "aggressor is buyer =  (m === false)                 (m = 'buyer is the maker')",
  "liquidation price  =  ap if ap > 0 else p;   qty = z if z > 0 else q",
  "liquidation notional = price * qty",
  "liquidation side   =  BUY  -> a SHORT was liquidated (forced buy)",
  "                      SELL -> a LONG was liquidated (forced sell)",
  "any numeric field  =  parseFloat(value); NaN -> 0, and 0 fails the > 0 guards that follow",
]);

doc.sub("Candidate ranking - who earns tier-2 history (candidacy)");
code([
  `pin    = bps undefined ? 0 : clamp01(1 - bps / max(1, 4 * pinBps))   (${4 * R.pinBps} bps -> 0)`,
  `rvol   = clamp01(((RVOL ?? 100) - 100) / max(1, rvolClimax))         (${100 + R.rvolClimax}% -> 1)`,
  "liq    = clamp01(log10(max(1, Q24) / 1e6) / 3)                       ($1M -> 0, $1B -> 1)",
  `weight = 0.6 * pin + 0.3 * rvol + 0.1 * liq  (+ ${P.hysteresis} if already in the deep set)`,
]);
doc.defs(
  [
    [`A: ${fmt(ex1.bps, 2)} bps, RVOL ${fmt(volB.rvol ?? 0, 1)}%, $5M`, `weight = ${fmt(candA, 4)}  (executed)`],
    ["B: 40 bps, RVOL 600%, $1B", `weight = ${fmt(candB, 4)}  - the 40 bps alone zeroes the pin term`],
  ],
  200,
);
doc.body(
  `Deep-watch composition per pass: pinned contracts first, then the focused one, then ranked candidates until ` +
    `${R.deepWatch} slots are filled. The +${P.hysteresis} bonus stops the list flapping on ties. BTCUSDT's history is ` +
    "additionally kept fresh at all times for the failed-breakout log without taking a slot.",
);

/* ================================================================== */
/* 03 Gate 1                                                           */
/* ================================================================== */

doc.heading("Gate 1 - pin distance to the 24h high");

doc.body(
  "Only the 24h HIGH is measured. The engine is short-only by construction (`TrapSide` has no long member), so a " +
    "contract at its 24h low simply reports a large distance and fails. Source: `readExtreme` and the `pin` block of " +
    "`evaluateExhaustion` in exhaustion.ts.",
);
code([
  "requires   P > 0, H24 > 0, L24 > 0, H24 >= L24      (else gate unmeasured)",
  "",
  "bps        =  max(0, (H24 - P) / P * 10,000)",
  "rangePos   =  (H24 - L24) > 0 ? clamp01((P - L24) / (H24 - L24)) : 0.5",
  "",
  `PASS       <=>  bps <= pinBps                        (default ${R.pinBps})`,
  "ratio      =  2 - bps / max(0.01, pinBps)     (inverted: on the level = 2, threshold = 1)",
  "progress   =  min(1, max(0, ratio))",
  "margin     =  PASS ? clamp01(ratio - 1) : 0",
]);
doc.body(
  "A sweep prints above the rolling high, which would make the raw distance negative; it is clamped at zero because " +
    "trading through the level is the most complete way of reaching it. The denominator is the last price, so the " +
    "distance is 'how far price would have to rise', in its own units.",
);

doc.sub("Worked example (executed)");
doc.defs(
  [
    ["Inputs", `P = ${px(ticker.last)}, H24 = ${px(ticker.high)}, L24 = ${px(ticker.low)}`],
    ["bps", `(${px(ticker.high)} - ${px(ticker.last)}) / ${px(ticker.last)} x 10,000 = ${fmt(ex1.bps, 3)} bps`],
    ["rangePos", fmt(ex1.rangePos, 4)],
    ["Verdict", `${yn(g1.passed)} - progress ${fmt(g1.progress, 3)}, margin ${fmt(g1.margin, 3)}`],
    ["Detail string", g1.detail],
  ],
  96,
);
doc.callout("What this gate does NOT do", [
  "It does not use kline highs, the mark price or the index price: H24 is the venue's own rolling statistic " +
    "(ticker field `h`), refreshed by the stream roughly every second or by the 4-second REST poll. It does not " +
    "measure the 24h low under any setting.",
]);

/* ================================================================== */
/* 04 Gate 2                                                           */
/* ================================================================== */

doc.heading("Gate 2 - volume climax & RVOL");

doc.body(
  "Two halves, both required: relative volume must be at or past the climax level AND it must be cooling. A surge " +
    "that is still accelerating has fuel behind it. Source: `readVolume` in engines.ts and the `climax` block of " +
    "`evaluateExhaustion`.",
);

doc.sub("Preferred path - kline history attached (precise = true)");
code([
  `requires   klines.length >= ${P.rvolMinBars}`,
  `history    =  the last ${RVOL_LOOKBACK} COMPLETED 5m bars   (forming bar excluded; ${RVOL_LOOKBACK} x 5m = 8 h)`,
  "avg        =  mean(history.quoteVolume)                      (USD per bar)",
  "span       =  max(1, t_now - current.openTime)",
  "barMs      =  history[1].openTime - history[0].openTime      (300,000 for 5m)",
  "elapsed    =  min(1, span / barMs)",
  `projected  =  elapsed > ${P.rvolElapsedMin} ? current.quoteVolume / elapsed : current.quoteVolume`,
  "RVOL %     =  avg > 0 ? projected / avg * 100 : undefined",
  "prevRVOL % =  history.last.quoteVolume / avg * 100",
  "accel      =  RVOL - prevRVOL                                (percentage points)",
  "",
  `climaxHit  <=>  RVOL >= rvolClimax                           (default ${R.rvolClimax}%)`,
  "cooling    <=>  accel <= 0",
  "PASS       <=>  climaxHit and cooling",
  "ratio      =  (RVOL / max(1, rvolClimax)) * (cooling ? 1 : 0.5)",
]);
doc.body(
  "The baseline is the mean of the previous 8 hours, not a 24-hour average: a contract that has been busy all day " +
    "is measured against that day, so RVOL reads 'unusual for the last eight hours'. The forming bar is scaled up to " +
    `a full bar once more than ${P.rvolElapsedMin * 100}% of it has elapsed, so the first seconds of a bar are not ` +
    "read as a lull; before that point the raw partial volume is used, which can only under-read.",
);

doc.sub("Worked examples (executed) - same forming bar, two different previous bars");
doc.table(
  [
    { header: "Scenario", width: 92 },
    { header: "avg (96 bars)", width: 74, align: "right", mono: true },
    { header: "projected", width: 70, align: "right", mono: true },
    { header: "RVOL", width: 58, align: "right", mono: true },
    { header: "accel", width: 58, align: "right", mono: true },
    { header: "Verdict", width: CONTENT_W - 352 },
  ],
  [
    [
      "A: prev bar $24k",
      usd(avgA),
      usd(30_000 / 0.4),
      pct(volA.rvol ?? 0, 1),
      `${(volA.acceleration ?? 0) > 0 ? "+" : ""}${fmt(volA.acceleration ?? 0, 1)}`,
      `${yn(g2A.passed)} - progress ${fmt(g2A.progress, 3)} (capped by the 0.5 factor)`,
    ],
    [
      "B: prev bar $90k",
      usd(avgB),
      usd(30_000 / 0.4),
      pct(volB.rvol ?? 0, 1),
      fmt(volB.acceleration ?? 0, 1),
      `${yn(g2B.passed)} - margin ${fmt(g2B.margin, 3)}`,
    ],
  ],
);
doc.body(
  `Forming bar: $30,000 traded with 40% of the bar elapsed, so projected = 30,000 / 0.4 = $75,000. Detail A: "${g2A.detail}". ` +
    `Detail B: "${g2B.detail}".`,
  { color: MUTED, size: 8.6 },
);

doc.sub("Fallback path - no kline history (precise = false)");
code([
  `samples    =  (t, Q24, trades) every >= ${P.volSampleSec} s from the ticker; newest ${P.volSamples} kept (~2 min)`,
  `requires   newest.t - oldest.t >= ${P.fallbackMinSpanSec} s,  dQ = newest.Q24 - oldest.Q24 > 0`,
  "rate       =  dQ / seconds                                 (USD per second, just now)",
  "baseline   =  Q24 / 86,400                                 (USD per second, 24h average)",
  "RVOL %     =  rate / baseline * 100",
  "accel      =  (rate of 2nd half - rate of 1st half) / baseline * 100   (if measurable)",
]);
doc.body(
  "Q24 is a rolling counter, so its one-minute delta is (traded now) minus (what rolled off from 24 hours ago). It " +
    "can be negative on a quiet contract; a non-positive delta reports the gate as unmeasured rather than as zero. " +
    "This path matters for ranking only: a contract without klines cannot measure gates 3-4 and therefore cannot arm.",
);
doc.defs(
  [
    ["Executed", `dQ = $6,000 over 60 s -> rate ${fmt(volF.rate ?? 0, 2)} $/s; baseline 5,000,000 / 86,400 = ${fmt(5_000_000 / 86_400, 2)} $/s`],
    ["RVOL / accel", `${pct(volF.rvol ?? 0, 1)} / ${(volF.acceleration ?? 0) > 0 ? "+" : ""}${fmt(volF.acceleration ?? 0, 1)} -> ${volF.spike ? "spike" : "no spike"}, ${(volF.acceleration ?? 1) <= 0 ? "cooling" : "still accelerating"}`],
  ],
  96,
);

/* ================================================================== */
/* 05 Gate 3                                                           */
/* ================================================================== */

doc.heading("Gate 3 - failed-breakout trap (rejection wick)");

doc.body(
  "A lower-timeframe higher high that was rejected by an upper wick. Both halves are required: a long wick on a " +
    "bar that never took out the prior range is noise, and a new high that closed strong is continuation. Source: " +
    "`wickShare` and `findTrap` in exhaustion.ts.",
);
code([
  "wick %     =  range > 0 ? clamp01((high - max(open, close)) / (high - low)) * 100 : 0",
  "",
  `requires   klines.length >= ${TRAP_LOOKBACK + 2}`,
  `scan       =  newest ${TRAP_SCAN} bars: i from max(${TRAP_LOOKBACK}, n - ${TRAP_SCAN}) to n - 1  (forming bar included)`,
  `higherHigh(i) <=>  high[i] > max(high[i-${TRAP_LOOKBACK}] .. high[i-1])   (strict; excludes bar i)`,
  "trap       =  the qualifying bar with the LARGEST wick % in the scan",
  "",
  `PASS       <=>  trap exists and trap.wick% >= wickPct   (default ${R.wickPct}; floor ${R.wickPct})`,
  "ratio      =  trap.wick% / max(1, wickPct)",
]);
doc.body(
  "The wick is measured against the bar's TOTAL range (high - low), not against the body. A doji with a long upper " +
    "shadow therefore scores high; a wide-bodied bar with the same shadow scores low. The lower wick is never read.",
);

doc.sub("Worked examples (executed)");
doc.table(
  [
    { header: "Bar O / H / L / C", width: 168, mono: true },
    { header: "Higher high?", width: 72 },
    { header: "wick %", width: 56, align: "right", mono: true },
    { header: "Gate 3", width: CONTENT_W - 296 },
  ],
  [
    [`${px(TRAP_BAR[0])} / ${px(TRAP_BAR[1])} / ${px(TRAP_BAR[2])} / ${px(TRAP_BAR[3])}`, "yes (> 0.006610)", fmt(trapHit.wickPct, 1), `${yn(g3Hit.passed)} - margin ${fmt(g3Hit.margin, 3)}`],
    [`${px(HELD_BAR[0])} / ${px(HELD_BAR[1])} / ${px(HELD_BAR[2])} / ${px(HELD_BAR[3])}`, "yes", fmt(trapHeld.wickPct, 1), `${yn(g3Held.passed)} - "${g3Held.detail}"`],
    ["0.006640 / 0.006600 / 0.006550 / 0.006570", "no", trapNone ? fmt(trapNone.wickPct, 1) : "-", `${yn(g3None.passed)} - "${g3None.detail}"`],
  ],
);
doc.body(
  `Row 1 by hand: range = 0.006720 - 0.006600 = 0.000120; upper wick = 0.006720 - max(0.006640, 0.006660) = 0.000060; ` +
    `0.000060 / 0.000120 = ${fmt(wickShare(cooling[cooling.length - 1]), 1)}%.`,
  { color: MUTED, size: 8.6 },
);
doc.callout("Intrabar behaviour", [
  "The dashboard includes the forming bar in the scan, so gate 3 can pass while a bar is still open and un-pass if " +
    "that bar recovers before it closes. The TradingView mirror defaults to confirming on bar close (see Appendix). " +
    "The dashboard can therefore lead the indicator by up to one bar.",
]);

/* ================================================================== */
/* 06 Gate 4                                                           */
/* ================================================================== */

doc.heading("Gate 4 - upside liquidity depletion");

doc.body(
  "Price must be AT the long-horizon high: there is then no resting liquidity above to expand into. The test is a " +
    "two-sided band - far below fails (liquidity still overhead) and far above also fails (the level was swept long " +
    "ago and price is in open discovery, the opposite of a spent move). Source: `readHorizon` and the `depletion` " +
    "block of `evaluateExhaustion`.",
);
code([
  "completed  =  daily bars with openTime + 86,400,000 <= now  (forming UTC day EXCLUDED)",
  `window     =  the last round(horizonDays) completed bars   (default ${R.horizonDays}; fetched ${P.dailyLimit})`,
  "H_hor      =  max(window.high),   L_hor = min(window.low) > 0",
  "",
  "gap %      =  (H_hor - P) / P * 100            (signed: + below the high, - above it)",
  `PASS       <=>  |gap %| <= depletionPct                           (default ${R.depletionPct}%)`,
  "ratio      =  2 - |gap %| / max(0.01, depletionPct)",
  "margin     =  PASS ? clamp01(ratio - 1) : 0",
]);
doc.body(
  "Excluding the in-progress day removes a self-reference: if today's own bar could define the horizon, every fresh " +
    "breakout would sit exactly at its own yearly high and pass a test that is supposed to mean nothing is left above. " +
    "It also matches the [1] offset the TradingView indicator uses.",
);

doc.sub("Worked examples (executed) - one daily series, three prices");
doc.body(
  `Series: 400 daily bars; the highest completed-day high is ${px(horizon.high)} (${horizon.days} days behind it). The ` +
    `in-progress day prints ${px(daily[399].high)} and is ignored.`,
  { color: MUTED, size: 8.6 },
);
doc.table(
  [
    { header: "P", width: 78, mono: true },
    { header: "gap %", width: 68, align: "right", mono: true },
    { header: "Gate 4", width: 70 },
    { header: "Detail string", width: CONTENT_W - 216 },
  ],
  [
    [px(ticker.last), fmt(gapAt, 3), `${yn(g4At.passed)} m=${fmt(g4At.margin, 2)}`, g4At.detail],
    [px(0.0066), fmt(gapBelow, 3), yn(g4Below.passed), g4Below.detail],
    [px(0.0068), fmt(gapAbove, 3), yn(g4Above.passed), g4Above.detail],
  ],
);

doc.sub("The '% depth left above' figure (descriptive only)");
doc.body(
  "When a contract is in the deep set, the gate-4 detail appends `poolAbove` from `readLiquidity` (levels.ts). It " +
    "describes the remaining stop-liquidity density above price and is NOT part of the pass test:",
);
code([
  "levels     =  5m fractal pivots (k = 3) + previous day / week / month highs & lows",
  `cluster    =  merge levels within ${P.liqTol}% of price; two merged swings = equal highs/lows`,
  "weight     =  min(1, KIND_WEIGHT * min(1, 0.55 + 0.22 * touches) * recency)",
  "recency    =  min(1, max(0.35, 1 - age / span of the 5m series))",
  "KIND_WEIGHT:  equal 1.00, prev-month 0.95, prev-week 0.85, prev-day 0.75, swing 0.50",
  `poolAbove  =  min(100, round(${P.liqScale} * sum over levels above of weight * e^(-|dist %| / ${P.liqDecay})))`,
]);

/* ================================================================== */
/* 07 Verdict, conviction, ranking & state transitions                  */
/* ================================================================== */

doc.heading("Verdict, conviction & state transitions");

doc.sub("Every gate verdict passes through one builder (`gate`)");
code([
  "safe      =  isFinite(ratio) ? max(0, ratio) : 0",
  "passed    =  measured AND criterion                    (an unmeasured gate can never pass)",
  "progress  =  measured ? min(1, safe) : 0",
  "margin    =  passed ? clamp01(safe - 1) : 0            (saturates at double the threshold)",
]);

doc.sub("The verdict (`evaluateExhaustion`)");
code([
  "passedCount   =  number of gates with passed = true          (0..4)",
  "measuredCount =  number of gates with measured = true",
  "armed         =  passedCount == 4",
  "side          =  armed ? 'short' : 'none'                    (no long branch exists)",
  "conviction    =  armed ? round(60 + 40 * clamp01(mean(margin))) : 0",
]);
doc.body(
  "Conviction starts at 60 so it can never be mistaken for a probability: every armed signal has already cleared " +
    "every threshold, and the number says only by how much. Scanner ordering is: armed first, then passedCount, then " +
    "conviction, then mean progress.",
);

doc.sub("Full worked verdict (executed) - the four examples above on one contract");
doc.table(
  [
    { header: "Gate", width: 150 },
    { header: "Passed", width: 50 },
    { header: "progress", width: 58, align: "right", mono: true },
    { header: "margin", width: 56, align: "right", mono: true },
    { header: "Detail", width: CONTENT_W - 314 },
  ],
  signal.gates.map((g) => [GATE_LABEL[g.key], yn(g.passed), fmt(g.progress, 3), fmt(g.margin, 3), g.detail]),
);
doc.defs(
  [
    ["mean(margin)", `(${signal.gates.map((g) => fmt(g.margin, 3)).join(" + ")}) / 4 = ${fmt(meanMargin, 4)}`],
    ["conviction", `round(60 + 40 x ${fmt(meanMargin, 4)}) = ${signal.conviction}`],
    ["verdict", `armed = ${signal.armed}, side = ${signal.side}, passedCount = ${signal.passedCount}/4`],
    ["3-of-4 variant", `same contract with the held bar: passedCount = ${threeOfFour.passedCount}, armed = ${threeOfFour.armed}, conviction = ${threeOfFour.conviction} -> radar state ARMED 3/4`],
  ],
  96,
);

doc.sub("State transitions");
doc.table(
  [
    { header: "Transition", width: 128 },
    { header: "Exact condition", width: 210 },
    { header: "Effect", width: CONTENT_W - 338 },
  ],
  [
    ["IDLE -> ARMED 3/4", `passedCount >= ${P.radarArmAt} on a scan pass (every ${R.refreshMs / 1000}s)`, "RadarProvider attaches depth20@100ms, aggTrade, markPrice@1s; shares !forceOrder@arr. Chip gets the mini gauges."],
    ["ARMED -> SIGNAL 4/4", "passedCount == 4 (armed = true)", "Alert raised if cooldown and re-arm allow (below). RadarState 'signal'."],
    ["SIGNAL alert gate", `rearmed(symbol:short) AND now - lastAlert >= ${R.cooldownMins} min`, "Alert stored (max " + P.maxAlerts + "), chime, desktop, toast, Telegram/Discord. rearmed := false."],
    ["Re-arm", `>= ${P.rearmFails} gates with measured = true AND passed = false (setupFellApart)`, "rearmed := true. Unmeasured gates do not count: a data gap can never re-arm."],
    [`ARMED -> IDLE (radar)`, `passedCount < ${P.radarArmAt} for ${P.radarGraceMin} min (grace), unless focused or held`, "Streams unsubscribed, all buffers for that contract dropped."],
  ],
);
doc.defs(
  [
    ["Fell-apart example", `pin fails and climax fails with gates 3-4 measured: setupFellApart = ${setupFellApart(fellApart)} (executed)`],
  ],
  110,
);
doc.callout("Cooldown memory is per session", [
  "The cooldown and re-arm maps live in memory. A page reload forgets them, so a contract that is still at 4/4 after " +
    "a reload alerts again immediately. Alerts themselves are persisted. Listed as finding F9.",
]);

/* ================================================================== */
/* 08 Order book depth & imbalance                                     */
/* ================================================================== */

doc.heading("Order book depth & imbalance");

doc.body(
  `Input: \`<symbol>@depth20@100ms\` - the top 20 bids and 20 asks, ten times a second. A frame with an empty side ` +
    "is discarded and the previous snapshot stands. Source: `readDepth` in micro.ts (shares and pressure) and " +
    "`readBook` in engines.ts (the signed imbalance, spread, mid).",
);
code([
  "mid           =  (bestBid + bestAsk) / 2",
  "spread %      =  (bestAsk - bestBid) / mid * 100",
  "B, A          =  sum of bid notional, sum of ask notional over the 20 levels",
  "",
  "RAW",
  "rawBidShare % =  B / (B + A) * 100                     (rawAskShare = 100 - rawBidShare)",
  "imbalance     =  (B - A) / (B + A)              (-1 all asks .. +1 all bids; readBook)",
  "",
  "WEIGHTED      (i = level rank from the touch, 0..19)",
  `w_i           =  e^(-i / ${P.depthTau})`,
  "Bw, Aw        =  sum of notional_i * w_i on each side",
  "weightedBidShare % =  Bw / (Bw + Aw) * 100",
  "pressurePts   =  | 2 * weightedBidShare - 100 |   (0 = balanced, 100 = one-sided)",
  `pressure      =  pts < ${P.pressureBalancedPts} ? balanced : weightedBidShare > 50 ? bids : asks`,
  "depth row i   =  cumulative notional from the touch down to level i",
]);
doc.body(
  "The weighted share drives the imbalance bar; the raw share is printed beside it so a wall deep in the book cannot " +
    "hide. Both are shares of resting notional, never of order count.",
);

doc.sub("How much each level counts (executed)");
doc.table(
  [
    { header: "Level", width: 56, mono: true },
    { header: "weight", width: 62, align: "right", mono: true },
    { header: "cum. share", width: 70, align: "right", mono: true },
    { header: "Level", width: 56, mono: true },
    { header: "weight", width: 62, align: "right", mono: true },
    { header: "cum. share", width: 70, align: "right", mono: true },
    { header: "", width: CONTENT_W - 376 },
  ],
  Array.from({ length: 10 }, (_, k) => [
    `${k}`,
    fmt(weights[k], 3),
    pct(cumulative[k] * 100, 1),
    `${k + 10}`,
    fmt(weights[k + 10], 3),
    pct(cumulative[k + 10] * 100, 1),
    "",
  ]),
);
doc.body(
  `The first four levels on each side carry ${pct(cumulative[3] * 100, 1)} of the weight; levels 10-19 carry ` +
    `${pct((1 - cumulative[9]) * 100, 1)}. The weight halves every ${fmt(P.depthTau * Math.LN2, 2)} levels.`,
  { color: MUTED, size: 8.6 },
);

doc.callout(
  "Weighting is by rank, not by price distance",
  [
    "The decay runs over the level INDEX, not over the price gap in bps, and the mark price is not an input to the " +
      "imbalance at all. On a tight book the two are equivalent; on a sparse book with uneven tick gaps the 6th level " +
      "may sit far from the touch in bps yet still carry weight 0.37. If the quantitative rules require distance " +
      "weighting (w = e^(-d_bps / tau)), that is a reducer-only change. Listed as finding F1.",
  ],
  RED,
);

doc.sub("Worked example (executed) - 20 x 20 book, one large ask at level 7");
doc.defs(
  [
    ["Bids", `${px(book.bids[0].price)} down in 0.000001 steps; notional $1,500-$2,600 per level, B = ${usd(depth.bidNotional)}`],
    ["Asks", `${px(book.asks[0].price)} up in 0.000001 steps; $1,500-$2,400 per level except level 7 = $9,800, A = ${usd(depth.askNotional)}`],
    ["mid / spread", `${px(depth.mid)} / ${pct(depth.spreadPct ?? 0, 4)}`],
    ["raw bid share", `${pct(depth.rawBidShare, 2)}   (imbalance ${fmt(walls.book.imbalance, 4)})`],
    ["weighted", `Bw = ${fmt(wBid, 1)}, Aw = ${fmt(wAsk, 1)} -> bid share ${pct(depth.weightedBidShare, 2)}`],
    ["pressure", `${depth.pressure.toUpperCase()} by ${fmt(depth.pressurePts, 2)} pts`],
  ],
  96,
);
doc.body(
  "The $9,800 ask sits at rank 7 (weight " + fmt(weights[7], 3) + "), so it moves the raw share more than the weighted " +
    "one - exactly the case the two readings are shown side by side for.",
  { color: MUTED, size: 8.6 },
);

/* ================================================================== */
/* 09 Whale walls & whale prints                                       */
/* ================================================================== */

doc.heading("Whale walls & whale prints");

doc.sub("Walls in the book (`findWalls` / `readBook`, called by `readWalls`)");
code([
  `requires      >= ${P.minWallLevels} levels on the side; mean > 0`,
  "mean_side     =  sum(notional) / levels                 (per side, over its 20 levels)",
  `WALL          <=>  notional_i >= ${WALL_STRENGTH} * mean_side          (WALL_STRENGTH = ${WALL_STRENGTH})`,
  "strength      =  notional_i / mean_side                 (3.0 = exactly at the bar)",
  "distance %    =  (price_i - mid) / mid * 100",
  `kept          =  the ${P.wallsKept} largest by notional across both sides (radar: nearest-first)`,
  "dominantWall  =  side of the single largest wall",
]);
doc.body(
  "There is no absolute dollar minimum and no median: the test is a multiple of the side's own mean level, so a " +
    "$3,000 level is a wall on a book whose levels average $900. The panel prints the wall's notional and strength so " +
    "the trader can weigh it; see finding F2 for the recommended floor.",
);
doc.defs(
  [
    ["Executed", `ask mean = ${usd(askMean)}; level 7 = $9,800 -> strength ${fmt(walls.ask[0].strength, 2)}x, distance ${pct(walls.ask[0].distance, 3)} -> WALL`],
    ["Bid side", `bid mean = ${usd(bidMean)}; largest bid level $2,600 = ${fmt(2600 / bidMean, 2)}x -> no wall (${walls.bid.length} found)`],
  ],
  96,
);

doc.sub("Wall lifecycle between publishes (every " + P.publishMs + " ms)");
code([
  `same wall     <=>  same side and |price - previous.price| <= ${P.wallTol}% of mid`,
  `relocated     <=>  gone, but a wall of the same side exists within ${P.wallNear}% of mid`,
  "absorbed      <=>  gone AND price traded through it",
  "                   (sell wall: bestBid >= wall price; buy wall: bestAsk <= wall price)",
  "pulled        <=>  gone, not traded through, nothing nearby",
  "spoofSuspected <=> pulled >= 2  or  (pulled >= 1 and relocated >= 1)",
]);

doc.sub("Whale prints on the tape (`whaleThreshold`)");
code([
  `floor         =  max($1,000, ${P.whaleSqrtFactor} * sqrt(Q24))`,
  `whaleAt       =  prints < ${P.whaleMinPrints} ? floor : max(floor, ${P.whaleMedianMultiple} * median(print notional))`,
  `prints        =  the newest ${P.rawTrades} raw prints of this contract; recomputed every publish`,
]);
doc.table(
  [
    { header: "Q24", width: 80, align: "right", mono: true },
    { header: "0.35 x sqrt(Q24)", width: 100, align: "right", mono: true },
    { header: "floor", width: 80, align: "right", mono: true },
    { header: "15 x median ($" + fmt(whaleRows[0].median, 0) + ")", width: 110, align: "right", mono: true },
    { header: "whaleAt", width: CONTENT_W - 370, align: "right", mono: true },
  ],
  whaleRows.map((r) => [compact(r.q), usd(P.whaleSqrtFactor * Math.sqrt(r.q)), usd(r.floor), usd(r.median * P.whaleMedianMultiple), usd(r.withMedian)]),
);
doc.body(
  "The square-root floor keeps the bar sensible on both ends: a sub-cent alt with $5M/day turnover counts $1,000 " +
    "prints, a $20B/day contract needs about $50K. A print at or above whaleAt is counted in the minute buckets " +
    "(whaleBuys/whaleSells over the 1h window) and appended to the whale tape (newest " + P.whalesKept + " kept). " +
    "Classification happens when the print arrives; a later change of whaleAt does not reclassify old prints (F7).",
);

/* ================================================================== */
/* 10 Squeeze volume & turnover scaling                                */
/* ================================================================== */

doc.heading("Squeeze volume & turnover scaling");

doc.body(
  `Source: \`${LIQUIDATION_STREAM}\` - every forced order on the venue, one stream shared by all attached contracts and ` +
    "filtered locally. The squeeze meter sums forced-order notional inside a rolling " + RADAR_WINDOW_MS / 60_000 +
    "-minute window and judges it against thresholds derived from the contract's OWN turnover. Source: " +
    "`squeezeThresholds`, `squeezeLevel`, `readSqueeze` in micro.ts.",
);
code([
  "hourly        =  max(0, Q24) / 24                      (an average hour's turnover)",
  `medAt (warm)  =  max($1,000, ${P.squeezeMedShare} * hourly)          (${P.squeezeMedShare * 100}% of an hour force-closed)`,
  `highAt (hot)  =  max($5,000, ${P.squeezeHighShare} * hourly)           (${P.squeezeHighShare * 100}% of an hour force-closed)`,
  "",
  "volume        =  sum(notional of forced orders with at >= now - 60 min)",
  "shortLiq      =  sum over side BUY  (shorts liquidated)      longLiq = sum over side SELL",
  "level         =  volume >= highAt ? HOT : volume >= medAt ? WARM : COLD",
  `direction     =  volume == 0 ? none : shortLiq/volume >= ${P.squeezeShortShare} ? short-squeeze`,
  `                 : shortLiq/volume <= ${P.squeezeLongShare} ? long-flush : mixed`,
]);
doc.callout("'Low / Med / High' maps onto cold / warm / hot", [
  "There are exactly two thresholds. 'Low' (cold) is not a band with its own floor: it is everything below medAt, " +
    "including zero. The chip indicator lights one segment as soon as any forced order lands in the window, two at " +
    "warm and three at hot.",
]);

doc.sub("Thresholds by turnover (executed)");
doc.table(
  [
    { header: "Q24", width: 90, align: "right", mono: true },
    { header: "hourly", width: 100, align: "right", mono: true },
    { header: "warm from (medAt)", width: 120, align: "right", mono: true },
    { header: "hot from (highAt)", width: CONTENT_W - 310, align: "right", mono: true },
  ],
  squeezeRows.map((r) => [compact(r.q), usd(r.q / 24), usd(r.medAt), usd(r.highAt)]),
);

doc.sub("Worked read (executed) - six forced orders inside the hour, one outside it, Q24 = $5M");
doc.defs(
  [
    ["Inside window", liqs.filter((l) => l.at >= NOW - RADAR_WINDOW_MS).map((l) => `${l.side} ${usd(l.notional)}`).join(", ")],
    ["Dropped", `SELL ${usd(liqs[6].notional)} at 75 min - outside the 60-minute window`],
    ["volume", `${usd(squeeze.volume)} = shorts ${usd(squeeze.shortLiq)} + longs ${usd(squeeze.longLiq)}  (${squeeze.count} orders)`],
    ["thresholds", `medAt ${usd(squeeze.medAt)}, highAt ${usd(squeeze.highAt)} -> level ${squeeze.level.toUpperCase()}`],
    ["direction", `shortLiq / volume = ${fmt(squeeze.shortLiq / squeeze.volume, 3)} -> ${squeeze.direction}`],
  ],
  96,
);
doc.callout("The stream is a snapshot, so the volume is a floor", [
  "Binance's all-market force-order stream pushes at most one order per contract per second. During a cascade the " +
    "measured volume therefore UNDER-states the true forced volume. Levels are calibrated with that in mind; the " +
    "meter should be read as 'at least this much'.",
]);

doc.sub("Relation to RVOL");
doc.body(
  "The squeeze meter is not an RVOL measure and does not read klines. RVOL (gate 2, section 04) is traded volume " +
    "against an 8-hour baseline; the squeeze meter is forced-order notional against the contract's hourly turnover. " +
    "They are independent columns.",
);

/* ================================================================== */
/* 11 Synthetic liquidation clusters                                   */
/* ================================================================== */

doc.heading("Synthetic liquidation clusters");

doc.body(
  "The same forced orders, bucketed by price around the live price to show where the stops sat. Source: " +
    "`liquidationClusters` in micro.ts; the panel draws the top clusters as price lines on the chart.",
);
code([
  `width         =  P * ${CLUSTER_BIN_PCT} / 100                           (${CLUSTER_BIN_PCT}% of the live price)`,
  "idx           =  round((p_liq - P) / width)                     (bin 0 is centred on P)",
  "centre        =  P + idx * width;   lo = centre - width/2;  hi = centre + width/2",
  "per bin       :  notional (sum), count, longLiq (SELL), shortLiq (BUY)",
  "share         =  bin.notional / sum of ALL bins in the window   (computed before trimming)",
  "distance %    =  (centre - P) / P * 100",
  `output        =  the ${P.clusterLimit} largest bins by notional`,
  "window        =  at >= now - 60 min   (hard cutoff; no weighting inside the window)",
]);

doc.sub("Worked example (executed) - P = " + px(clusterPrice) + ", width = " + px(binWidth));
doc.table(
  [
    { header: "idx", width: 40, align: "right", mono: true },
    { header: "centre", width: 76, mono: true },
    { header: "lo - hi", width: 136, mono: true },
    { header: "notional", width: 66, align: "right", mono: true },
    { header: "share", width: 54, align: "right", mono: true },
    { header: "dist %", width: 54, align: "right", mono: true },
    { header: "n", width: CONTENT_W - 426, align: "right", mono: true },
  ],
  clusters.map((c) => [
    `${Math.round((c.price - clusterPrice) / binWidth)}`,
    px(c.price),
    `${px(c.lo)} - ${px(c.hi)}`,
    usd(c.notional),
    pct(c.share * 100, 1),
    fmt(c.distancePct, 3),
    `${c.count}`,
  ]),
);
doc.body(
  "Bin arithmetic for the first row: (0.006662 - 0.006650) / " + px(binWidth) + " = " + fmt((0.006662 - clusterPrice) / binWidth, 3) +
    " -> idx 1; the $2,500 order at 0.006665 rounds to the same bin, so the two merge into one cluster.",
  { color: MUTED, size: 8.6 },
);

doc.callout(
  "Intensity and decay - what is and is not modelled",
  [
    "Intensity is the bin's share of forced notional in the window, nothing more. There is NO time decay: an order " +
      "59 minutes old weighs exactly as much as one from a minute ago, and at 60 minutes it vanishes. Because bins are " +
      "re-anchored on the live price every " + P.publishMs + " ms, bin edges drift with price - clusters are a heat map " +
      "around price, not fixed absolute levels. Listed as finding F4.",
    "Buffers: the newest " + P.liqsKept + " forced orders per contract are kept and pruned to the window on each publish.",
  ],
  RED,
);

/* ================================================================== */
/* 12 OI, funding & aggressive flow                                    */
/* ================================================================== */

doc.heading("Open interest, funding & aggressive flow");

doc.sub("OI 5-minute trend (`readOiTrend`, `slopePct`)");
code([
  `points        =  openInterestHist period=5m, ${P.oiHistPoints} snapshots (3 h), every ${P.oiHistSec} s`,
  `                 + live openInterest (every ${P.oiLiveSec} s) when > 60 s newer than the last point`,
  `tail          =  the last ${P.oiTrendPoints} points (30 min);  requires >= 3 else trend = unknown`,
  "beta          =  OLS slope of OI on x = 0..n-1     sum((x-xm)(y-ym)) / sum((x-xm)^2)",
  "slope %       =  beta * (n - 1) / mean(y) * 100   (fitted change over the tail, % of OI)",
  `trend         =  slope % > ${P.oiTrendMinPct} ? RISING : slope % < -${P.oiTrendMinPct} ? FALLING : FLAT`,
]);
doc.defs(
  [
    ["Executed, rising", `OI 1,000,000 -> 1,006,000 in 1,200 steps: slope ${pct(oiRising.slopePct, 3)} -> ${oiRising.trend.toUpperCase()}`],
    ["Executed, flat", `OI alternating 1,000,000 / 1,000,300: slope ${pct(oiFlat.slopePct, 3)} -> ${oiFlat.trend.toUpperCase()}`],
  ],
  110,
);

doc.sub("OI deltas and the price / OI regime (`readOpenInterest`)");
code([
  "change_w %    =  (OI_now - OI(t - w)) / OI(t - w) * 100     for w in {5m, 15m, 1h, 4h, 1d}",
  `OI(t - w)     =  newest sample at or before t - w, but not more than ${P.oiExtrapHours} h older than that",`,
  "headline      =  first defined of [15m, 1h, 5m, 4h, 1d]",
  `oiUp / oiDown =  headline > +${P.oiUpPct}%  /  < -${P.oiUpPct}%`,
  `priceUp/Down  =  price change over 15 min (from the tape) > +${P.priceUpPct}%  /  < -${P.priceUpPct}%`,
  "regime        =  priceUp & oiUp: new-longs    priceDown & oiUp: new-shorts",
  "                 priceUp & oiDown: short-covering   priceDown & oiDown: long-liquidation",
  "                 otherwise: flat",
]);
doc.defs(
  [
    ["Executed", `rising example: change15m ${pct(oiRising.read.change15m ?? 0, 3)}, price +0.30% -> regime ${oiRising.read.regime}`],
  ],
  110,
);

doc.sub("Funding (mark-price stream)");
code([
  "rate %        =  r * 100                      shown with next funding time (field T)",
  "library only  :  annualised = rate * 3 * 365;  basis % = (mark - index) / index * 100",
  "                 (readFunding in engines.ts - not on any display path today)",
]);

doc.sub("Aggressive flow over the recent tape (`readFlow`, newest " + P.rawTrades + " prints)");
code([
  "buyVolume, sellVolume  =  sums of notional by aggressor side",
  "buyShare %    =  buy / (buy + sell) * 100     delta = buy - sell",
  "imbalance     =  delta / (buy + sell)          (-1 .. +1)",
  "CVD series    =  running delta sampled into min(24, max(4, round(n / 12))) buckets",
  `divergence    =  halves: price HH with CVD LH -> bearish; price LL with CVD HL -> bullish`,
  `                 (price tolerance ${P.divergenceTol}% of the first-half high)`,
  `absorption    =  |imbalance| >= ${P.absorptionImb} and |price move first -> last| < ${P.absorptionMove}%`,
  "                 -> 'upper' when buyers were absorbed, 'lower' when sellers were",
]);
doc.defs(
  [
    ["Executed", `8 buys x $900 + 4 sells x $300 at a flat price: buyShare ${pct(flow.buyShare, 1)}, imbalance ${fmt(flow.imbalance, 3)}, absorption ${flow.absorption}`],
    ["1h flow window", "minute buckets (buy, sell, count, whale counts, open, close) summed over the last 60 min; buyShare as above"],
  ],
  110,
);

/* ================================================================== */
/* 13 Edge cases & data validation                                     */
/* ================================================================== */

doc.heading("Edge cases & data validation");

doc.body(
  "The cardinal rule: an unmeasured gate never counts as passed, and never counts as failed either. Every guard " +
    "below resolves to one of three outcomes - a value, 'unmeasured', or a dropped frame - and none of them can " +
    "manufacture a number.",
);

doc.sub("Missing or late frames");
doc.table(
  [
    { header: "Situation", width: 128 },
    { header: "Mechanism", width: 230 },
    { header: "Effect on verdicts", width: CONTENT_W - 358 },
  ],
  [
    ["Tier-1 socket silent", `${P.connectTimeoutSec} s handshake watchdog; endpoint shape rotates; backoff 1 s x 2^n (max 30 s) + jitter; 'blocked' after one failure per shape, then ${P.socketProbeSec} s probes`, `REST poll every ${P.restPollSec} s takes over whenever no ticker frame arrived in ${P.socketFreshSec} s. Same venue, same fields.`],
    ["REST failing", `${P.pollFailBlock} consecutive poll failures -> restOk = false; transport 'none' if the socket is also stale`, "Scores stop updating; nothing is synthesised. Status band shows the state."],
    ["5m history stale", `served only while <= ${KLINE_MAX_AGE_MS / 1000} s old AND the contract is still tracked (refresh every ${P.deepRefreshSec} s, TTL ${P.klineTtlSec} s)`, "Gates 2 (precise), 3, 4 read unmeasured -> cannot arm; cannot re-arm either."],
    ["Daily history stale", `served only while <= ${DAILY_MAX_AGE_MS / 60_000} min old AND fetched on the same UTC day (TTL ${P.dailyTtlMin} min)`, "Gate 4 unmeasured. Prevents yesterday's forming bar being read as a completed day."],
    ["Radar socket silent", `per route: ${P.staleSec} s without a frame while its heartbeat stream (depth on /public, markPrice@1s on /market) is subscribed -> reconnect; ${P.radarBlockedAfter} failures -> 'blocked' with 60 s retries`, "Reads keep the last snapshot; `lastDepthAt` ages visibly. Full re-subscribe of that route on reconnect."],
    ["Chart / OI REST", "12 s timeout per call; failures leave previous points in place", "'no data from venue' instead of a substitute number."],
  ],
);

doc.sub("Degenerate books, prints and series");
doc.table(
  [
    { header: "Situation", width: 128 },
    { header: "Guard", width: 230 },
    { header: "Result", width: CONTENT_W - 358 },
  ],
  [
    ["Zero-depth / one-sided book", "depth frame with an empty side is ignored; readDepth/readBook return EMPTY when either side is empty", "50 / 50, 'balanced', imbalance 0, no walls. Previous snapshot stands until a valid one arrives."],
    ["Thin book", `< ${P.minWallLevels} levels or mean <= 0 on a side -> no walls on that side`, "No wall can be declared from one or two levels."],
    ["Zero range bar", "wickShare returns 0 when high - low <= 0", "Gate 3 cannot pass on a flat bar."],
    ["Few prints", `< ${P.whaleMinPrints} prints -> whaleAt = floor only; readFlow with no prints -> buyShare 50, imbalance 0`, "No whale inflation from a tiny sample."],
    ["Short OI series", "< 3 points -> trend unknown; windows beyond the data -> change undefined (not 0%)", "'-' in the matrix rather than a false FLAT."],
    ["Division guards", "max(0.01, pinBps), max(1, rvolClimax), max(1, wickPct), avg > 0, total > 0, meanY > 0, den != 0", "No Infinity/NaN reaches a verdict; gate() maps non-finite ratios to 0."],
    ["Malformed payloads", "JSON parse failure -> frame ignored; kline rows need >= 9 fields; symbols must end in USDT without '_'", "Dropped silently; subscribe errors surface in the radar status."],
  ],
);

doc.sub("Flash crashes, spikes and extreme illiquidity");
doc.bullets([
  "Spike through the 24h high: gate 1 clamps the negative distance to zero (a sweep is a reach). Gate 4 is " +
    "two-sided, so a vertical move far ABOVE the horizon high fails with 'price is in discovery' rather than passing " +
    "hardest exactly when its premise is most false.",
  `Volume at the open of a bar: the projection only engages after ${P.rvolElapsedMin * 100}% of the bar; before that the ` +
    "raw partial volume is used and can only under-read RVOL. A negative rolling-volume delta on the fallback path " +
    "reads unmeasured, never zero.",
  `Crash out of the universe: an alt whose price leaves (${PRICE_BAND_MIN}, ${PRICE_BAND_MAX}) is dropped on the next pass, ` +
    "its alert history pruned by the price it was raised at, and the focus panel falls back to BTCUSDT. BTCUSDT is exempt.",
  `Illiquid contracts: Q24 < ${compact(R.minVolume)} is never scored; the whale floor ($1,000), squeeze floors ($1,000 / $5,000) ` +
    "and the turnover-scaled thresholds prevent a $200 forced order lighting a 'hot' squeeze on a dead book.",
  "Persisted configuration is re-clamped on load (pinBps 0.5-100, rvolClimax 150-2000, wickPct 45-95, depletionPct " +
    "0-10, horizonDays 30-365, deepWatch 2-24, cooldown 1-1440 min, refresh in {1,2,3,5} s), so a stale or hand-edited " +
    "setting cannot make the engine arm on nothing.",
]);

doc.sub("Why none of this can skew a 'Confluence Score'");
doc.callout(
  "There is no composite confluence score",
  [
    "The Confluence Matrix is a table of independent reads - book imbalance, whale walls, OI trend, squeeze, " +
      "liquidation cluster - each of which can be missing ('-') without touching the others, and none of which feeds " +
      "the four gates. The only composite number in the system is conviction (60-100), computed from gate margins " +
      "alone and only at 4/4. A degenerate radar read can therefore never move a gate, a conviction or an alert.",
  ],
  GREEN,
);

doc.sub("Memory and buffer caps");
doc.body(
  `Raw prints ${P.rawTrades}, whale prints ${P.whalesKept}, forced orders ${P.liqsKept} (pruned to 60 min), chart bars ` +
    `${P.chartBarsMax}, ticker volume samples ${P.volSamples}, alerts ${P.maxAlerts}, pinned ${P.pinnedMax}, held ${P.holdsMax}. ` +
    "Buffers for a contract that leaves the radar are dropped in full; re-attaching starts clean.",
  { color: MUTED, size: 8.6 },
);

/* ================================================================== */
/* 14 Findings & recommendations                                       */
/* ================================================================== */

doc.heading("Findings & recommendations");

doc.body(
  "Everything below is a faithful description of current behaviour. Items marked 'decision' are places where the " +
    "implementation makes a choice the quantitative rules may or may not share; none of them is a defect in the " +
    "arithmetic. Items marked 'gap' are recommended changes.",
);

doc.table(
  [
    { header: "#", width: 30, mono: true },
    { header: "Finding", width: 290 },
    { header: "Type", width: 54 },
    { header: "Recommendation", width: CONTENT_W - 374 },
  ],
  [
    ["F1", `Depth imbalance weights by level rank (e^(-i/${P.depthTau})), not by bps distance; mark price unused.`, "decision", "Switch to w = e^(-d_bps / tau) if the rules require distance weighting."],
    ["F2", `Whale walls: ${WALL_STRENGTH}x the side's mean level, no absolute USD floor; thin books flag small walls.`, "decision", "Add floor = max(3x mean, k x hourly turnover) if desired."],
    ["F3", "Squeeze: two thresholds only (warm 2.5%, hot 25% of hourly turnover). 'Low' = below warm.", "decision", "Add an explicit low floor only if a third band is needed."],
    ["F4", "Liquidation clusters: hard 60-min window, no intra-window decay; bins re-anchored on the live price.", "decision", "Optional half-life weighting and fixed grid if absolute levels are wanted."],
    ["F5", "`armed` in code = 4/4; UI 'ARMED 3/4' is a different bar (passedCount >= 3).", "naming", "Downstream automation must key on passedCount, not the word."],
    ["F6", "Gate 3 scans the forming bar; the Pine mirror confirms on close by default. Dashboard may lead by one bar.", "decision", "Acceptable for alerting; note in the trading rules."],
    ["F7", "Whale prints are classified at arrival; a later change of whaleAt does not reclassify history.", "minor", "Harmless at 600-print depth; document."],
    ["F8", tests.radar ? `Radar reducers and transport now carry ${tests.radar} dedicated unit tests (radarMicro, radarStream); the macro engine has ${tests.wick}.` : `Radar reducers (micro.ts) have no dedicated unit tests; the macro engine has ${tests.wick}.`, tests.radar ? "closed" : "gap", tests.radar ? "Keep the suites green on every stream-mapping change." : "Add a radar.test.ts covering depth, walls, squeeze, clusters, OI slope."],
    ["F9", "Alert cooldown / re-arm memory is per browser session; a reload can re-alert a live 4/4 immediately.", "minor", "Persist the cooldown map alongside alerts."],
    ["F10", "Gate 2 fallback RVOL (no klines) is less precise; it can pass gate 2 but can never arm (gates 3-4 need klines).", "info", "None."],
    ["F11", "Forced-order stream is a 1/s per-contract snapshot, so squeeze volume and clusters are floors.", "info", "Read the meter as 'at least'."],
  ],
);

/* ================================================================== */
/* 15 Appendix                                                         */
/* ================================================================== */

doc.heading("Appendix - Pine mirror, on-chain add-on, verification");

doc.sub("A. TradingView mirror (nova-exhaustion-trap.pine) - parity by gate");
doc.table(
  [
    { header: "Gate", width: 62 },
    { header: "Dashboard", width: 196 },
    { header: "Pine indicator", width: CONTENT_W - 258 },
  ],
  [
    ["1 pin", "(H24 - P) / P x 10,000 with the venue's rolling 24h high; P = last price", "(prior24High - high) / prior24High x 10,000; prior24High = highest(high, barsPerDay)[1]. Same 5 bps."],
    ["2 climax", `quote volume; mean of ${RVOL_LOOKBACK} COMPLETED bars; forming bar projected; cooling = RVOL - prevRVOL <= 0`, `base volume; sma(volume, ${RVOL_LOOKBACK}) INCLUDING the forming bar; no projection; cooling = rvol <= rvol[1]. Same 300%.`],
    ["3 trap", `newest ${TRAP_SCAN} bars, best wick; forming bar included`, `current bar only; confirmClose default ${P.pineClose ? "on" : "off"}. Same 12-bar higher high, same 45%.`],
    ["4 depletion", "completed daily bars, (H_hor - P) / P, |gap| <= 0.5%", "security('D', highest(high, 365)[1], lookahead_off), (H_hor - high) / H_hor, |gap| <= 0.5%."],
    ["cooldown", `${R.cooldownMins} min per symbol + re-arm after 2 measured failures`, `${P.pineCooldownBars} bars; no universe or turnover filter (chart-bound).`],
  ],
);
doc.body(
  "The intrabar readings of gates 2 and 3 therefore differ between the two implementations and converge at bar " +
    "close. The thresholds, the completed-day horizon and the two-sided depletion band are identical.",
  { color: MUTED, size: 8.6 },
);

doc.sub("B. On-chain add-on (functions/_lib/flow.ts `analyze`) - verdict arithmetic");
code([
  `window        =  signal time - ${P.chainBeforeMin} min .. + ${P.chainAfterMin} min`,
  `transfers     =  fetched from ${compact(FETCH_FLOOR_USD)}; a single transfer > ${compact(CLUSTER_MAX_USD)} is an outlier and excluded`,
  "direction     =  in (-> exchange, bearish) | out (exchange ->, bullish)",
  "                 | internal | venue | ignored   (only in / out are clustered)",
  "cluster       =  sum per (direction, counterparty)",
  `kept          <=>  ${compact(CLUSTER_MIN_USD)} <= cluster.usd <= ${compact(CLUSTER_MAX_USD)}`,
  "net           =  outflowUsd - inflowUsd;   dominance = |net| / (inflowUsd + outflowUsd)",
  `verdict       =  dominance >= ${DOMINANCE_MIN} ? (net > 0 ? accumulation : distribution) : mixed`,
  "                 (none when there is no kept flow at all)",
  "confidence    =  high if a smart-money cluster sits on the dominant side",
  `                 medium if dominance >= ${P.chainMediumDom} and (>= 2 dominant clusters`,
  `                 or dominant USD >= ${compact(P.chainMediumUsd)})`,
  "                 else low",
  "alignment     =  short: distribution confirms, accumulation contradicts, otherwise neutral",
]);

doc.sub("C. Verification status");
doc.table(
  [
    { header: "Suite", width: 170, mono: true },
    { header: "Tests", width: 50, align: "right", mono: true },
    { header: "Covers", width: CONTENT_W - 220 },
  ],
  [
    ["wick.test.ts", String(tests.wick), "gates 1-4, evaluateExhaustion, candidacy, engines, levels, sanitiser, headline/reasons"],
    ["feedFreshness.test.ts", String(tests.feed), "kline / daily freshness windows, UTC-day roll, tracked-only serving"],
    ["universe.test.ts", String(tests.universe), "price band, BTC exemption, pruning"],
    ["btcTrap.test.tsx", String(tests.btcTrap), "gate-3 edge detector for the BTCUSDT log"],
    ["onchainFlow / Schedule / Client / Tokens", String(tests.onchain), "flow verdict arithmetic, scan scheduling, client, token ids"],
    ["journal.test.ts, format.test.ts", String(tests.misc), "journal maths and formatting"],
    ["radarMicro.test.ts, radarStream.test.ts", String(tests.radar), tests.radar ? "depth weighting, walls, flow buckets, whale line, squeeze, clusters, OI slope; stream routing, subscribe payloads, frame parsing, reconnect, stale" : "finding F8 - covered here by build-time execution only"],
  ],
);
doc.body(
  "Every figure labelled 'executed' in this report was produced by calling the shipped functions during the PDF " +
    "build. Regenerate after any engine change with: bun --tsconfig-override tsconfig.app.json " +
    "scripts/build-engine-audit.ts. The build fails if a pinned constant has moved.",
  { color: MUTED, size: 8.6 },
);

doc.callout("Scope statement", [
  "This audit covers the dashboard engine as shipped in the web app and the Cloudflare on-chain add-on. It does not " +
    "cover the Monthly Trap or VWAP Distance indicators, which have their own manuals, and it makes no claim about " +
    "the predictive value of any rule - only about what the code computes.",
]);

/* ---------------- finish ---------------- */

doc.finish(`NOVA DCA - UNIFIED ENGINE AUDIT ${VERSION} - ${buildDate}`);
// Replay the contents onto the cover now that every heading has a page.
{
  const cover = doc.pdf.getPage(0);
  let y = tocY;
  for (const item of doc.toc) {
    cover.drawText(String(item.num).padStart(2, "0"), { x: MARGIN.x, y, size: 8, font: doc.fonts.monoBold, color: AMBER });
    cover.drawText(sanitize(item.title), { x: MARGIN.x + 24, y, size: 8.8, font: doc.fonts.sans, color: rgb(0.09, 0.1, 0.13) });
    const num = String(item.page).padStart(2, "0");
    cover.drawText(num, { x: PAGE.w - MARGIN.x - doc.fonts.mono.widthOfTextAtSize(num, 8), y, size: 8, font: doc.fonts.mono, color: MUTED });
    y -= 14.8;
  }
  if (y < MARGIN.bottom) throw new Error(`contents overflow the cover by ${Math.round(MARGIN.bottom - y)}pt`);
}

if (overlong.length) throw new Error(`code lines too long for the box:\n${overlong.join("\n")}`);
const bytes = await doc.save();
await writeFile(OUT, bytes);
console.log(`wrote ${path.relative(process.cwd(), OUT)} - ${doc.pageNumber} pages, ${Math.round(bytes.length / 1024)} KB`);
console.log(`executed checks: signal conviction ${signal.conviction}, 3/4 variant ${threeOfFour.passedCount}, fell-apart ${setupFellApart(fellApart)}`);
