/**
 * Instruments — the always-on per-instrument data layer of V2.
 *
 * The terminal monitors exactly two instruments, BTCUSDT and USDCUSDT, and
 * every panel needs live data for BOTH at all times — not only when the
 * exhaustion engine has a setup. This provider runs its own routed socket
 * pair (the same RouteSocket machinery the radar uses) and subscribes
 * permanently:
 *
 *   public   depth20@100ms           — order book, walls
 *   market   aggTrade ×2             — tape, whales, flow
 *   market   markPrice@1s ×2         — mark, funding
 *   market   kline_1h ×2             — the Wick Signal Monitor's candles
 *   market   kline_5m ×2             — VWAP and intraday price change
 *   market   !forceOrder@arr         — liquidations, squeeze
 *
 * Open interest is polled from REST. The 1H candles feed the wick-signal
 * detector; everything else is reduced with the same micro.ts reducers the
 * radar uses, so numbers agree panel-to-panel. This layer READS the macro
 * engine's outputs (24h turnover for scale) and never writes into it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  foldTrade,
  liquidationClusters,
  priceChangeOver,
  pruneBuckets,
  readDepth,
  readFlowWindow,
  readOiTrend,
  readSqueeze,
  readWalls,
  whaleThreshold,
  RADAR_WINDOW_MS,
  type MinuteBucket,
} from "@/lib/radar/micro";
import { fetchChartBars, fetchOiHistory, fetchOiLive } from "@/lib/radar/rest";
import { klineStream, microStreams, LIQUIDATION_STREAM, RadarStream } from "@/lib/radar/stream";
import type {
  ChartBar,
  LiquidationEvent,
  RadarRead,
  RadarStreamStatus,
  SqueezeLevel,
  SocketStatus,
} from "@/lib/radar/types";
import { detectClosedCandleSignals, baselineVolume, type WickSignal } from "@/lib/signals/wickSignal";
import { readFlow } from "@/lib/wick/engines";
import { readVwap } from "@/lib/wick/levels";
import type { Kline, MarkTick, OiPoint, VwapRead } from "@/lib/wick/types";
import { TRACKED_SYMBOLS } from "@/lib/wick/universe";
import { loadState, saveState } from "@/lib/storage";
import { useWick } from "@/store/WickProvider";

const EMPTY_SOCKET: SocketStatus = { state: "idle", streams: 0, retries: 0, messages: 0 };
const EMPTY_STATUS: RadarStreamStatus = { ...EMPTY_SOCKET, routes: { public: EMPTY_SOCKET, market: EMPTY_SOCKET } };

/** Publish cadence for the UI snapshot. */
const PUBLISH_MS = 500;
/** Raw prints kept per instrument. */
const RAW_TRADES = 600;
const WHALES_KEPT = 40;
const LIQS_KEPT = 500;
const BARS_1H = 400;
const BARS_5M = 300;
/** Open-interest REST windows. */
const OI_HIST_MS = 60_000;
const OI_LIVE_MS = 20_000;
const OI_SCHEDULER_MS = 4_000;
/** Squeeze-history sampling: a snapshot every 30 s, 24 h kept. */
const SQ_SAMPLE_MS = 30_000;
const SQ_KEEP = 2 * 24 * 120;
const SQ_PERSIST_MS = 5 * 60_000;

export interface SqueezeSample {
  at: number;
  level: SqueezeLevel;
  volume: number;
  shortLiq: number;
  longLiq: number;
  direction: "short-squeeze" | "long-flush" | "mixed" | "none";
}

export interface InstrumentRead extends RadarRead {
  /** 30-second squeeze snapshots, oldest first. */
  squeezeHistory: SqueezeSample[];
  /** Open time of the newest 1h / 5m bar seen on the kline sockets. */
  lastKline1h?: number;
  lastKline5m?: number;
}

interface InstrumentBook {
  symbol: string;
  snapshot?: import("@/lib/wick/types").BookSnapshot;
  prevWalls?: { walls: import("@/lib/wick/types").Wall[]; mid: number };
  trades: import("@/lib/wick/types").AggTrade[];
  whales: import("@/lib/wick/types").AggTrade[];
  buckets: Map<number, MinuteBucket>;
  whaleAt: number;
  liqs: LiquidationEvent[];
  mark?: MarkTick;
  bars1h: ChartBar[];
  bars5m: ChartBar[];
  oiHist: OiPoint[];
  oiLive?: OiPoint;
  oiHistAt: number;
  oiLiveAt: number;
  oiBusy: boolean;
  lastDepthAt?: number;
  lastTradeAt?: number;
  /** Weighted bid share from the last publish, for signal context. */
  lastBidShare?: number;
  /** 1H bar open times whose wicks are already recorded. */
  processed: Set<string>;
  squeezeHistory: SqueezeSample[];
  vwap?: VwapRead;
}

