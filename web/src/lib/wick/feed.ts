/**
 * Binance USDⓈ-M Futures transport for the Wick Detection Engine.
 *
 * This module talks to Binance Futures and nothing else — no aggregators, no
 * other venues. If the venue is unreachable the engine reports a blocked state
 * rather than silently substituting a different data source.
 *
 * Socket (tier 1 — breadth)
 *   market : wss://fstream.binance.com/market/stream — `!ticker@arr` + `!markPrice@arr@1s`
 *            Two all-market arrays on one connection cover every contract, so
 *            tier 1 costs exactly one socket regardless of universe size.
 *            The `/market` route is mandatory: since the venue split its
 *            futures socket (March 2026) an unrouted `/stream` connection only
 *            carries the `/public` book streams and silently drops these two.
 *
 * REST (tier 2 — depth, cached)
 *   /fapi/v1/exchangeInfo — universe, contract type, status
 *   /fapi/v1/ticker/24hr  — tier-1 snapshot when the socket is down
 *   /fapi/v1/premiumIndex — mark/index price and funding for the whole board
 *   /fapi/v1/klines       — 5m and 1d bars, the only inputs the four gates read
 *
 * The exhaustion model reads klines and rolling stats and nothing else, so
 * tier 2 needs no second socket: there is no aggregate-trade or depth
 * subscription to reconcile. Contracts leaving the watch set stop being
 * refreshed and, from that moment, stop being served: their history gates
 * read as unmeasured instead of scoring candles that no longer move.
 *
 * The market socket reconnects with exponential backoff and jitter, cycling
 * through endpoint shapes, so one rejected URL form never ends the scan.
 *
 * REST safety net
 *   `fstream.binance.com` (sockets) and `fapi.binance.com` (REST) are different
 *   hostnames and fail independently: filtered DNS/SNI, a proxy that mangles the
 *   combined-stream query string, or a corporate egress rule can kill the stream
 *   while HTTPS still answers. So tier 1 also has a polling path over the exact
 *   same venue and the exact same fields, and it runs from boot until the socket
 *   proves itself. The socket is the fast path, never the only path.
 */

import type {
  FeedStatus,
  Kline,
  MarkTick,
  SocketState,
  TickerTick,
  Transport,
  TransportMode,
} from "./types";
import type { VolumeSample } from "./engines";

const REST = "https://fapi.binance.com";

interface MarketEndpoint {
  label: string;
  url: string;
  /** False for endpoints that carry tickers only, leaving marks to the poll. */
  marks: boolean;
}

/**
 * Tier-1 socket shapes, tried in order across consecutive attempts. They fail
 * independently in the wild: middleboxes rewrite `!`/`@` in a query string, and
 * some networks block the combined endpoint while leaving raw streams open.
 */
const MARKET_ENDPOINTS: MarketEndpoint[] = [
  {
    label: "combined",
    url: "wss://fstream.binance.com/market/stream?streams=!ticker@arr/!markPrice@arr@1s",
    marks: true,
  },
  {
    label: "combined-encoded",
    url: "wss://fstream.binance.com/market/stream?streams=%21ticker%40arr/%21markPrice%40arr%401s",
    marks: true,
  },
  {
    label: "raw-ticker",
    url: "wss://fstream.binance.com/market/ws/!ticker@arr",
    marks: false,
  },
];

/**
 * A handshake that has produced no event by this point is being blackholed.
 * Browsers can sit in CONNECTING for 75s+ when packets are dropped, which reads
 * as "connecting forever" instead of a fault, so the engine times it out itself.
 */
const CONNECT_TIMEOUT_MS = 7_000;
/**
 * Failed attempts before a socket is declared blocked. One per endpoint shape:
 * if every shape has been refused, the network is filtering the stream host.
 */
const SOCKET_GIVE_UP = MARKET_ENDPOINTS.length;
/** Clock for the REST safety net. */
const FALLBACK_TICK_MS = 1_250;
/** Tier-1 poll cadence: 50 weight per cycle against a 2400/min budget. */
const REST_POLL_MS = 4_000;
/** Once blocked, retry the socket on this clock in case the block lifts. */
const SOCKET_PROBE_MS = 90_000;

