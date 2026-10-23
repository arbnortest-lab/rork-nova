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
import { klineStream, LIQUIDATION_STREAM, microStreams, RadarStream } from "@/lib/radar/stream";
import type {
  ChartBar,
  ChartInterval,
  LiquidationEvent,
  RadarChart,
  RadarRead,
  RadarState,
  RadarStreamStatus,
  SocketStatus,
} from "@/lib/radar/types";
import { readFlow } from "@/lib/wick/engines";
import type { AggTrade, BookSnapshot, MarkTick, OiPoint, Wall } from "@/lib/wick/types";
import { loadState, saveState } from "@/lib/storage";
import { useWick } from "@/store/WickProvider";

const PREFS_KEY = "radar-prefs";

/** Gates passed at which the micro layer attaches. */
export const RADAR_ARM_AT = 3;
/**
 * A contract that drops below the arming line keeps its streams this long, so
 * one hovering on the threshold does not churn subscriptions.
 */
export const RADAR_GRACE_MS = 2 * 60_000;
/** Snapshot cadence for the UI. The socket runs far faster; the page does not need to. */
const PUBLISH_MS = 250;
const OI_HIST_MS = 60_000;
const OI_LIVE_MS = 20_000;
const OI_SCHEDULER_MS = 4_000;
/** Raw prints kept per contract for the tape and the short-window flow read. */
const RAW_TRADES = 600;
const WHALES_KEPT = 40;
const LIQS_KEPT = 500;
const CHART_BARS = 300;
const CHART_BARS_MAX = 420;

export interface RadarPrefs {
  enabled: boolean;
  interval: ChartInterval;
  holds: string[];
}

const DEFAULT_PREFS: RadarPrefs = { enabled: true, interval: "5m", holds: [] };

const EMPTY_SOCKET: SocketStatus = { state: "idle", streams: 0, retries: 0, messages: 0 };
const EMPTY_STATUS: RadarStreamStatus = { ...EMPTY_SOCKET, routes: { public: EMPTY_SOCKET, market: EMPTY_SOCKET } };

interface MicroBook {
  symbol: string;
  state: RadarState;
  gates: number;
  attachedAt: number;
  /** Last pass on which the contract was at or above the arming line. */
  armedAt: number;
  snapshot?: BookSnapshot;
  prevWalls?: { walls: Wall[]; mid: number };
  trades: AggTrade[];
  whales: AggTrade[];
  buckets: Map<number, MinuteBucket>;
  whaleAt: number;
  liqs: LiquidationEvent[];
  mark?: MarkTick;
  oiHist: OiPoint[];
  oiLive?: OiPoint;
  oiHistAt: number;
  oiLiveAt: number;
  oiBusy: boolean;
  lastDepthAt?: number;
  lastTradeAt?: number;
}

/**
 * A fresh book. The whale line starts from the contract's 24h turnover rather
 * than the $1,000 floor, so prints that land before the first publish tick
 * are judged on the right scale.
 */
function newBook(symbol: string, state: RadarState, gates: number, now: number, quoteVolume24h: number): MicroBook {
  return {
    symbol,
    state,
    gates,
    attachedAt: now,
    armedAt: state === "watch" ? 0 : now,
    trades: [],
    whales: [],
    buckets: new Map(),
    whaleAt: whaleThreshold([], quoteVolume24h),
    liqs: [],
    oiHist: [],
    oiHistAt: 0,
    oiLiveAt: 0,
    oiBusy: false,
  };
}

interface RadarValue {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Every contract with streams attached, keyed by symbol. */
  reads: Map<string, RadarRead>;
  /** Armed contracts only (3 of 4 or better), strongest first. */
  armed: RadarRead[];
  /** The focused contract's read, when it has streams attached. */
  focus: RadarRead | undefined;
  status: RadarStreamStatus;
  /** Streams the socket is asked to carry right now. */
  streams: string[];
  holds: string[];
  toggleHold: (symbol: string) => void;
  chart: RadarChart;
  interval: ChartInterval;
  setInterval: (interval: ChartInterval) => void;
  /** Snapshot clock, for age readouts. */
  now: number;
}

