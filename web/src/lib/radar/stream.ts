/**
 * Squeeze Radar transport — Binance USDⓈ-M Futures market streams.
 *
 * Two routed sockets, not one. In March 2026 the venue split its futures
 * WebSocket into dedicated entry points and an unrouted connection
 * (`wss://fstream.binance.com/stream`) now serves only the `/public` group:
 * every other stream is still ACKNOWLEDGED on it — `{"result":null,"id":n}`,
 * listed by LIST_SUBSCRIPTIONS — and never delivers a frame. So the radar
 * keeps one socket per route and partitions its stream set by name:
 *
 *   /public  (high-frequency book data)
 *     <symbol>@depth20@100ms   top 20 levels each side, ten times a second
 *     <symbol>@bookTicker, !bookTicker, <symbol>@depth (diff)
 *
 *   /market  (regular market data)
 *     <symbol>@aggTrade        every aggressive print
 *     <symbol>@markPrice@1s    mark, index, funding, next funding
 *     <symbol>@kline_<tf>      the focused contract's chart, live
 *     !forceOrder@arr          every liquidation on the venue, one stream shared
 *                              by all armed contracts and filtered locally
 *     (also @ticker, @miniTicker, @continuousKline, @compositeIndex, …)
 *
 * Each socket multiplexes dynamically: Binance lets one connection carry up to
 * 1024 streams and change them live with SUBSCRIBE / UNSUBSCRIBE frames, so a
 * route's stream set is edited in place as contracts arm and disarm. When a
 * route's wanted set empties its socket closes; when the first stream returns
 * it opens again. Binance allows 10 inbound messages per second per
 * connection, so subscription edits are batched and paced per socket.
 * Connections are recycled by the venue after 24h: a close is always followed
 * by a reconnect that re-subscribes the route's full wanted set.
 */

import type { AggTrade, BookLevel, BookSnapshot, MarkTick, SocketState } from "@/lib/wick/types";

import type { ChartBar, LiquidationEvent, RadarStreamStatus, SocketStatus, StreamRoute } from "./types";

interface Endpoint {
  label: string;
  url: string;
}

/** Shapes tried in turn per route: the combined envelope first, the raw socket second. */
const ROUTE_ENDPOINTS: Record<StreamRoute, Endpoint[]> = {
  public: [
    { label: "combined", url: "wss://fstream.binance.com/public/stream" },
    { label: "raw", url: "wss://fstream.binance.com/public/ws" },
  ],
  market: [
    { label: "combined", url: "wss://fstream.binance.com/market/stream" },
    { label: "raw", url: "wss://fstream.binance.com/market/ws" },
  ],
};

export const STREAM_ROUTES: StreamRoute[] = ["public", "market"];

const CONNECT_TIMEOUT_MS = 7_000;
/** Spacing between control frames on one socket: well inside the venue's 10/s budget. */
const FRAME_SPACING_MS = 260;
/** Streams per SUBSCRIBE frame. */
const FRAME_BATCH = 40;
/**
 * Silence this long on a socket carrying a heartbeat stream means a dead
 * connection, not a quiet market: depth ticks ten times a second and mark
 * price once a second whether or not anything trades.
 */
const STALE_MS = 30_000;
const STALE_CHECK_MS = 5_000;

/** The stream whose cadence proves a route alive. */
const HEARTBEAT: Record<StreamRoute, (stream: string) => boolean> = {
  public: (s) => s.includes("@depth"),
  market: (s) => s.toLowerCase().includes("@markprice"),
};

export interface RadarStreamHandlers {
  onDepth: (symbol: string, snapshot: BookSnapshot) => void;
  onTrade: (symbol: string, trade: AggTrade) => void;
  onLiquidation: (event: LiquidationEvent) => void;
  onMark: (mark: MarkTick) => void;
  onKline: (symbol: string, interval: string, bar: ChartBar) => void;
  onStatus: (status: RadarStreamStatus) => void;
}

