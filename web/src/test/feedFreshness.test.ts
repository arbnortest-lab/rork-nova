import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateExhaustion } from "@/lib/wick/exhaustion";
import { DAILY_MAX_AGE_MS, KLINE_MAX_AGE_MS, WickFeed, type WickFeedOptions } from "@/lib/wick/feed";
import { setupFellApart } from "@/lib/wick/rearm";
import { DEFAULT_WICK_RULES } from "@/lib/wick/rules";
import type { ExhaustionRead, GateKey, GateRead, Kline, TickerTick, VolumeRead } from "@/lib/wick/types";

const MIN = 60_000;
const DAY = 86_400_000;
/** 2023-11-14 22:13:20 UTC. */
const T = 1_700_000_000_000;
const DAY_START = Math.floor(T / DAY) * DAY;

/* ------------------------------------------------------------------ */
/* A venue that serves one armed setup                                 */
/* ------------------------------------------------------------------ */

/** One 5m candle whose upper wick is `wick` of its range. */
function candle(openTime: number, low: number, high: number, wick = 0.2): Kline {
  const range = high - low;
  const body = high - range * wick;
  return {
    openTime,
    open: body - range * 0.05,
    high,
    low,
    close: body,
    volume: 100,
    quoteVolume: 100 * body,
    trades: 50,
  };
}

/** 18 quiet bars, then a new high that gave 60% of its range straight back. */
const TRAP_5M: Kline[] = [
  ...Array.from({ length: 18 }, (_, i) => candle(T - (19 - i) * 5 * MIN, 99, 101)),
  candle(T - 5 * MIN, 99, 110, 0.6),
];

/** Thirty completed days topping out at 110, the level price is pinned to. */
const DAILY: Kline[] = Array.from({ length: 30 }, (_, i) => ({
  openTime: DAY_START - (30 - i) * DAY,
  open: 100,
  high: i === 29 ? 110 : 105,
  low: 90,
  close: 100,
  volume: 1_000,
  quoteVolume: 100_000,
  trades: 500,
}));

/** A kline in Binance's wire format. */
function row(k: Kline): (number | string)[] {
  return [k.openTime, `${k.open}`, `${k.high}`, `${k.low}`, `${k.close}`, `${k.volume}`, k.openTime + 5 * MIN - 1, `${k.quoteVolume}`, k.trades, "0", "0", "0"];
}

interface Venue {
  urls: string[];
  /** Contracts whose kline requests fail, as when refreshes stop landing. */
  failing: Set<string>;
}

function stubVenue(): Venue {
  const venue: Venue = { urls: [], failing: new Set<string>() };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      venue.urls.push(url);
      const symbol = /[?&]symbol=([A-Z0-9]+)/.exec(url)?.[1];
      if (!url.includes("/fapi/v1/klines") || !symbol) return new Response("[]", { status: 200 });
      if (venue.failing.has(symbol)) return new Response("{}", { status: 500 });
      const bars = url.includes("interval=1d") ? DAILY : TRAP_5M;
      return new Response(JSON.stringify(bars.map(row)), { status: 200 });
    }),
  );
  return venue;
}

function requests(venue: Venue, symbol: string, interval: "5m" | "1d"): number {
  return venue.urls.filter((u) => u.includes(`symbol=${symbol}&interval=${interval}`)).length;
}

/* ------------------------------------------------------------------ */
/* Scoring exactly as the scanner does                                 */
/* ------------------------------------------------------------------ */

const CLIMAX: VolumeRead = {
  quoteVolume24h: 5e8,
  trades24h: 1e6,
  rvol: 500,
  spike: true,
  acceleration: -40,
  precise: true,
};

/** Live tier-1 inputs that pass gates 1 and 2; gates 3 and 4 hang on the feed's history. */
function score(feed: WickFeed, symbol: string): ExhaustionRead {
  const at = Date.now();
  const ticker: TickerTick = { symbol, last: 110, open: 95, high: 110, low: 90, vwap24h: 100, quoteVolume: 5e8, trades: 1e6, at };
  return evaluateExhaustion({
    symbol,
    ticker,
    volume: CLIMAX,
    klines: feed.klines(symbol, at),
    daily: feed.daily(symbol, at),
    rules: DEFAULT_WICK_RULES,
    at,
  });
}