const MAX_VOL_SAMPLES = 24;
const KLINE_TTL_MS = 25_000;
/**
 * Oldest 5m series the scanner will score.
 *
 * Refreshes keep a watched series under about a minute old, including in a
 * background tab where browsers may fire timers only once a minute, so this
 * tolerates at least one failed refresh. Past it the newest bars no longer
 * describe the market: a bar frozen mid-rejection would keep gate 3 passing,
 * and its frozen volume would hold gate 2 on an old reading.
 */
export const KLINE_MAX_AGE_MS = 150_000;
const DAILY_TTL_MS = 30 * 60_000;
/** Oldest daily series the scanner will score: one missed refresh window. */
export const DAILY_MAX_AGE_MS = 2 * DAILY_TTL_MS;
const DAY_MS = 86_400_000;
/**
 * Daily bars fetched per contract.
 *
 * Must cover the widest `horizonDays` the rules allow (365) plus the
 * in-progress day that gate 4 discards. Fetching fewer silently collapses
 * every horizon setting onto the same short window: at limit=70 a "1-year
 * high" was really a 70-day high, so the strictest gate was the easiest to
 * pass. Binance caps klines at 1500 per request, so this is one call.
 */
const DAILY_LIMIT = 400;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** True when both times fall on the same UTC day, the day Binance's daily bars use. */
function sameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / DAY_MS) === Math.floor(b / DAY_MS);
}

/** True while a 5m series fetched at `at` is still recent enough to score at `now`. */
function klineFresh(at: number, now: number): boolean {
  return now - at <= KLINE_MAX_AGE_MS;
}

/**
 * True while a daily series fetched at `at` still reads correctly at `now`.
 *
 * Age alone is not enough. When 00:00 UTC passes, the bar that was still in
 * progress at the fetch becomes a completed day to gate 4, which would then
 * read its high as final while missing everything traded after the fetch.
 */
function dailyFresh(at: number, now: number): boolean {
  return now - at <= DAILY_MAX_AGE_MS && sameUtcDay(at, now);
}

/* ------------------------------------------------------------------ */
/* Payload normalisers                                                 */
/*                                                                     */
/* The stream and the REST endpoints carry identical information under  */
/* different field names. Normalising at the edge means every engine    */
/* downstream is transport-agnostic.                                    */
/* ------------------------------------------------------------------ */

/** One row of `!ticker@arr`. */
function streamTicker(row: unknown, now: number): TickerTick | null {
  if (!isRecord(row)) return null;
  const symbol = typeof row.s === "string" ? row.s : "";
  if (!isUsdtPerp(symbol)) return null;
  const last = num(row.c);
  if (last <= 0) return null;
  return {
    symbol,
    last,
    open: num(row.o),
    high: num(row.h),
    low: num(row.l),
    vwap24h: num(row.w),
    quoteVolume: num(row.q),
    trades: num(row.n),
    at: num(row.E) || now,
  };
}

/** One row of `GET /fapi/v1/ticker/24hr` (no symbol filter). */
function restTicker(row: unknown, now: number): TickerTick | null {
  if (!isRecord(row)) return null;
  const symbol = typeof row.symbol === "string" ? row.symbol : "";
  if (!isUsdtPerp(symbol)) return null;
  const last = num(row.lastPrice);
  if (last <= 0) return null;
  return {
    symbol,
    last,
    open: num(row.openPrice),
    high: num(row.highPrice),
    low: num(row.lowPrice),
    vwap24h: num(row.weightedAvgPrice),
    quoteVolume: num(row.quoteVolume),
    trades: num(row.count),
    at: num(row.closeTime) || now,
  };
}

/** One row of `!markPrice@arr@1s`. `r` is a fraction: 0.0001 = 0.01%. */
function streamMark(row: unknown, now: number): MarkTick | null {
  if (!isRecord(row)) return null;
  const symbol = typeof row.s === "string" ? row.s : "";
  if (!isUsdtPerp(symbol)) return null;
  return {
    symbol,
    markPrice: num(row.p),
    indexPrice: num(row.i),
    fundingRate: num(row.r) * 100,
    nextFundingTime: num(row.T),
    at: num(row.E) || now,
  };
}

