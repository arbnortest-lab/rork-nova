import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  klineStream,
  LIQUIDATION_STREAM,
  microStreams,
  RadarStream,
  routeSummary,
  streamRoute,
  type RadarStreamHandlers,
} from "@/lib/radar/stream";
import type { StreamRoute } from "@/lib/radar/types";

/* ------------------------------------------------------------------ */
/* A venue socket the transport can be driven against                 */
/* ------------------------------------------------------------------ */

type Frame = { method: string; params: string[]; id: number };

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(frame: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket not open");
    this.sent.push(frame);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  /* --- venue side --- */

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  push(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  frames(): Frame[] {
    return this.sent.map((s) => JSON.parse(s) as Frame);
  }

  lastFrame(): Frame | undefined {
    const frames = this.frames();
    return frames[frames.length - 1];
  }

  subscribed(): string[] {
    const out = new Set<string>();
    for (const f of this.frames()) {
      if (f.method === "SUBSCRIBE") for (const p of f.params) out.add(p);
      if (f.method === "UNSUBSCRIBE") for (const p of f.params) out.delete(p);
    }
    return [...out];
  }
}

type MockHandlers = { [K in keyof RadarStreamHandlers]: Mock<RadarStreamHandlers[K]> };

function handlers(): MockHandlers {
  return {
    onDepth: vi.fn<RadarStreamHandlers["onDepth"]>(),
    onTrade: vi.fn<RadarStreamHandlers["onTrade"]>(),
    onLiquidation: vi.fn<RadarStreamHandlers["onLiquidation"]>(),
    onMark: vi.fn<RadarStreamHandlers["onMark"]>(),
    onKline: vi.fn<RadarStreamHandlers["onKline"]>(),
    onStatus: vi.fn<RadarStreamHandlers["onStatus"]>(),
  };
}

/** The newest socket opened on a route, if any. */
function socket(route: StreamRoute): FakeSocket | undefined {
  const list = FakeSocket.instances.filter((s) => s.url.includes(`/${route}/`));
  return list[list.length - 1];
}

function mustSocket(route: StreamRoute): FakeSocket {
  const s = socket(route);
  if (!s) throw new Error(`no ${route} socket`);
  return s;
}

/** Let the paced frame queue flush. */
function drain(): void {
  vi.advanceTimersByTime(260 * 6);
}

function attach(symbol = "VETUSDT"): { rs: RadarStream; h: MockHandlers; pub: FakeSocket; mkt: FakeSocket } {
  const h = handlers();
  const rs = new RadarStream(h);
  rs.setStreams([...microStreams(symbol), LIQUIDATION_STREAM, klineStream(symbol, "5m")]);
  const pub = mustSocket("public");
  const mkt = mustSocket("market");
  pub.accept();
  mkt.accept();
  drain();
  return { rs, h, pub, mkt };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Stream names and routing                                            */
/* ------------------------------------------------------------------ */

describe("stream names", () => {
  it("subscribes a contract to depth, aggregate trades and 1s mark price, symbol lowercased", () => {
    expect(microStreams("VETUSDT")).toEqual(["vetusdt@depth20@100ms", "vetusdt@aggTrade", "vetusdt@markPrice@1s"]);
    expect(klineStream("BTCUSDT", "15m")).toBe("btcusdt@kline_15m");
    expect(LIQUIDATION_STREAM).toBe("!forceOrder@arr");
  });

  it.each<[string, StreamRoute]>([
    ["btcusdt@depth20@100ms", "public"],
    ["btcusdt@depth5@500ms", "public"],
    ["btcusdt@depth", "public"],
    ["btcusdt@depth@100ms", "public"],
    ["btcusdt@bookTicker", "public"],
    ["!bookTicker", "public"],
    ["btcusdt@trade", "public"],
    ["btcusdt@aggTrade", "market"],
    ["btcusdt@markPrice", "market"],
    ["btcusdt@markPrice@1s", "market"],
    ["!markPrice@arr@1s", "market"],
    ["btcusdt@kline_1m", "market"],
    ["btcusdt_perpetual@continuousKline_1m", "market"],
    ["btcusdt@miniTicker", "market"],
    ["!miniTicker@arr", "market"],
    ["btcusdt@ticker", "market"],
    ["!ticker@arr", "market"],
    ["btcusdt@forceOrder", "market"],
    ["!forceOrder@arr", "market"],
    ["btcusdt@compositeIndex", "market"],
    ["!contractInfo", "market"],
    ["!assetIndex@arr", "market"],
  ])("routes %s to the %s endpoint", (stream, route) => {
    expect(streamRoute(stream)).toBe(route);
  });

  it("routes case-insensitively so a hand-typed name cannot land on the silent endpoint", () => {
    expect(streamRoute("BTCUSDT@AGGTRADE")).toBe("market");
    expect(streamRoute("BTCUSDT@DEPTH20@100MS")).toBe("public");
  });
});

/* ------------------------------------------------------------------ */
/* Subscription payloads                                               */
/* ------------------------------------------------------------------ */

describe("RadarStream subscriptions", () => {
  it("opens one routed socket per group and subscribes each to its own slice", () => {
    const h = handlers();
    const rs = new RadarStream(h);
    rs.setStreams([...microStreams("VETUSDT"), LIQUIDATION_STREAM, klineStream("VETUSDT", "5m")]);

    const pub = mustSocket("public");
    const mkt = mustSocket("market");
    expect(pub.url).toBe("wss://fstream.binance.com/public/stream");
    expect(mkt.url).toBe("wss://fstream.binance.com/market/stream");
    expect(FakeSocket.instances).toHaveLength(2);

    pub.accept();
    mkt.accept();
    drain();

    expect(pub.frames()).toEqual([{ method: "SUBSCRIBE", params: ["vetusdt@depth20@100ms"], id: 1 }]);
    expect(mkt.frames()).toEqual([
      {
        method: "SUBSCRIBE",
        params: ["vetusdt@aggTrade", "vetusdt@markPrice@1s", "!forceOrder@arr", "vetusdt@kline_5m"],
        id: 1,
      },
    ]);
    expect(rs.routeStreams("public")).toEqual(["vetusdt@depth20@100ms"]);
    expect(rs.routeStreams("market")).toEqual(["!forceOrder@arr", "vetusdt@aggTrade", "vetusdt@kline_5m", "vetusdt@markPrice@1s"]);

    const status = rs.status();
    expect(status.state).toBe("open");
    expect(status.streams).toBe(5);
    expect(status.routes.public.streams).toBe(1);
    expect(status.routes.market.streams).toBe(4);
    expect(status.endpoint).toBe("public:combined · market:combined");
  });

  it("adds a newly armed contract to both sockets with one SUBSCRIBE frame each", () => {
    const { rs, pub, mkt } = attach("VETUSDT");
    rs.setStreams([...microStreams("VETUSDT"), ...microStreams("XLMUSDT"), LIQUIDATION_STREAM, klineStream("VETUSDT", "5m")]);
    drain();

    expect(pub.lastFrame()).toEqual({ method: "SUBSCRIBE", params: ["xlmusdt@depth20@100ms"], id: 2 });
    expect(mkt.lastFrame()).toEqual({ method: "SUBSCRIBE", params: ["xlmusdt@aggTrade", "xlmusdt@markPrice@1s"], id: 2 });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("unsubscribes a contract from both sockets when it leaves the set", () => {
    const { rs, pub, mkt } = attach("VETUSDT");
    rs.setStreams([...microStreams("VETUSDT"), ...microStreams("XLMUSDT"), LIQUIDATION_STREAM, klineStream("VETUSDT", "5m")]);
    drain();
    rs.setStreams([...microStreams("XLMUSDT"), LIQUIDATION_STREAM]);
    drain();

    expect(pub.lastFrame()).toEqual({ method: "UNSUBSCRIBE", params: ["vetusdt@depth20@100ms"], id: 3 });
    expect(mkt.lastFrame()).toEqual({
      method: "UNSUBSCRIBE",
      params: ["vetusdt@aggTrade", "vetusdt@markPrice@1s", "vetusdt@kline_5m"],
      id: 3,
    });
    expect(pub.subscribed()).toEqual(["xlmusdt@depth20@100ms"]);
    expect(mkt.subscribed()).toEqual(["!forceOrder@arr", "xlmusdt@aggTrade", "xlmusdt@markPrice@1s"]);
  });

  it("only opens the socket whose route has streams wanted", () => {
    const h = handlers();
    const rs = new RadarStream(h);
    rs.setStreams(["btcusdt@depth20@100ms"]);
    expect(socket("public")).toBeDefined();
    expect(socket("market")).toBeUndefined();
    expect(rs.status().state).toBe("connecting");
    expect(rs.status().routes.market.state).toBe("idle");
  });

  it("closes a route's socket when its slice empties and the other stays open", () => {
    const { rs, pub, mkt } = attach("VETUSDT");
    rs.setStreams(["vetusdt@depth20@100ms"]);
    expect(mkt.closeCalls).toBe(1);
    expect(pub.closeCalls).toBe(0);
    expect(rs.status().routes.market.state).toBe("idle");
    expect(rs.status().routes.public.state).toBe("open");
    expect(rs.status().state).toBe("open");
  });

  it("closes both sockets when nothing is wanted, and stop() is final", () => {
    const { rs, pub, mkt } = attach("VETUSDT");
    rs.setStreams([]);
    expect(pub.closeCalls).toBe(1);
    expect(mkt.closeCalls).toBe(1);
    expect(rs.status().state).toBe("idle");
    expect(rs.wantedStreams()).toEqual([]);

    rs.stop();
    rs.setStreams(microStreams("VETUSDT"));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("paces control frames so one socket never exceeds the venue's inbound budget", () => {
    const { rs, mkt } = attach("VETUSDT");
    const symbols = Array.from({ length: 30 }, (_, i) => `A${i}USDT`);
    rs.setStreams([...microStreams("VETUSDT"), ...symbols.flatMap(microStreams), LIQUIDATION_STREAM, klineStream("VETUSDT", "5m")]);
    const before = mkt.sent.length;
    vi.advanceTimersByTime(0);
    expect(mkt.sent.length).toBe(before + 1);
    vi.advanceTimersByTime(200);
    expect(mkt.sent.length).toBe(before + 1);
    vi.advanceTimersByTime(100);
    expect(mkt.sent.length).toBe(before + 2);
    const batches = mkt.frames().slice(before);
    expect(batches.every((f) => f.params.length <= 40)).toBe(true);
    expect(batches.flatMap((f) => f.params)).toHaveLength(60);
  });
});

/* ------------------------------------------------------------------ */
/* Frame parsing                                                       */
/* ------------------------------------------------------------------ */

describe("RadarStream parsing", () => {
  it("parses aggTrade price and size strings into numbers and reads the aggressor from `m`", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({
      stream: "vetusdt@aggTrade",
      data: { e: "aggTrade", E: 1_700_000_000_100, a: 1, s: "VETUSDT", p: "0.02345", q: "12000", f: 1, l: 1, T: 1_700_000_000_000, m: false, st: 1 },
    });
    mkt.push({
      stream: "vetusdt@aggTrade",
      data: { e: "aggTrade", E: 1_700_000_000_200, a: 2, s: "VETUSDT", p: "0.02340", q: "500", T: 1_700_000_000_150, m: true },
    });

    expect(h.onTrade).toHaveBeenCalledTimes(2);
    const [symbol, buy] = h.onTrade.mock.calls[0] as [string, { price: number; qty: number; notional: number; isBuy: boolean; at: number }];
    expect(symbol).toBe("VETUSDT");
    expect(buy.price).toBe(0.02345);
    expect(buy.qty).toBe(12000);
    expect(buy.notional).toBeCloseTo(281.4, 9);
    expect(buy.isBuy).toBe(true);
    expect(buy.at).toBe(1_700_000_000_000);
    const [, sell] = h.onTrade.mock.calls[1] as [string, { isBuy: boolean; notional: number }];
    expect(sell.isBuy).toBe(false);
    expect(sell.notional).toBeCloseTo(11.7, 9);
    expect(Number.isFinite(sell.notional)).toBe(true);
  });

  it("drops prints that do not parse to a positive price and size, so NaN never reaches a buffer", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({ stream: "vetusdt@trade", data: { e: "trade", s: "VETUSDT", p: "0", q: "0", X: "NA", m: false, T: 1 } });
    mkt.push({ stream: "vetusdt@aggTrade", data: { e: "aggTrade", s: "VETUSDT", p: "abc", q: "10", m: false, T: 1 } });
    mkt.push({ stream: "vetusdt@aggTrade", data: { e: "aggTrade", s: "VETUSDT", p: "0.1", q: null, m: false, T: 1 } });
    mkt.push({ stream: "vetusdt@aggTrade", data: { e: "aggTrade", s: "VETUSDT", p: "-0.1", q: "10", m: false, T: 1 } });
    mkt.push({ stream: "vetusdt@aggTrade", data: { e: "aggTrade", p: "0.1", q: "10", m: false, T: 1 } });
    expect(h.onTrade).not.toHaveBeenCalled();
  });

  it("accepts the raw payload shape the fallback endpoint delivers", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({ e: "trade", E: 5, s: "VETUSDT", p: "0.02", q: "100", m: true, T: 4 });
    expect(h.onTrade).toHaveBeenCalledWith("VETUSDT", { price: 0.02, qty: 100, notional: 2, isBuy: false, at: 4 });
  });

  it("stamps a print with arrival time when the venue omits T", () => {
    const { h, mkt } = attach("VETUSDT");
    vi.setSystemTime(1_700_000_123_456);
    mkt.push({ e: "aggTrade", s: "VETUSDT", p: "0.02", q: "100", m: false });
    expect(h.onTrade.mock.calls[0][1]).toMatchObject({ at: 1_700_000_123_456 });
  });

  it("parses markPriceUpdate with funding as a percentage and drops ticks without a price", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({
      stream: "vetusdt@markPrice@1s",
      data: { e: "markPriceUpdate", E: 1_700_000_000_000, s: "VETUSDT", p: "0.02346000", i: "0.02344500", P: "0.02350", r: "0.00010000", T: 1_700_028_800_000 },
    });
    expect(h.onMark).toHaveBeenCalledWith({
      symbol: "VETUSDT",
      markPrice: 0.02346,
      indexPrice: 0.023445,
      fundingRate: 0.01,
      nextFundingTime: 1_700_028_800_000,
      at: 1_700_000_000_000,
    });

    mkt.push({ stream: "vetusdt@markPrice@1s", data: { e: "markPriceUpdate", s: "VETUSDT", p: "", r: "0.0001" } });
    mkt.push({ stream: "vetusdt@markPrice@1s", data: { e: "markPriceUpdate", s: "VETUSDT", p: "0", r: "0.0001" } });
    expect(h.onMark).toHaveBeenCalledTimes(1);
  });

  it("parses depthUpdate levels into numeric rows with notional, skipping empty or invalid rows", () => {
    const { h, pub } = attach("VETUSDT");
    pub.push({
      stream: "vetusdt@depth20@100ms",
      data: {
        e: "depthUpdate",
        E: 1_700_000_000_000,
        s: "VETUSDT",
        b: [["0.02340", "1000"], ["0.02339", "0"], ["bad", "5"], ["0.02338"], ["0.02337", "2500"]],
        a: [["0.02341", "800"], ["0.02342", "1200"]],
      },
    });
    expect(h.onDepth).toHaveBeenCalledTimes(1);
    const [symbol, snapshot] = h.onDepth.mock.calls[0] as [string, { bids: unknown[]; asks: unknown[]; at: number }];
    expect(symbol).toBe("VETUSDT");
    expect(snapshot.at).toBe(1_700_000_000_000);
    expect(snapshot.bids).toEqual([
      { price: 0.0234, qty: 1000, notional: 0.0234 * 1000 },
      { price: 0.02337, qty: 2500, notional: 0.02337 * 2500 },
    ]);
    expect(snapshot.asks).toEqual([
      { price: 0.02341, qty: 800, notional: 0.02341 * 800 },
      { price: 0.02342, qty: 1200, notional: 0.02342 * 1200 },
    ]);
  });

  it("ignores a depth frame with one side empty", () => {
    const { h, pub } = attach("VETUSDT");
    pub.push({ stream: "vetusdt@depth20@100ms", data: { e: "depthUpdate", s: "VETUSDT", b: [["0.02", "1"]], a: [] } });
    expect(h.onDepth).not.toHaveBeenCalled();
  });

  it("parses forceOrder using the average fill price and filled size, falling back to order price and size", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({
      stream: "!forceOrder@arr",
      data: {
        e: "forceOrder",
        E: 1_700_000_000_500,
        o: { s: "VETUSDT", S: "BUY", o: "LIMIT", f: "IOC", q: "100000", p: "0.02400", ap: "0.02390", X: "FILLED", l: "60000", z: "60000", T: 1_700_000_000_400 },
      },
    });
    expect(h.onLiquidation).toHaveBeenCalledWith({
      symbol: "VETUSDT",
      side: "BUY",
      price: 0.0239,
      qty: 60000,
      notional: 0.0239 * 60000,
      at: 1_700_000_000_400,
    });

    mkt.push({ e: "forceOrder", E: 9, o: { s: "XLMUSDT", S: "SELL", q: "10", p: "0.1", ap: "0", z: "0" } });
    expect(h.onLiquidation).toHaveBeenLastCalledWith({ symbol: "XLMUSDT", side: "SELL", price: 0.1, qty: 10, notional: 1, at: 9 });

    mkt.push({ e: "forceOrder", o: { s: "XLMUSDT", S: "HOLD", q: "10", p: "0.1" } });
    mkt.push({ e: "forceOrder", o: { s: "XLMUSDT", S: "SELL", q: "0", p: "0.1" } });
    expect(h.onLiquidation).toHaveBeenCalledTimes(2);
  });

  it("parses kline bars and flags closed ones", () => {
    const { h, mkt } = attach("VETUSDT");
    mkt.push({
      stream: "vetusdt@kline_5m",
      data: {
        e: "kline",
        s: "VETUSDT",
        k: { t: 1_700_000_100_000, i: "5m", o: "0.0230", h: "0.0236", l: "0.0229", c: "0.0234", v: "150000", q: "3480", x: true },
      },
    });
    expect(h.onKline).toHaveBeenCalledWith("VETUSDT", "5m", {
      time: 1_700_000_100_000,
      open: 0.023,
      high: 0.0236,
      low: 0.0229,
      close: 0.0234,
      volume: 150000,
      quoteVolume: 3480,
      closed: true,
    });
    mkt.push({ e: "kline", s: "VETUSDT", k: { t: 0, i: "5m", c: "0.0234" } });
    expect(h.onKline).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown events, malformed JSON and successful control acks, but records subscribe rejections", () => {
    const { rs, h, mkt } = attach("VETUSDT");
    mkt.onmessage?.({ data: "{not json" });
    mkt.push({ stream: "x", data: { e: "somethingElse", s: "VETUSDT" } });
    mkt.push({ result: null, id: 1 });
    mkt.push([{ e: "24hrTicker", s: "VETUSDT" }]);
    expect(h.onTrade).not.toHaveBeenCalled();
    expect(rs.status().lastError).toBeUndefined();

    mkt.push({ error: { code: 2, msg: "Invalid request: unknown stream" }, id: 1 });
    expect(rs.status().lastError).toBe("market socket: subscribe Invalid request: unknown stream");
    expect(rs.status().routes.market.lastError).toBe("market socket: subscribe Invalid request: unknown stream");
    expect(rs.status().routes.public.lastError).toBeUndefined();
    expect(rs.status().messages).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

describe("RadarStream lifecycle", () => {
  it("reconnects a dropped socket on the next endpoint shape and re-subscribes its full slice", () => {
    const { rs, mkt, pub } = attach("VETUSDT");
    mkt.drop(1006, "abnormal");
    expect(rs.status().routes.market.state).toBe("retrying");
    expect(rs.status().state).toBe("retrying");
    expect(rs.status().routes.public.state).toBe("open");
    expect(rs.status().lastError).toBe("market socket: (combined) closed 1006: abnormal");

    vi.advanceTimersByTime(2_600);
    const next = mustSocket("market");
    expect(next).not.toBe(mkt);
    expect(next.url).toBe("wss://fstream.binance.com/market/ws");
    next.accept();
    drain();
    expect(next.frames()).toEqual([
      { method: "SUBSCRIBE", params: ["vetusdt@aggTrade", "vetusdt@markPrice@1s", "!forceOrder@arr", "vetusdt@kline_5m"], id: 2 },
    ]);
    expect(rs.status().state).toBe("open");
    expect(rs.status().retries).toBe(0);
    expect(pub.closeCalls).toBe(0);
  });

  it("treats a silent heartbeat stream as a dead socket: 30s without a frame while mark price is subscribed", () => {
    const { rs, mkt } = attach("VETUSDT");
    vi.advanceTimersByTime(20_000);
    mkt.push({ e: "aggTrade", s: "VETUSDT", p: "0.02", q: "1", m: false, T: 1 });
    vi.advanceTimersByTime(20_000);
    expect(mkt.closeCalls).toBe(0);

    vi.advanceTimersByTime(15_000);
    expect(mkt.closeCalls).toBe(1);
    expect(rs.status().routes.market.state).toBe("retrying");
    expect(rs.status().lastError).toBe("market socket: went silent — reconnecting");
  });

  it("does not stale-check a socket without a heartbeat stream", () => {
    const h = handlers();
    const rs = new RadarStream(h);
    rs.setStreams([LIQUIDATION_STREAM]);
    const mkt = mustSocket("market");
    mkt.accept();
    drain();
    vi.advanceTimersByTime(120_000);
    expect(mkt.closeCalls).toBe(0);
    expect(rs.status().state).toBe("open");
  });

  it("times out a handshake that never completes", () => {
    const h = handlers();
    const rs = new RadarStream(h);
    rs.setStreams(microStreams("VETUSDT"));
    const pub = mustSocket("public");
    vi.advanceTimersByTime(7_100);
    expect(pub.closeCalls).toBe(1);
    expect(rs.status().routes.public.state).toBe("retrying");
    expect(rs.status().routes.public.lastError).toBe("public socket: (combined) no handshake in 7s");
  });

  it("reports blocked after six consecutive failures and keeps probing every minute", () => {
    const h = handlers();
    const rs = new RadarStream(h);
    rs.setStreams(["vetusdt@depth20@100ms"]);
    for (let i = 0; i < 6; i++) {
      // Nobody completes the handshake: the 7s watchdog counts each attempt as a failure.
      vi.advanceTimersByTime(7_100);
      expect(rs.status().retries).toBe(i + 1);
      // Backoff is 1s x 2^n capped at 30s plus up to 500ms of jitter.
      if (i < 5) vi.advanceTimersByTime(Math.min(30_000, 1_000 * 2 ** Math.min(i + 1, 5)) + 600);
    }
    expect(rs.status().routes.public.state).toBe("blocked");
    expect(rs.status().state).toBe("blocked");
    expect(rs.status().retries).toBe(6);
    expect(FakeSocket.instances).toHaveLength(6);
    vi.advanceTimersByTime(60_600);
    expect(FakeSocket.instances).toHaveLength(7);
    expect(mustSocket("public").url).toBe("wss://fstream.binance.com/public/stream");

    // A completed handshake clears the counter.
    mustSocket("public").accept();
    expect(rs.status().state).toBe("open");
    expect(rs.status().retries).toBe(0);
  });

  it("publishes a status on every transition, with both routes attached", () => {
    const { h, rs } = attach("VETUSDT");
    const calls = h.onStatus.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.routes.public.state).toBe("open");
    expect(last.routes.market.state).toBe("open");
    expect(routeSummary(rs.status(), Date.now())).toBe("public open · 1 stream\nmarket open · 4 streams");
  });
});