function gate(read: ExhaustionRead, key: GateKey): GateRead | undefined {
  return read.gates.find((g) => g.key === key);
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let now = T;
const feeds: WickFeed[] = [];

function feedOf(opts?: WickFeedOptions): WickFeed {
  const feed = new WickFeed(opts);
  feeds.push(feed);
  return feed;
}

/** Waits until a contract's history has landed; daily bars are the last thing a load fetches. */
async function loaded(feed: WickFeed, symbol: string): Promise<void> {
  await vi.waitFor(() => {
    expect(feed.klines(symbol)).toBeDefined();
    expect(feed.daily(symbol)).toBeDefined();
  });
}

beforeEach(() => {
  now = T;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  for (const feed of feeds.splice(0)) feed.stop();
  // Loads still in flight finish against a venue that refuses everything, so
  // no test can ever reach the real network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("Scanner history is only served while it is live", () => {
  it("scores a watched contract on its candles", async () => {
    stubVenue();
    const feed = feedOf();
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");

    expect(score(feed, "ETHUSDT").armed).toBe(true);
  });

  it("stops scoring a contract's candles the moment it leaves the watch list", async () => {
    stubVenue();
    const feed = feedOf();
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");

    // Rotated out: nothing refreshes these candles any more, so they stop counting.
    feed.setDeepWatch(["SOLUSDT"]);
    const read = score(feed, "ETHUSDT");
    expect(feed.klines("ETHUSDT")).toBeUndefined();
    expect(feed.daily("ETHUSDT")).toBeUndefined();
    expect(read.armed).toBe(false);
    expect(gate(read, "trap")).toMatchObject({ measured: false, passed: false });
    expect(gate(read, "depletion")).toMatchObject({ measured: false, passed: false });

    await loaded(feed, "SOLUSDT");
  });

  it("stops scoring candles whose refreshes keep failing, and resumes once they land", async () => {
    const venue = stubVenue();
    const feed = feedOf();
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");

    venue.failing.add("ETHUSDT");
    now = T + MIN;
    await feed.refreshNow();
    // A missed refresh is tolerated: the last good candles are a minute old.
    expect(score(feed, "ETHUSDT").armed).toBe(true);

    now = T + KLINE_MAX_AGE_MS;
    expect(feed.klines("ETHUSDT")).toBeDefined();
    now = T + KLINE_MAX_AGE_MS + 1;
    expect(feed.klines("ETHUSDT")).toBeUndefined();
    const stale = score(feed, "ETHUSDT");
    expect(stale.armed).toBe(false);
    expect(gate(stale, "trap")?.measured).toBe(false);

    venue.failing.delete("ETHUSDT");
    await feed.refreshNow();
    expect(score(feed, "ETHUSDT").armed).toBe(true);
  });

  it("does not score candles left over from a pause", async () => {
    const venue = stubVenue();
    const feed = feedOf();
    feed.setMode("rest"); // polling only: no socket in tests
    feed.start();
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");
    feed.stop();

    now = T + 10 * MIN;
    expect(feed.klines("ETHUSDT")).toBeUndefined();
    expect(score(feed, "ETHUSDT").armed).toBe(false);

    // Resuming reloads the watch list at once instead of waiting for the refresh clock.
    feed.start();
    expect(requests(venue, "ETHUSDT", "5m")).toBe(2);
    await loaded(feed, "ETHUSDT");
    expect(score(feed, "ETHUSDT").armed).toBe(true);
  });

  it("withdraws daily bars when the UTC day turns and refetches them at once", async () => {
    const venue = stubVenue();
    const feed = feedOf();
    now = DAY_START + DAY - 10 * MIN; // 23:50 UTC
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");

    // 00:05 UTC. The bar still open at 23:50 now reads as a completed day to
    // gate 4, with its last ten minutes missing, so the series is withdrawn...
    now = DAY_START + DAY + 5 * MIN;
    expect(feed.daily("ETHUSDT")).toBeUndefined();

    // ...and refetched, although the half-hour daily refresh window is still open.
    feed.refreshDeep();
    await vi.waitFor(() => expect(requests(venue, "ETHUSDT", "1d")).toBe(2));
    await loaded(feed, "ETHUSDT");
  });

  it("keeps daily bars through the refresh window inside one day, then expires them", async () => {
    const venue = stubVenue();
    const feed = feedOf();
    const noon = DAY_START + 12 * 60 * MIN;
    now = noon;
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");
    const before = feed.klines("ETHUSDT");

    now = noon + 15 * MIN;
    feed.refreshDeep();
    await vi.waitFor(() => {
      const next = feed.klines("ETHUSDT");
      expect(next).toBeDefined();
      expect(next).not.toBe(before);
    });
    expect(requests(venue, "ETHUSDT", "1d")).toBe(1);
    expect(feed.daily("ETHUSDT")).toBeDefined();

    now = noon + DAILY_MAX_AGE_MS;
    expect(feed.daily("ETHUSDT")).toBeDefined();
    now = noon + DAILY_MAX_AGE_MS + 1;
    expect(feed.daily("ETHUSDT")).toBeUndefined();
  });

  it("keeps the focused contract live without a watch-list slot", async () => {
    const venue = stubVenue();
    const feed = feedOf();
    feed.setMode("rest");
    feed.start();

    // Selecting a contract loads it at once, even with no slot.
    feed.setFocus("XRPUSDT");
    expect(requests(venue, "XRPUSDT", "5m")).toBe(1);
    await loaded(feed, "XRPUSDT");
    expect(score(feed, "XRPUSDT").armed).toBe(true);

    feed.setFocus("ETHUSDT");
    expect(feed.klines("XRPUSDT")).toBeUndefined();
    await loaded(feed, "ETHUSDT");
  });

  it("serves a manual refresh of the focused contract straight away", async () => {
    stubVenue();
    const feed = feedOf();
    await feed.refreshNow("ADAUSDT");
    expect(score(feed, "ADAUSDT").armed).toBe(true);
  });

  it("keeps BTCUSDT live for its log without a watch-list slot", async () => {
    stubVenue();
    const feed = feedOf({ alwaysFresh: ["BTCUSDT"] });
    await feed.refreshNow();
    feed.setDeepWatch(["ETHUSDT"]);
    expect(feed.klines("BTCUSDT")).toBeDefined();
    await loaded(feed, "ETHUSDT");
  });

  it("forgets history it can no longer serve", async () => {
    stubVenue();
    const feed = feedOf();
    feed.setDeepWatch(["ETHUSDT"]);
    await loaded(feed, "ETHUSDT");
    feed.setDeepWatch(["SOLUSDT"]);
    await loaded(feed, "SOLUSDT");

    // The caches are private; this only checks they do not grow without bound
    // as the watch list rotates across the board.
    const cache = feed as unknown as { klines5m: Map<string, unknown>; klinesDaily: Map<string, unknown> };

    now = T + KLINE_MAX_AGE_MS + 1;
    feed.refreshDeep();
    expect(cache.klines5m.has("ETHUSDT")).toBe(false);
    expect(cache.klinesDaily.has("ETHUSDT")).toBe(true);

    now = T + DAILY_MAX_AGE_MS + 1;
    feed.refreshDeep();
    expect(cache.klinesDaily.has("ETHUSDT")).toBe(false);
    // Tracked contracts are never dropped.
    expect(cache.klines5m.has("SOLUSDT")).toBe(true);
    expect(cache.klinesDaily.has("SOLUSDT")).toBe(true);
  });
});

describe("Alert re-arming across data gaps", () => {
  const QUIET: VolumeRead = { ...CLIMAX, rvol: 100, spike: false, acceleration: 0 };

  function readOf(opts: { last: number; volume: VolumeRead; history: boolean }): ExhaustionRead {
    const ticker: TickerTick = { symbol: "ETHUSDT", last: opts.last, open: 95, high: 110, low: 90, vwap24h: 100, quoteVolume: 5e8, trades: 1e6, at: T };
    return evaluateExhaustion({
      symbol: "ETHUSDT",
      ticker,
      volume: opts.volume,
      klines: opts.history ? TRAP_5M : undefined,
      daily: opts.history ? DAILY : undefined,
      rules: DEFAULT_WICK_RULES,
      at: T,
    });
  }

  it("re-arms exactly as before while every gate is measured", () => {
    const reads = [
      readOf({ last: 110, volume: CLIMAX, history: true }),
      readOf({ last: 110, volume: QUIET, history: true }),
      readOf({ last: 100, volume: CLIMAX, history: true }),
      readOf({ last: 100, volume: QUIET, history: true }),
    ];
    expect(reads.map((r) => r.passedCount)).toEqual([4, 3, 2, 1]);
    for (const r of reads) {
      expect(r.measuredCount).toBe(4);
      expect(setupFellApart(r)).toBe(r.passedCount <= 2);
    }
  });

  it("does not re-arm on a data gap alone", () => {
    // Still pinned with climax volume, but out of the watch list: gates 3 and 4
    // are unmeasured. Counted as failures, this would re-arm and alert twice.
    const gap = readOf({ last: 110, volume: CLIMAX, history: false });
    expect(gap.passedCount).toBe(2);
    expect(setupFellApart(gap)).toBe(false);
  });

  it("still re-arms when the gates it can measure show the setup collapsed", () => {
    expect(setupFellApart(readOf({ last: 100, volume: QUIET, history: false }))).toBe(true);
    expect(setupFellApart(readOf({ last: 100, volume: CLIMAX, history: false }))).toBe(false);
  });
});