function newBook(symbol: string): InstrumentBook {
  return {
    symbol,
    trades: [],
    whales: [],
    buckets: new Map(),
    whaleAt: 1000,
    liqs: [],
    bars1h: [],
    bars5m: [],
    oiHist: [],
    oiHistAt: 0,
    oiLiveAt: 0,
    oiBusy: false,
    processed: new Set(),
    squeezeHistory: [],
  };
}

interface InstrumentsValue {
  status: RadarStreamStatus;
  /** Live read for each instrument, keyed by symbol. */
  reads: Map<string, InstrumentRead>;
  /** Closed-1H wick signals, newest first, persisted across sessions. */
  signals: WickSignal[];
  /** Session VWAP read per instrument, when 5m bars are in. */
  vwap: Map<string, VwapRead | undefined>;
  now: number;
}

const InstrumentsContext = createContext<InstrumentsValue | null>(null);

const SIGNALS_KEY = "wick-signals-v2";
const SIGNALS_MAX = 1000;
const SQ_KEY = "squeeze-history-v2";

function loadSignals(): WickSignal[] {
  const raw = loadState<WickSignal[]>(SIGNALS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s.id === "string" && typeof s.symbol === "string").slice(0, SIGNALS_MAX);
}

function loadSqueezeHistory(): Map<string, SqueezeSample[]> {
  const raw = loadState<Record<string, SqueezeSample[]>>(SQ_KEY, {});
  const out = new Map<string, SqueezeSample[]>();
  if (raw && typeof raw === "object") {
    for (const [symbol, rows] of Object.entries(raw)) {
      if (Array.isArray(rows)) out.set(symbol, rows.slice(-SQ_KEEP));
    }
  }
  return out;
}

function toKline(b: ChartBar): Kline {
  return {
    openTime: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    quoteVolume: b.quoteVolume,
    trades: 0,
  };
}