/** One row of `GET /fapi/v1/premiumIndex` (no symbol filter). */
function restMark(row: unknown, now: number): MarkTick | null {
  if (!isRecord(row)) return null;
  const symbol = typeof row.symbol === "string" ? row.symbol : "";
  if (!isUsdtPerp(symbol)) return null;
  return {
    symbol,
    markPrice: num(row.markPrice),
    indexPrice: num(row.indexPrice),
    fundingRate: num(row.lastFundingRate) * 100,
    nextFundingTime: num(row.nextFundingTime),
    at: num(row.time) || now,
  };
}

/** A USDT perpetual has no delivery suffix. `BTCUSDT_260925` is a dated contract. */
export function isUsdtPerp(symbol: string): boolean {
  return symbol.endsWith("USDT") && !symbol.includes("_");
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface WickFeedOptions {
  /** Called whenever the universe list changes, so the provider can re-rank. */
  onUniverse?: (symbols: string[]) => void;
  onStatus?: () => void;
  /**
   * Contracts whose kline history is always kept fresh, even while they sit
   * outside the ranked watch list. They never take a watch-list slot and are
   * not counted in `deepCount`, so the scanner's own selection is unchanged.
   */
  alwaysFresh?: string[];
}

export class WickFeed {
  /* --- live tier-1 state --- */
  readonly tickers = new Map<string, TickerTick>();
  readonly marks = new Map<string, MarkTick>();
  readonly volSamples = new Map<string, VolumeSample[]>();

  /* --- cached REST state (tier 2) --- */
  private klines5m = new Map<string, CacheEntry<Kline[]>>();
  private klinesDaily = new Map<string, CacheEntry<Kline[]>>();
  private inflight = new Set<string>();

  private universe: string[] = [];
  private deepSet: string[] = [];
  /**
   * Every contract whose history is refreshed and served: the watch list, the
   * focused contract and `alwaysFresh`. One set drives both, so the scanner is
   * never handed a series the refresh clock has stopped maintaining.
   */
  private tracked = new Set<string>();
  /** Symbols the current socket is actually subscribed to. */
  private deepSubscribed: string[] = [];

  private marketWs: WebSocket | null = null;
  private deepWs: WebSocket | null = null;
  private marketState: SocketState = "idle";
  private deepState: SocketState = "idle";
  private marketRetries = 0;
  private deepRetries = 0;
  private marketTimer: ReturnType<typeof setTimeout> | null = null;
  private deepTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickerAt: number | undefined;
  private lastMarkAt: number | undefined;
  private lastError: string | undefined;
  private restOk = true;
  private running = false;
  private lastVolSampleAt = 0;

  /* --- transport --- */
  private mode: TransportMode = "auto";
  private transport: Transport = "none";
  private endpointIndex = 0;
  private endpointLabel: string | undefined;
  private socketCarriesMarks = true;
  private marketConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private deepConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private connectStartedAt: number | undefined;
  private lastCloseCode: number | undefined;
  private handshakeTimeouts = 0;
  private lastPollStartedAt = 0;
  private lastPollAt: number | undefined;
  private pollFailures = 0;
  private lastDeepPollAt = 0;
  private restDeepSymbol: string | undefined;
  private focus = "";

  constructor(private readonly opts: WickFeedOptions = {}) {
    this.retrack();
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loadUniverse();
    if (this.mode !== "rest") this.openMarket();
    // The safety net runs from boot, so the first scores never wait on a socket.
    this.fallbackTimer = setInterval(() => this.fallbackTick(), FALLBACK_TICK_MS);
    this.fallbackTick();
    // History loads now rather than on the refresh clock. After a pause that is
    // the whole watch list, whose candles stopped updating while it was off.
    this.refreshDeep();
  }

  stop(): void {
    this.running = false;
    if (this.marketTimer) clearTimeout(this.marketTimer);
    if (this.deepTimer) clearTimeout(this.deepTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.clearConnectTimer("market");
    this.clearConnectTimer("deep");
    this.marketTimer = null;
    this.deepTimer = null;
    this.fallbackTimer = null;
    this.closeSocket(this.marketWs);
    this.closeSocket(this.deepWs);
    this.marketWs = null;
    this.deepWs = null;
    this.deepSubscribed = [];
    this.marketState = "idle";
    this.deepState = "idle";
    this.transport = "none";
    this.connectStartedAt = undefined;
    this.opts.onStatus?.();
  }

  private clearConnectTimer(kind: "market" | "deep"): void {
    const timer = kind === "market" ? this.marketConnectTimer : this.deepConnectTimer;
    if (timer) clearTimeout(timer);
    if (kind === "market") this.marketConnectTimer = null;
    else this.deepConnectTimer = null;
  }

  private closeSocket(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  status(): FeedStatus {
    return {
      market: this.marketState,
      deep: this.deepState,
      universe: this.universe.length,
      deepCount: this.deepSet.length,
      lastTickerAt: this.lastTickerAt,
      lastMarkAt: this.lastMarkAt,
      lastError: this.lastError,
      restOk: this.restOk,
      marketRetries: this.marketRetries,
      deepRetries: this.deepRetries,
      transport: this.transport,
      mode: this.mode,
      endpoint: this.endpointLabel,
      connectStartedAt: this.connectStartedAt,
      lastCloseCode: this.lastCloseCode,
      handshakeTimeouts: this.handshakeTimeouts,
      lastPollAt: this.lastPollAt,
      pollFailures: this.pollFailures,
      restDeepSymbol: this.restDeepSymbol,
    };
  }

  symbols(): string[] {
    return this.universe;
  }

  /* ------------------------------------------------------------------ */
  /* Transport controls                                                  */
  /* ------------------------------------------------------------------ */

  /** Restart the socket search from the first endpoint and poll immediately. */
  retryNow(): void {
    if (!this.running) return;
    if (this.marketTimer) clearTimeout(this.marketTimer);
    this.marketTimer = null;
    this.marketRetries = 0;
    this.deepRetries = 0;
    this.endpointIndex = 0;
    this.handshakeTimeouts = 0;
    this.pollFailures = 0;
    this.lastError = undefined;
    this.clearConnectTimer("market");
    this.closeSocket(this.marketWs);
    this.marketWs = null;
    void this.pollTier1({ force: true });
    if (this.mode !== "rest") this.openMarket();
    this.opts.onStatus?.();
  }

  /**
   * `rest` pins tier 1 to polling and stops socket attempts entirely — useful on
   * networks where the stream host is filtered and the retries are just noise.
   */
  setMode(mode: TransportMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "rest") {
      if (this.marketTimer) clearTimeout(this.marketTimer);
      this.marketTimer = null;
      this.clearConnectTimer("market");
      this.closeSocket(this.marketWs);
      this.marketWs = null;
      this.closeSocket(this.deepWs);
      this.deepWs = null;
      this.deepSubscribed = [];
      this.marketState = "idle";
      this.deepState = "idle";
      this.transport = this.lastPollAt ? "rest" : "none";
      void this.pollTier1({ force: true });
    } else {
      this.marketRetries = 0;
      this.endpointIndex = 0;
      if (this.running && !this.marketWs) this.openMarket();
    }
    this.opts.onStatus?.();
  }

  /**
   * The contract in the focus panel. Its history is refreshed and served even
   * without a watch-list slot, so the panel being read never scores frozen
   * candles.
   */
  setFocus(symbol: string): void {
    if (this.focus === symbol) return;
    this.focus = symbol;
    this.lastDeepPollAt = 0;
    this.retrack();
    // Outside the watch list it would otherwise wait for the refresh clock.
    if (symbol && this.running && !this.deepSet.includes(symbol)) void this.loadKlines(symbol);
  }

  /* ------------------------------------------------------------------ */
  /* REST                                                                */
  /* ------------------------------------------------------------------ */

  private async getJson<T>(path: string, timeoutMs = 12_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${REST}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Universe from `exchangeInfo`. If REST is blocked the tier-1 socket still
   * yields a usable list, so the engine degrades to "streams only" instead of
   * failing outright.
   */
  private async loadUniverse(): Promise<void> {
    try {
      const info = await this.getJson<{ symbols?: unknown[] }>("/fapi/v1/exchangeInfo");
      const rows = Array.isArray(info.symbols) ? info.symbols : [];
      const next: string[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const symbol = typeof row.symbol === "string" ? row.symbol : "";
        if (
          row.contractType === "PERPETUAL" &&
          row.status === "TRADING" &&
          row.quoteAsset === "USDT" &&
          isUsdtPerp(symbol)
        ) {
          next.push(symbol);
        }
      }
      if (next.length) {
        this.restOk = true;
        this.setUniverse(next);
        return;
      }
      this.restOk = false;
    } catch (err) {
      this.restOk = false;
      this.lastError = `exchangeInfo: ${err instanceof Error ? err.message : "failed"}`;
      this.opts.onStatus?.();
    }
  }

  private setUniverse(symbols: string[]): void {
    const sorted = [...new Set(symbols)].sort();
    if (sorted.length === this.universe.length && sorted.every((s, i) => s === this.universe[i])) return;
    this.universe = sorted;
    this.opts.onUniverse?.(sorted);
    this.opts.onStatus?.();
  }

  private static parseKlines(rows: unknown): Kline[] {
    if (!Array.isArray(rows)) return [];
    const out: Kline[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 9) continue;
      out.push({
        openTime: num(row[0]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
        quoteVolume: num(row[7]),
        trades: num(row[8]),
      });
    }
    return out;
  }

  /**
   * Loads 5m and daily history for one contract.
   *
   * `force` skips the freshness check, for an explicit user-driven refresh. The
   * in-flight guard is never skipped: it deduplicates concurrent requests for
   * the same slice rather than rate-limiting them, so bypassing it would just
   * fire duplicate requests for identical data.
   */
  private async loadKlines(symbol: string, force = false): Promise<void> {
    const now = Date.now();
    const fresh = this.klines5m.get(symbol);
    if (force || !fresh || now - fresh.at > KLINE_TTL_MS) {
      const key = `k5:${symbol}`;
      if (!this.inflight.has(key)) {
        this.inflight.add(key);
        try {
          const rows = await this.getJson<unknown>(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=500`);
          const parsed = WickFeed.parseKlines(rows);
          if (parsed.length) this.klines5m.set(symbol, { at: now, value: parsed });
        } catch {
          // Keep the last good series; `klines()` stops serving it once too old.
        } finally {
          this.inflight.delete(key);
        }
      }
    }

    const daily = this.klinesDaily.get(symbol);
    // Also due once the UTC day turns: only a refetch completes the bar that was
    // still in progress last time.
    if (force || !daily || now - daily.at > DAILY_TTL_MS || !sameUtcDay(daily.at, now)) {
      const key = `k1d:${symbol}`;
      if (!this.inflight.has(key)) {
        this.inflight.add(key);
        try {
          const rows = await this.getJson<unknown>(
            `/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=${DAILY_LIMIT}`,
          );
          const parsed = WickFeed.parseKlines(rows);
          if (parsed.length) this.klinesDaily.set(symbol, { at: now, value: parsed });
        } catch {
          // Keep the last good series; `daily()` stops serving it once stale.
        } finally {
          this.inflight.delete(key);
        }
      }
    }
  }

  /**
   * 5m history for the scanner, only while it still describes the market.
   *
   * Served only for a tracked contract and only while recent. Anything else
   * reads as missing, so gates 3 and 4 go unmeasured and a contract cannot arm
   * on candles that froze when it rotated out of the watch list, when its
   * refreshes started failing, or while the engine was paused.
   */
  klines(symbol: string, now: number = Date.now()): Kline[] | undefined {
    const entry = this.tracked.has(symbol) ? this.klines5m.get(symbol) : undefined;
    return entry && klineFresh(entry.at, now) ? entry.value : undefined;
  }

  /** Daily history for the scanner, on the same terms as `klines`. */
  daily(symbol: string, now: number = Date.now()): Kline[] | undefined {
    const entry = this.tracked.has(symbol) ? this.klinesDaily.get(symbol) : undefined;
    return entry && dailyFresh(entry.at, now) ? entry.value : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Market socket (tier 1)                                              */
  /* ------------------------------------------------------------------ */

  private backoff(retries: number): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(retries, 5));
    return base + Math.random() * 750;
  }

  private openMarket(): void {
    if (!this.running || this.mode === "rest") return;
    const endpoint = MARKET_ENDPOINTS[this.endpointIndex % MARKET_ENDPOINTS.length];
    this.endpointLabel = endpoint.label;
    this.socketCarriesMarks = endpoint.marks;
    this.connectStartedAt = Date.now();
    this.marketState = this.marketRetries ? "retrying" : "connecting";
    this.opts.onStatus?.();

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url);
    } catch (err) {
      this.lastError = `market socket (${endpoint.label}): ${err instanceof Error ? err.message : "failed"}`;
      this.scheduleMarket();
      return;
    }
    this.marketWs = ws;

    // A blackholed handshake fires no event at all and can hold CONNECTING for
    // over a minute. The watchdog turns that silence into a real failure so the
    // UI stops claiming "connecting" and the next endpoint shape gets its turn.
    this.clearConnectTimer("market");
    this.marketConnectTimer = setTimeout(() => {
      if (this.marketWs !== ws || ws.readyState === WebSocket.OPEN) return;
      this.handshakeTimeouts += 1;
      this.lastError = `market socket (${endpoint.label}): no handshake in ${Math.round(
        CONNECT_TIMEOUT_MS / 1000,
      )}s — the stream host looks filtered on this network`;
      this.marketWs = null;
      this.closeSocket(ws);
      this.scheduleMarket();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      this.clearConnectTimer("market");
      this.marketState = "open";
      this.marketRetries = 0;
      this.connectStartedAt = undefined;
      this.opts.onStatus?.();
    };
    ws.onmessage = (ev: MessageEvent) => this.onMarketMessage(ev);
    ws.onerror = () => {
      this.lastError = `market socket (${endpoint.label}) error`;
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.marketWs !== ws) return;
      this.clearConnectTimer("market");
      this.marketWs = null;
      this.lastCloseCode = ev.code || undefined;
      if (ev.code && ev.code !== 1000 && ev.code !== 1005) {
        this.lastError = `market socket (${endpoint.label}) closed ${ev.code}${
          ev.reason ? `: ${ev.reason}` : ""
        }`;
      }
      this.scheduleMarket();
    };
  }

  private scheduleMarket(): void {
    if (!this.running || this.mode === "rest") return;
    this.marketRetries += 1;
    // Hand the next attempt to a different endpoint shape: middleboxes reject
    // some URL forms while leaving others alone.
    this.endpointIndex += 1;
    const exhausted = this.marketRetries >= SOCKET_GIVE_UP;
    this.marketState = exhausted ? "blocked" : "retrying";
    if (this.transport === "socket") this.transport = this.lastPollAt ? "rest" : "none";
    this.opts.onStatus?.();
    // Once blocked, keep a slow probe going in case the network changes.
    const wait = exhausted ? SOCKET_PROBE_MS : this.backoff(this.marketRetries);
    this.marketTimer = setTimeout(() => this.openMarket(), wait);
  }

  private onMarketMessage(ev: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    const now = Date.now();

    // Raw endpoints deliver the bare array; combined ones wrap it in an envelope.
    if (Array.isArray(parsed)) {
      const first = parsed.find(isRecord);
      const kind = first && typeof first.e === "string" ? first.e : "";
      if (kind === "markPriceUpdate") this.ingestMarks(parsed, now);
      else this.ingestTickers(parsed, now);
      this.markSocketLive();
      return;
    }

    if (!isRecord(parsed)) return;
    const stream = typeof parsed.stream === "string" ? parsed.stream : "";
    const data = parsed.data;
    if (!Array.isArray(data)) return;
    if (stream.startsWith("!ticker")) this.ingestTickers(data, now);
    else if (stream.startsWith("!markPrice")) this.ingestMarks(data, now);
    else return;
    this.markSocketLive();
  }

  /** First frame on a fresh socket promotes it to the active transport. */
  private markSocketLive(): void {
    if (this.transport === "socket") return;
    this.transport = "socket";
    this.opts.onStatus?.();
  }

  private ingestTickers(rows: unknown[], now: number): void {
    this.lastTickerAt = now;
    // Sample the rolling turnover counter on a slower clock than the stream.
    const sample = now - this.lastVolSampleAt >= 5_000;
    if (sample) this.lastVolSampleAt = now;

    const seen: string[] = [];
    for (const row of rows) {
      const tick = streamTicker(row, now);
      if (!tick) continue;
      seen.push(tick.symbol);
      this.applyTicker(tick, sample);
    }

    // Without exchangeInfo the stream itself defines the universe.
    if (!this.restOk && seen.length > 50) this.setUniverse(seen);
  }

  /** Shared by both transports so RVOL sampling behaves identically on each. */
  private applyTicker(tick: TickerTick, sample: boolean): void {
    this.tickers.set(tick.symbol, tick);
    if (!sample) return;
    const list = this.volSamples.get(tick.symbol) ?? [];
    const last = list[list.length - 1];
    if (last && tick.at - last.at < 2_000) return;
    list.push({ at: tick.at, quoteVolume: tick.quoteVolume, trades: tick.trades });
    this.volSamples.set(tick.symbol, list.slice(-MAX_VOL_SAMPLES));
  }

  private ingestMarks(rows: unknown[], now: number): void {
    this.lastMarkAt = now;
    for (const row of rows) {
      const mark = streamMark(row, now);
      if (mark) this.marks.set(mark.symbol, mark);
    }
  }

  /* ------------------------------------------------------------------ */
  /* REST safety net                                                     */
  /* ------------------------------------------------------------------ */

  /** True while the socket is both open and actually delivering frames. */
  private socketFresh(now: number): boolean {
    return this.marketState === "open" && !!this.lastTickerAt && now - this.lastTickerAt < 10_000;
  }

  private fallbackTick(): void {
    if (!this.running) return;
    const now = Date.now();

    if (this.socketFresh(now)) {
      // A ticker-only endpoint still needs funding and mark prices from REST.
      if (!this.socketCarriesMarks && (!this.lastMarkAt || now - this.lastMarkAt > 15_000)) {
        void this.pollMarks();
      }
    } else {
      void this.pollTier1();
    }
  }

  /** Tier-1 snapshot over HTTPS: same venue, same fields, slower clock. */
  private async pollTier1(opts: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (!opts.force && now - this.lastPollStartedAt < REST_POLL_MS) return;
    if (this.inflight.has("poll:t1")) return;
    this.lastPollStartedAt = now;
    this.inflight.add("poll:t1");
    try {
      const rows = await this.getJson<unknown[]>("/fapi/v1/ticker/24hr", 15_000);
      if (!Array.isArray(rows)) throw new Error("unexpected payload");
      const at = Date.now();
      const sample = at - this.lastVolSampleAt >= 5_000;
      if (sample) this.lastVolSampleAt = at;

      const seen: string[] = [];
      for (const row of rows) {
        const tick = restTicker(row, at);
        if (!tick) continue;
        seen.push(tick.symbol);
        this.applyTicker(tick, sample);
      }
      if (!seen.length) throw new Error("no USDT perpetuals in payload");

      this.lastTickerAt = at;
      this.lastPollAt = at;
      this.pollFailures = 0;
      this.restOk = true;
      if (!this.universe.length) this.setUniverse(seen);
      if (!this.socketFresh(at)) this.transport = "rest";
      this.opts.onStatus?.();
      await this.pollMarks();
    } catch (err) {
      this.pollFailures += 1;
      this.lastError = `ticker poll: ${err instanceof Error ? err.message : "failed"}`;
      // One failure is a blip; two in a row means the venue is unreachable.
      if (this.pollFailures >= 2) {
        this.restOk = false;
        if (!this.socketFresh(Date.now())) this.transport = "none";
      }
      this.opts.onStatus?.();
    } finally {
      this.inflight.delete("poll:t1");
    }
  }

  /** Mark price, index price and funding for the whole board in one request. */
  private async pollMarks(): Promise<void> {
    if (this.inflight.has("poll:mark")) return;
    this.inflight.add("poll:mark");
    try {
      const rows = await this.getJson<unknown[]>("/fapi/v1/premiumIndex", 15_000);
      if (!Array.isArray(rows)) return;
      const at = Date.now();
      let count = 0;
      for (const row of rows) {
        const mark = restMark(row, at);
        if (!mark) continue;
        this.marks.set(mark.symbol, mark);
        count += 1;
      }
      if (count) this.lastMarkAt = at;
    } catch {
      /* the tier-1 poll already reports REST health */
    } finally {
      this.inflight.delete("poll:mark");
    }
  }

  /* ------------------------------------------------------------------ */
  /* History watch (tier 2)                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Swap the history watch list.
   *
   * The exhaustion model reads 5m and 1d klines per symbol and nothing else, so
   * tier 2 is a cached-REST concern only: there is no second socket to open, no
   * aggregate-trade stream and no depth subscription to reconcile. Contracts
   * that leave the set stop being refreshed and, from that moment, stop being
   * served, so the scanner cannot keep scoring their frozen candles.
   */
  setDeepWatch(symbols: string[]): void {
    const next = [...new Set(symbols)];
    const added = next.filter((s) => !this.deepSet.includes(s));
    const removed = this.deepSet.filter((s) => !next.includes(s));
    if (!added.length && !removed.length) return;

    this.deepSet = next;
    this.retrack();
    for (const symbol of added) void this.loadKlines(symbol);
    this.opts.onStatus?.();
  }

  private retrack(): void {
    const next = new Set<string>([...this.deepSet, ...(this.opts.alwaysFresh ?? [])]);
    if (this.focus) next.add(this.focus);
    this.tracked = next;
  }

  /** Everything whose history is refreshed: see `tracked`. */
  private freshTargets(): string[] {
    return [...this.tracked];
  }

  /**
   * Forget history for contracts no longer tracked once it is too old to be
   * served. It could never be scored again without a refetch, so keeping it
   * would only grow memory as the watch list rotates across the board.
   */
  private prune(now: number): void {
    for (const [symbol, entry] of this.klines5m) {
      if (!this.tracked.has(symbol) && !klineFresh(entry.at, now)) this.klines5m.delete(symbol);
    }
    for (const [symbol, entry] of this.klinesDaily) {
      if (!this.tracked.has(symbol) && !dailyFresh(entry.at, now)) this.klinesDaily.delete(symbol);
    }
  }

  /** Refresh history for everything tracked, and forget what can no longer be served. */
  refreshDeep(): void {
    this.prune(Date.now());
    for (const symbol of this.freshTargets()) void this.loadKlines(symbol);
  }

  /**
   * Force every cached input to be re-fetched right now, ignoring the TTLs.
   *
   * This backs the manual Refresh button. Trading fast wicks means the trader
   * sometimes needs the newest possible numbers rather than whatever the 25s
   * kline cache and 4s poll throttle happen to hold, so both are bypassed.
   *
   * The focused contract is refreshed even when it is not in the deep set, so
   * the panel the trader is actually looking at always updates. Resolves once
   * every request has settled, letting the caller keep a spinner up for the
   * real duration instead of guessing.
   */
  async refreshNow(focus?: string): Promise<void> {
    // Adopt the focus first, so what is fetched for it is served to the scan
    // that follows instead of waiting for the next pass to claim it.
    if (focus && focus !== this.focus) {
      this.focus = focus;
      this.retrack();
    }
    await Promise.all([
      this.pollTier1({ force: true }),
      ...this.freshTargets().map((symbol) => this.loadKlines(symbol, true)),
    ]);
    this.opts.onStatus?.();
  }

}