/** Binance sends every number as a string; anything unparsable reads as 0 and is rejected downstream. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function levels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = num(row[0]);
    const qty = num(row[1]);
    if (price <= 0 || qty <= 0) continue;
    out.push({ price, qty, notional: price * qty });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stream names                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which routed endpoint serves a stream. The split is the venue's: `/public`
 * carries the book streams (partial and diff depth, book tickers) and the raw
 * trade stream; everything else — aggregate trades, mark price, klines,
 * tickers, liquidations, indices — is `/market`. A stream sent to the wrong
 * route is acknowledged and silently never delivered, so this must be exact.
 */
export function streamRoute(stream: string): StreamRoute {
  const name = stream.trim().toLowerCase();
  const at = name.indexOf("@");
  const channel = at >= 0 ? name.slice(at + 1) : name.replace(/^!/, "");
  if (channel.startsWith("depth") || channel.startsWith("bookticker") || channel === "trade") return "public";
  return "market";
}

/** Stream names for one contract's micro-structure feed. */
export function microStreams(symbol: string): string[] {
  const s = symbol.toLowerCase();
  return [`${s}@depth20@100ms`, `${s}@aggTrade`, `${s}@markPrice@1s`];
}

export function klineStream(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export const LIQUIDATION_STREAM = "!forceOrder@arr";

/** One line per route for tooltips: `public open · 3 streams · 2s ago`. */
export function routeSummary(status: RadarStreamStatus, now: number = Date.now()): string {
  return STREAM_ROUTES.map((route) => {
    const s = status.routes[route];
    const parts = [`${route} ${s.state}`];
    if (s.streams) parts.push(`${s.streams} stream${s.streams === 1 ? "" : "s"}`);
    if (s.lastMessageAt) parts.push(`last frame ${Math.max(0, Math.round((now - s.lastMessageAt) / 1000))}s ago`);
    if (s.lastError) parts.push(s.lastError);
    return parts.join(" · ");
  }).join("\n");
}

/* ------------------------------------------------------------------ */
/* One routed socket                                                   */
/* ------------------------------------------------------------------ */

class RouteSocket {
  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private state: SocketState = "idle";
  private retries = 0;
  private endpointIndex = 0;
  private endpointLabel: string | undefined;
  private openedAt: number | undefined;
  private lastMessageAt: number | undefined;
  private lastError: string | undefined;
  private lastErrorAt = 0;
  private messages = 0;
  private nextId = 1;
  private frameQueue: string[] = [];
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    readonly route: StreamRoute,
    private readonly handlers: RadarStreamHandlers,
    private readonly emitStatus: () => void,
  ) {}

  status(): SocketStatus {
    return {
      state: this.state,
      streams: this.subscribed.size,
      retries: this.retries,
      endpoint: this.endpointLabel,
      openedAt: this.openedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt || undefined,
      messages: this.messages,
    };
  }

  wantedStreams(): string[] {
    return [...this.wanted];
  }

  /**
   * Replace this route's wanted set. The diff against what the socket already
   * carries becomes SUBSCRIBE / UNSUBSCRIBE frames; an empty set closes the
   * socket outright so an idle route costs nothing.
   */
  setStreams(next: Set<string>): void {
    if (this.stopped) return;
    const changed = next.size !== this.wanted.size || [...next].some((s) => !this.wanted.has(s));
    this.wanted = next;
    if (!changed && (this.ws || next.size === 0)) return;

    if (next.size === 0) {
      this.closeAll("idle");
      return;
    }
    if (!this.ws) {
      this.open();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    this.wanted.clear();
    this.closeAll("idle");
  }

  private fail(message: string): void {
    this.lastError = `${this.route} socket: ${message}`;
    this.lastErrorAt = Date.now();
  }

  /* ---------------- lifecycle ---------------- */

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.frameTimer = null;
    this.staleTimer = null;
  }

  private closeAll(state: SocketState): void {
    this.clearTimers();
    this.frameQueue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    this.subscribed.clear();
    this.state = state;
    this.openedAt = undefined;
    this.emitStatus();
  }

  private backoff(): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.retries, 5));
    return base + Math.random() * 500;
  }

  private open(): void {
    if (this.stopped || this.ws || this.wanted.size === 0) return;
    const shapes = ROUTE_ENDPOINTS[this.route];
    const endpoint = shapes[this.endpointIndex % shapes.length];
    this.endpointLabel = endpoint.label;
    this.state = this.retries ? "retrying" : "connecting";
    this.emitStatus();

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url);
    } catch (err) {
      this.fail(`(${endpoint.label}) ${err instanceof Error ? err.message : "failed"}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState === WebSocket.OPEN) return;
      this.fail(`(${endpoint.label}) no handshake in ${CONNECT_TIMEOUT_MS / 1000}s`);
      this.ws = null;
      ws.onclose = null;
      ws.close();
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.state = "open";
      this.retries = 0;
      this.openedAt = Date.now();
      this.messages = 0;
      this.subscribed.clear();
      this.lastMessageAt = undefined;
      this.staleTimer = setInterval(() => this.checkStale(), STALE_CHECK_MS);
      this.reconcile();
      this.emitStatus();
    };
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);
    ws.onerror = () => {
      this.fail(`(${endpoint.label}) error`);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      if (this.staleTimer) clearInterval(this.staleTimer);
      this.connectTimer = null;
      this.staleTimer = null;
      this.subscribed.clear();
      if (ev.code && ev.code !== 1000 && ev.code !== 1005) {
        this.fail(`(${endpoint.label}) closed ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}`);
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.wanted.size === 0) {
      this.state = "idle";
      this.emitStatus();
      return;
    }
    this.retries += 1;
    this.endpointIndex += 1;
    this.state = this.retries >= 6 ? "blocked" : "retrying";
    this.emitStatus();
    const wait = this.retries >= 6 ? 60_000 : this.backoff();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
  }

  /** A heartbeat stream that goes silent for 30s is a dead socket, not a quiet market. */
  private checkStale(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const beats = HEARTBEAT[this.route];
    if (![...this.subscribed].some(beats)) return;
    const since = this.lastMessageAt ?? this.openedAt ?? Date.now();
    if (Date.now() - since < STALE_MS) return;
    this.fail("went silent — reconnecting");
    const ws = this.ws;
    this.ws = null;
    ws.onclose = null;
    ws.close();
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.subscribed.clear();
    this.scheduleReconnect();
  }

  /* ---------------- subscription control ---------------- */

  /** Bring the socket's stream set in line with the wanted set. */
  private reconcile(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const add = [...this.wanted].filter((s) => !this.subscribed.has(s));
    const drop = [...this.subscribed].filter((s) => !this.wanted.has(s));
    for (let i = 0; i < drop.length; i += FRAME_BATCH) {
      const params = drop.slice(i, i + FRAME_BATCH);
      this.enqueue(JSON.stringify({ method: "UNSUBSCRIBE", params, id: this.nextId++ }));
      for (const s of params) this.subscribed.delete(s);
    }
    for (let i = 0; i < add.length; i += FRAME_BATCH) {
      const params = add.slice(i, i + FRAME_BATCH);
      this.enqueue(JSON.stringify({ method: "SUBSCRIBE", params, id: this.nextId++ }));
      for (const s of params) this.subscribed.add(s);
    }
    this.emitStatus();
  }

  private enqueue(frame: string): void {
    this.frameQueue.push(frame);
    this.pump();
  }

  private pump(): void {
    if (this.frameTimer || !this.frameQueue.length) return;
    const wait = Math.max(0, this.lastFrameAt + FRAME_SPACING_MS - Date.now());
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      const frame = this.frameQueue.shift();
      if (frame && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(frame);
          this.lastFrameAt = Date.now();
        } catch (err) {
          this.fail(`send ${err instanceof Error ? err.message : "failed"}`);
        }
      }
      this.pump();
    }, wait);
  }

  /* ---------------- inbound ---------------- */

  private onMessage(ev: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const now = Date.now();
    this.lastMessageAt = now;
    this.messages += 1;

    // Control responses: `{result:null,id}` on success, `{error:{code,msg}}` otherwise.
    if ("id" in parsed && !("stream" in parsed) && !("e" in parsed)) {
      const error = parsed.error;
      if (isRecord(error)) {
        this.fail(`subscribe ${typeof error.msg === "string" ? error.msg : "rejected"}`);
        this.emitStatus();
      }
      return;
    }

    // Combined envelope or raw payload — both are handled, since the fallback
    // endpoint delivers raw frames.
    const data = isRecord(parsed.data) ? parsed.data : parsed;
    if (!isRecord(data)) return;
    const kind = typeof data.e === "string" ? data.e : "";
    switch (kind) {
      case "depthUpdate":
        this.ingestDepth(data, now);
        break;
      case "aggTrade":
      case "trade":
        this.ingestTrade(data, now);
        break;
      case "forceOrder":
        this.ingestLiquidation(data, now);
        break;
      case "markPriceUpdate":
        this.ingestMark(data, now);
        break;
      case "kline":
        this.ingestKline(data);
        break;
      default:
        break;
    }
  }

  private ingestDepth(d: Record<string, unknown>, now: number): void {
    const symbol = typeof d.s === "string" ? d.s : "";
    if (!symbol) return;
    const bids = levels(d.b);
    const asks = levels(d.a);
    if (!bids.length || !asks.length) return;
    this.handlers.onDepth(symbol, { bids, asks, at: num(d.E) || now });
  }

  /**
   * `p` and `q` arrive as strings. A print that does not parse to a positive
   * price and size is dropped here, so nothing downstream ever sees NaN —
   * the venue's raw trade stream, for one, pads with `p:"0", q:"0", X:"NA"`.
   */
  private ingestTrade(d: Record<string, unknown>, now: number): void {
    const symbol = typeof d.s === "string" ? d.s : "";
    const price = num(d.p);
    const qty = num(d.q);
    if (!symbol || price <= 0 || qty <= 0) return;
    this.handlers.onTrade(symbol, {
      price,
      qty,
      notional: price * qty,
      // `m` = buyer is the maker, so the aggressor was a seller.
      isBuy: d.m === false,
      at: num(d.T) || now,
    });
  }

  private ingestLiquidation(d: Record<string, unknown>, now: number): void {
    const o = d.o;
    if (!isRecord(o)) return;
    const symbol = typeof o.s === "string" ? o.s : "";
    const side = o.S === "BUY" ? "BUY" : o.S === "SELL" ? "SELL" : null;
    if (!symbol || !side) return;
    const avg = num(o.ap);
    const price = avg > 0 ? avg : num(o.p);
    const filled = num(o.z);
    const qty = filled > 0 ? filled : num(o.q);
    if (price <= 0 || qty <= 0) return;
    this.handlers.onLiquidation({ symbol, side, price, qty, notional: price * qty, at: num(o.T) || num(d.E) || now });
  }

  private ingestMark(d: Record<string, unknown>, now: number): void {
    const symbol = typeof d.s === "string" ? d.s : "";
    const markPrice = num(d.p);
    if (!symbol || markPrice <= 0) return;
    this.handlers.onMark({
      symbol,
      markPrice,
      indexPrice: num(d.i),
      fundingRate: num(d.r) * 100,
      nextFundingTime: num(d.T),
      at: num(d.E) || now,
    });
  }

  private ingestKline(d: Record<string, unknown>): void {
    const symbol = typeof d.s === "string" ? d.s : "";
    const k = d.k;
    if (!symbol || !isRecord(k)) return;
    const interval = typeof k.i === "string" ? k.i : "";
    const bar: ChartBar = {
      time: num(k.t),
      open: num(k.o),
      high: num(k.h),
      low: num(k.l),
      close: num(k.c),
      volume: num(k.v),
      quoteVolume: num(k.q),
      closed: k.x === true,
    };
    if (bar.time <= 0 || bar.close <= 0) return;
    this.handlers.onKline(symbol, interval, bar);
  }
}

/* ------------------------------------------------------------------ */
/* Facade                                                              */
/* ------------------------------------------------------------------ */

/** Worst state wins so the tag never reads "open" while a route is still down. */
const STATE_RANK: Record<SocketState, number> = { idle: 0, open: 1, connecting: 2, retrying: 3, blocked: 4 };

/**
 * The radar's transport: one `RouteSocket` per Binance route, driven as a
 * single stream set. `setStreams` takes the full wanted list and partitions
 * it by `streamRoute`; status is the combination of both sockets, with the
 * per-route detail alongside for diagnostics.
 */
export class RadarStream {
  private readonly sockets: Record<StreamRoute, RouteSocket>;

  constructor(private readonly handlers: RadarStreamHandlers) {
    const emit = () => this.handlers.onStatus(this.status());
    this.sockets = {
      public: new RouteSocket("public", handlers, emit),
      market: new RouteSocket("market", handlers, emit),
    };
  }

  status(): RadarStreamStatus {
    const routes = {
      public: this.sockets.public.status(),
      market: this.sockets.market.status(),
    };
    const active = STREAM_ROUTES.filter((r) => this.sockets[r].wantedStreams().length > 0).map((r) => routes[r]);
    const all = STREAM_ROUTES.map((r) => routes[r]);
    let state: SocketState = "idle";
    for (const s of active) if (STATE_RANK[s.state] > STATE_RANK[state]) state = s.state;
    const newestError = all.filter((s) => s.lastError).sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0))[0];
    const opened = active.map((s) => s.openedAt).filter((t): t is number => t !== undefined);
    const heard = all.map((s) => s.lastMessageAt).filter((t): t is number => t !== undefined);
    const endpoints = STREAM_ROUTES.filter((r) => routes[r].endpoint).map((r) => `${r}:${routes[r].endpoint}`);
    return {
      state,
      streams: all.reduce((n, s) => n + s.streams, 0),
      retries: all.reduce((n, s) => Math.max(n, s.retries), 0),
      endpoint: endpoints.length ? endpoints.join(" · ") : undefined,
      openedAt: opened.length ? Math.min(...opened) : undefined,
      lastMessageAt: heard.length ? Math.max(...heard) : undefined,
      lastError: newestError?.lastError,
      lastErrorAt: newestError?.lastErrorAt,
      messages: all.reduce((n, s) => n + s.messages, 0),
      routes,
    };
  }

  /** The streams currently wanted across both routes, for diagnostics. */
  wantedStreams(): string[] {
    return STREAM_ROUTES.flatMap((r) => this.sockets[r].wantedStreams()).sort();
  }

  /** Which route a wanted stream rides on, for diagnostics and tests. */
  routeStreams(route: StreamRoute): string[] {
    return this.sockets[route].wantedStreams().sort();
  }

  /**
   * Replace the full wanted stream set. Each route receives its own slice;
   * a route whose slice is empty closes its socket.
   */
  setStreams(streams: Iterable<string>): void {
    const split: Record<StreamRoute, Set<string>> = { public: new Set(), market: new Set() };
    for (const s of streams) if (s) split[streamRoute(s)].add(s);
    for (const r of STREAM_ROUTES) this.sockets[r].setStreams(split[r]);
  }

  stop(): void {
    for (const r of STREAM_ROUTES) this.sockets[r].stop();
  }
}