const RadarContext = createContext<RadarValue | null>(null);

function sanitizePrefs(raw: unknown): RadarPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_PREFS };
  const r = raw as Partial<RadarPrefs>;
  const interval: ChartInterval =
    r.interval === "1m" || r.interval === "5m" || r.interval === "15m" || r.interval === "1h" ? r.interval : "5m";
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    interval,
    holds: Array.isArray(r.holds) ? r.holds.filter((s): s is string => typeof s === "string").slice(0, 12) : [],
  };
}

/**
 * The micro layer. Watches the macro scanner's output and attaches live
 * depth, trades, mark price and liquidation streams to every contract that
 * reaches the arming line — plus the one in focus and any the trader holds —
 * and detaches them again when it falls away. Reads nothing into the macro
 * engine: the four gates never see what happens here.
 */
export function RadarProvider({ children }: { children: ReactNode }) {
  const { reads: macroReads, bySymbol, prefs: wickPrefs, ready } = useWick();
  const [prefs, setPrefs] = useState<RadarPrefs>(() => sanitizePrefs(loadState<unknown>(PREFS_KEY, null)));
  const [reads, setReads] = useState<Map<string, RadarRead>>(new Map());
  const [status, setStatus] = useState<RadarStreamStatus>(EMPTY_STATUS);
  const [streams, setStreams] = useState<string[]>([]);
  const [chart, setChart] = useState<RadarChart>({
    symbol: "",
    interval: "5m",
    bars: [],
    loadedAt: 0,
    loading: false,
  });
  const [now, setNow] = useState<number>(() => Date.now());

  const booksRef = useRef<Map<string, MicroBook>>(new Map());
  const streamRef = useRef<RadarStream | null>(null);
  const chartKeyRef = useRef<string>("");
  const barsRef = useRef<ChartBar[]>([]);
  const chartDirtyRef = useRef<boolean>(false);
  const chartLoadRef = useRef<number>(0);
  const bySymbolRef = useRef(bySymbol);

  useEffect(() => {
    bySymbolRef.current = bySymbol;
  }, [bySymbol]);

  const patchPrefs = useCallback((patch: Partial<RadarPrefs> | ((prev: RadarPrefs) => Partial<RadarPrefs>)) => {
    setPrefs((prev) => {
      const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
      saveState(PREFS_KEY, next);
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Stream ingestion — mutates the per-contract books, publishes later */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
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
        // One venue-wide stream; only armed contracts keep their rows.
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
        if (`${symbol}:${interval}` !== chartKeyRef.current) return;
        const bars = barsRef.current;
        const last = bars[bars.length - 1];
        if (last && last.time === bar.time) bars[bars.length - 1] = bar;
        else if (!last || bar.time > last.time) {
          bars.push(bar);
          if (bars.length > CHART_BARS_MAX) bars.splice(0, bars.length - CHART_BARS_MAX);
        }
        chartDirtyRef.current = true;
      },
      onStatus: (next) => setStatus(next),
    });
    streamRef.current = stream;
    return () => {
      stream.stop();
      streamRef.current = null;
    };
  }, [ready]);

  /* ---------------------------------------------------------------- */
  /* Attach / detach                                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !ready) return;
    const books = booksRef.current;
    const at = Date.now();

    if (!prefs.enabled || wickPrefs.paused) {
      books.clear();
      stream.setStreams([]);
      setStreams([]);
      return;
    }

    // Wanted: armed contracts, the focused one, held ones, and anything still
    // inside its grace period.
    const wanted = new Map<string, { state: RadarState; gates: number; armed: boolean }>();
    for (const r of macroReads) {
      if (r.passedCount >= RADAR_ARM_AT) {
        wanted.set(r.symbol, { state: r.armed ? "signal" : "armed", gates: r.passedCount, armed: true });
      }
    }
    const gatesOf = (symbol: string) => bySymbol.get(symbol)?.passedCount ?? 0;
    const focus = wickPrefs.selected;
    if (focus && !wanted.has(focus)) wanted.set(focus, { state: "watch", gates: gatesOf(focus), armed: false });
    for (const h of prefs.holds) if (!wanted.has(h)) wanted.set(h, { state: "watch", gates: gatesOf(h), armed: false });
    for (const [symbol, book] of books) {
      if (wanted.has(symbol)) continue;
      if (book.armedAt && at - book.armedAt < RADAR_GRACE_MS) {
        wanted.set(symbol, { state: "watch", gates: gatesOf(symbol), armed: false });
      }
    }

    for (const symbol of [...books.keys()]) if (!wanted.has(symbol)) books.delete(symbol);
    for (const [symbol, w] of wanted) {
      const book = books.get(symbol);
      if (book) {
        book.state = w.state;
        book.gates = w.gates;
        if (w.armed) book.armedAt = at;
      } else {
        books.set(symbol, newBook(symbol, w.state, w.gates, at, bySymbol.get(symbol)?.quoteVolume ?? 0));
      }
    }

    const next: string[] = [];
    for (const symbol of books.keys()) next.push(...microStreams(symbol));
    if (books.size) next.push(LIQUIDATION_STREAM);
    if (focus && books.has(focus)) next.push(klineStream(focus, prefs.interval));
    stream.setStreams(next);
    setStreams(stream.wantedStreams());
  }, [macroReads, bySymbol, wickPrefs.selected, wickPrefs.paused, prefs.enabled, prefs.holds, prefs.interval, ready]);

  /* ---------------------------------------------------------------- */
  /* Chart history                                                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const symbol = wickPrefs.selected;
    const interval = prefs.interval;
    const key = `${symbol}:${interval}`;
    if (!ready) return;
    if (!symbol || !prefs.enabled) {
      // Forget the key so re-enabling reloads history instead of trusting stale bars.
      chartKeyRef.current = "";
      barsRef.current = [];
      return;
    }
    if (chartKeyRef.current === key) return;
    chartKeyRef.current = key;
    barsRef.current = [];
    const token = ++chartLoadRef.current;
    setChart({ symbol, interval, bars: [], loadedAt: 0, loading: true });

    void fetchChartBars(symbol, interval, CHART_BARS)
      .then((bars) => {
        if (chartLoadRef.current !== token) return;
        // Live bars may have landed while history was in flight; keep the newest.
        const live = barsRef.current;
        const merged = bars.slice();
        for (const b of live) {
          const last = merged[merged.length - 1];
          if (last && last.time === b.time) merged[merged.length - 1] = b;
          else if (!last || b.time > last.time) merged.push(b);
        }
        barsRef.current = merged;
        setChart({ symbol, interval, bars: merged.slice(), loadedAt: Date.now(), loading: false });
      })
      .catch((err: unknown) => {
        if (chartLoadRef.current !== token) return;
        setChart({
          symbol,
          interval,
          bars: barsRef.current.slice(),
          loadedAt: 0,
          loading: false,
          error: err instanceof Error ? err.message : "failed",
        });
      });
  }, [wickPrefs.selected, prefs.interval, prefs.enabled, ready]);

  /* ---------------------------------------------------------------- */
  /* Open interest polling                                              */
  /* ---------------------------------------------------------------- */

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
          void fetchOiHistory(book.symbol)
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
  /* Publish                                                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    let wasEmpty = false;
    const publish = () => {
      const at = Date.now();
      const next = new Map<string, RadarRead>();
      if (booksRef.current.size === 0) {
        // Nothing attached: publish the empty map once, then stay quiet.
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
        book.whaleAt = whaleThreshold(book.trades, macro?.quoteVolume ?? 0);
        const walls = readWalls(book.snapshot, book.prevWalls);
        if (book.snapshot && walls.book.mid) book.prevWalls = { walls: walls.book.walls, mid: walls.book.mid };
        const depth = readDepth(book.snapshot, walls.book.walls);
        const lastTrade = book.trades[book.trades.length - 1];
        const price = depth.mid ?? lastTrade?.price ?? macro?.price ?? 0;
        const quoteVolume = macro?.quoteVolume ?? 0;

        next.set(book.symbol, {
          symbol: book.symbol,
          state: book.state,
          attachedAt: book.attachedAt,
          gates: book.gates,
          depth,
          book: walls.book,
          bidWalls: walls.bid,
          askWalls: walls.ask,
          flow: readFlowWindow(book.buckets, at),
          recent: readFlow(book.trades, book.whaleAt),
          trades: book.trades.slice(-100).reverse(),
          whales: book.whales.slice().reverse(),
          whaleAt: book.whaleAt,
          squeeze: readSqueeze(book.liqs, quoteVolume, at),
          liquidations: book.liqs.slice(-50).reverse(),
          clusters: liquidationClusters(book.liqs, price, at),
          oi: readOiTrend(book.oiHist, book.oiLive, price, priceChangeOver(book.buckets, at, 15) ?? 0),
          oiPolledAt: Math.max(book.oiHistAt, book.oiLiveAt) || undefined,
          mark: book.mark,
          lastDepthAt: book.lastDepthAt,
          lastTradeAt: book.lastTradeAt,
        });
      }
      setReads(next);
      setNow(at);
      if (chartDirtyRef.current) {
        chartDirtyRef.current = false;
        setChart((prev) => (prev.loading ? prev : { ...prev, bars: barsRef.current.slice() }));
      }
    };
    const timer = window.setInterval(publish, PUBLISH_MS);
    return () => window.clearInterval(timer);
  }, [ready]);

  /* ---------------------------------------------------------------- */
  /* Mutators + value                                                   */
  /* ---------------------------------------------------------------- */

  const setEnabled = useCallback((on: boolean) => patchPrefs({ enabled: on }), [patchPrefs]);
  const setInterval = useCallback((interval: ChartInterval) => patchPrefs({ interval }), [patchPrefs]);
  const toggleHold = useCallback(
    (symbol: string) => {
      patchPrefs((prev) => ({
        holds: prev.holds.includes(symbol) ? prev.holds.filter((s) => s !== symbol) : [...prev.holds, symbol].slice(-12),
      }));
    },
    [patchPrefs],
  );

  const armed = useMemo(() => {
    const rows = [...reads.values()].filter((r) => r.state !== "watch");
    rows.sort(
      (a, b) =>
        Number(b.state === "signal") - Number(a.state === "signal") ||
        b.gates - a.gates ||
        b.squeeze.volume - a.squeeze.volume ||
        a.attachedAt - b.attachedAt,
    );
    return rows;
  }, [reads]);

  const focus = useMemo(() => reads.get(wickPrefs.selected), [reads, wickPrefs.selected]);

  const value = useMemo<RadarValue>(
    () => ({
      enabled: prefs.enabled,
      setEnabled,
      reads,
      armed,
      focus,
      status,
      streams,
      holds: prefs.holds,
      toggleHold,
      chart,
      interval: prefs.interval,
      setInterval,
      now,
    }),
    [prefs.enabled, prefs.holds, prefs.interval, setEnabled, reads, armed, focus, status, streams, toggleHold, chart, setInterval, now],
  );

  return <RadarContext.Provider value={value}>{children}</RadarContext.Provider>;
}

export function useRadar(): RadarValue {
  const ctx = useContext(RadarContext);
  if (!ctx) throw new Error("useRadar must be used inside RadarProvider");
  return ctx;
}