export function InstrumentsProvider({ children }: { children: ReactNode }) {
  const { bySymbol, ready } = useWick();
  const [status, setStatus] = useState<RadarStreamStatus>(EMPTY_STATUS);
  const [reads, setReads] = useState<Map<string, InstrumentRead>>(new Map());
  const [signals, setSignals] = useState<WickSignal[]>(() => loadSignals());
  const [vwap, setVwap] = useState<Map<string, VwapRead | undefined>>(new Map());
  const [now, setNow] = useState<number>(() => Date.now());

  const booksRef = useRef<Map<string, InstrumentBook>>(new Map());
  const streamRef = useRef<RadarStream | null>(null);
  const signalsRef = useRef<WickSignal[]>(signals);
  const seenRef = useRef<Set<string>>(new Set(signals.map((s) => s.id)));
  const sqHistRef = useRef<Map<string, SqueezeSample[]>>(loadSqueezeHistory());
  const bySymbolRef = useRef(bySymbol);

  useEffect(() => {
    bySymbolRef.current = bySymbol;
  }, [bySymbol]);

  const recordSignals = useCallback((incoming: WickSignal[]) => {
    if (!incoming.length) return;
    const fresh = incoming.filter((s) => !seenRef.current.has(s.id));
    if (!fresh.length) return;
    for (const s of fresh) seenRef.current.add(s.id);
    const next = [...fresh, ...signalsRef.current].slice(0, SIGNALS_MAX);
    signalsRef.current = next;
    setSignals(next);
    saveState(SIGNALS_KEY, next);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Socket ingest                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    for (const symbol of TRACKED_SYMBOLS) if (!booksRef.current.has(symbol)) booksRef.current.set(symbol, newBook(symbol));

    const stream = new RadarStream({
      onDepth: (symbol, snapshot) => {
        const book = booksRef.current.get(symbol);
        if (!book) return;
        book.snapshot = snapshot;
        book.lastDepthAt = snapshot.at;
      },
      onTrade: (symbol, trade) => {
        const book = booksRef.current.get(symbol);
        if (!book) return;
        book.trades.push(trade);
        if (book.trades.length > RAW_TRADES) book.trades.splice(0, book.trades.length - RAW_TRADES);
        foldTrade(book.buckets, trade, book.whaleAt);
        if (trade.notional >= book.whaleAt) {
          book.whales.push(trade);
          if (book.whales.length > WHALES_KEPT) book.whales.splice(0, book.whales.length - WHALES_KEPT);
        }
        book.lastTradeAt = trade.at;
      },
      onLiquidation: (event) => {
        const book = booksRef.current.get(event.symbol);
        if (!book) return;
        book.liqs.push(event);
        if (book.liqs.length > LIQS_KEPT) book.liqs.splice(0, book.liqs.length - LIQS_KEPT);
      },
      onMark: (mark) => {
        const book = booksRef.current.get(mark.symbol);
        if (book) book.mark = mark;
      },
      onKline: (symbol, interval, bar) => {
        const book = booksRef.current.get(symbol);
        if (!book) return;
        if (interval === "1h") {
          const bars = book.bars1h;
          const last = bars[bars.length - 1];
          if (last && last.time === bar.time) bars[bars.length - 1] = bar;
          else if (!last || bar.time > last.time) {
            bars.push(bar);
            if (bars.length > BARS_1H) bars.splice(0, bars.length - BARS_1H);
          }
          // Close-confirm: a signal exists only when the 1H candle has closed,
          // and only once — the processed set makes re-delivery harmless.
          if (bar.closed && !book.processed.has(`${bar.time}:done`)) {
            book.processed.add(`${bar.time}:done`);
            const macro = bySymbolRef.current.get(symbol);
            const idx = bars.findIndex((b) => b.time === bar.time);
            const context = {
              high24h: macro?.high24h,
              low24h: macro?.low24h,
              vwap24h: book.vwap?.vwap,
              mark: book.mark,
              weightedBidShare: book.lastBidShare,
              walls: [...(book.prevWalls?.walls ?? [])],
              liquidationNotional: book.liqs.reduce((sum, l) => sum + l.notional, 0),
              liquidationCount: book.liqs.length,
            };
            const detected = detectClosedCandleSignals(symbol, bar, bars[idx - 1], baselineVolume(bars, idx), context);
            recordSignals(detected);
          }
        } else if (interval === "5m") {
          const bars = book.bars5m;
          const last = bars[bars.length - 1];
          if (last && last.time === bar.time) bars[bars.length - 1] = bar;
          else if (!last || bar.time > last.time) {
            bars.push(bar);
            if (bars.length > BARS_5M) bars.splice(0, bars.length - BARS_5M);
          }
          book.vwap = readVwap(bars.map(toKline), bar.close);
          setVwap((prev) => new Map(prev).set(symbol, book.vwap));
        }
      },
      onStatus: (next) => setStatus(next),
    });
    streamRef.current = stream;

    const wanted: string[] = [];
    for (const symbol of TRACKED_SYMBOLS) {
      wanted.push(...microStreams(symbol));
      wanted.push(klineStream(symbol, "1h"));
      wanted.push(klineStream(symbol, "5m"));
    }
    wanted.push(LIQUIDATION_STREAM);
    stream.setStreams(wanted);

    return () => {
      stream.stop();
      streamRef.current = null;
    };
  }, [ready, recordSignals]);

  /* ---------------------------------------------------------------- */
  /* REST seeds: 1H history, OI                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    for (const symbol of TRACKED_SYMBOLS) {
      const book = booksRef.current.get(symbol);
      if (!book || book.bars1h.length) continue;
      void fetchChartBars(symbol, "1h", BARS_1H)
        .then((bars) => {
          if (cancelled) return;
          const live = booksRef.current.get(symbol);
          if (!live) return;
          if (live.bars1h.length && bars.length && live.bars1h[live.bars1h.length - 1].time >= bars[bars.length - 1].time) {
            return;
          }
          live.bars1h = bars;
          // Seed the monitor with history the stored set has never seen.
          for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            if (!bar.closed) continue;
            const key = `${bar.time}:done`;
            if (live.processed.has(key)) continue;
            live.processed.add(key);
            const context = { high24h: undefined, low24h: undefined, walls: [] };
            const detected = detectClosedCandleSignals(
              symbol,
              bar,
              bars[i - 1],
              baselineVolume(bars, i),
              context,
            );
            recordSignals(detected);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [ready, recordSignals]);

  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      const at = Date.now();
      let launched = 0;
      for (const book of booksRef.current.values()) {
        if (launched >= 2) break;
        if (book.oiBusy) continue;
        if (at - book.oiHistAt >= OI_HIST_MS) {
          book.oiBusy = true;
          launched += 1;
          void fetchOiHistory(book.symbol, 288)
            .then((points) => {
              if (points.length) book.oiHist = points;
            })
            .catch(() => undefined)
            .finally(() => {
              book.oiHistAt = Date.now();
              book.oiBusy = false;
            });
        } else if (at - book.oiLiveAt >= OI_LIVE_MS) {
          book.oiBusy = true;
          launched += 1;
          void fetchOiLive(book.symbol)
            .then((point) => {
              if (point) book.oiLive = point;
            })
            .catch(() => undefined)
            .finally(() => {
              book.oiLiveAt = Date.now();
              book.oiBusy = false;
            });
        }
      }
    };
    const timer = window.setInterval(tick, OI_SCHEDULER_MS);
    tick();
    return () => window.clearInterval(timer);
  }, [ready]);

  /* ---------------------------------------------------------------- */
  /* Squeeze-history sampling + persistence                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    const sample = () => {
      const at = Date.now();
      for (const book of booksRef.current.values()) {
        const macro = bySymbolRef.current.get(book.symbol);
        const squeeze = readSqueeze(book.liqs, macro?.quoteVolume ?? 0, at);
        const hist = sqHistRef.current.get(book.symbol) ?? [];
        const last = hist[hist.length - 1];
        if (last && at - last.at < SQ_SAMPLE_MS - 1000) continue;
        hist.push({
          at,
          level: squeeze.level,
          volume: squeeze.volume,
          shortLiq: squeeze.shortLiq,
          longLiq: squeeze.longLiq,
          direction: squeeze.direction,
        });
        if (hist.length > SQ_KEEP) hist.splice(0, hist.length - SQ_KEEP);
        sqHistRef.current.set(book.symbol, hist);
      }
    };
    const persist = () => {
      const out: Record<string, SqueezeSample[]> = {};
      for (const [symbol, rows] of sqHistRef.current) out[symbol] = rows.slice(-24 * 120);
      saveState(SQ_KEY, out);
    };
    const sampler = window.setInterval(sample, SQ_SAMPLE_MS);
    const saver = window.setInterval(persist, SQ_PERSIST_MS);
    sample();
    return () => {
      window.clearInterval(sampler);
      window.clearInterval(saver);
    };
  }, [ready]);

  /* ---------------------------------------------------------------- */
  /* Publish                                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    let wasEmpty = false;
    const publish = () => {
      const at = Date.now();
      const next = new Map<string, InstrumentRead>();
      if (booksRef.current.size === 0) {
        if (!wasEmpty) {
          wasEmpty = true;
          setReads(next);
          setNow(at);
        }
        return;
      }
      wasEmpty = false;
      for (const book of booksRef.current.values()) {
        pruneBuckets(book.buckets, at);
        if (book.liqs.length && book.liqs[0].at < at - RADAR_WINDOW_MS) {
          book.liqs = book.liqs.filter((l) => l.at >= at - RADAR_WINDOW_MS);
        }
        const macro = bySymbolRef.current.get(book.symbol);
        const quoteVolume = macro?.quoteVolume ?? 0;
        book.whaleAt = whaleThreshold(book.trades, quoteVolume);
        const walls = readWalls(book.snapshot, book.prevWalls);
        if (book.snapshot && walls.book.mid) book.prevWalls = { walls: walls.book.walls, mid: walls.book.mid };
        const depth = readDepth(book.snapshot, walls.book.walls);
        book.lastBidShare = depth.weightedBidShare;
        const lastTrade = book.trades[book.trades.length - 1];
        const price = depth.mid ?? lastTrade?.price ?? macro?.price ?? 0;
        const squeeze = readSqueeze(book.liqs, quoteVolume, at);

        next.set(book.symbol, {
          symbol: book.symbol,
          state: "watch",
          attachedAt: at,
          gates: 0,
          depth,
          book: walls.book,
          bidWalls: walls.bid,
          askWalls: walls.ask,
          flow: readFlowWindow(book.buckets, at),
          recent: readFlow(book.trades, book.whaleAt),
          trades: book.trades.slice(-100).reverse(),
          whales: book.whales.slice().reverse(),
          whaleAt: book.whaleAt,
          squeeze,
          liquidations: book.liqs.slice(-50).reverse(),
          clusters: liquidationClusters(book.liqs, price, at),
          oi: readOiTrend(book.oiHist, book.oiLive, price, priceChangeOver(book.buckets, at, 15) ?? 0),
          oiPolledAt: Math.max(book.oiHistAt, book.oiLiveAt) || undefined,
          mark: book.mark,
          lastDepthAt: book.lastDepthAt,
          lastTradeAt: book.lastTradeAt,
          lastKline1h: book.bars1h[book.bars1h.length - 1]?.time,
          lastKline5m: book.bars5m[book.bars5m.length - 1]?.time,
          squeezeHistory: sqHistRef.current.get(book.symbol) ?? [],
        });
      }
      setReads(next);
      setNow(at);
    };
    const timer = window.setInterval(publish, PUBLISH_MS);
    return () => window.clearInterval(timer);
  }, [ready]);

  const value = useMemo<InstrumentsValue>(
    () => ({ status, reads, signals, vwap, now }),
    [status, reads, signals, vwap, now],
  );

  return <InstrumentsContext.Provider value={value}>{children}</InstrumentsContext.Provider>;
}

export function useInstruments(): InstrumentsValue {
  const ctx = useContext(InstrumentsContext);
  if (!ctx) throw new Error("useInstruments must be used inside InstrumentsProvider");
  return ctx;
}
