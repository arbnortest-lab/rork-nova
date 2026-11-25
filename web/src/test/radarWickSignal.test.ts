import { afterEach, describe, expect, it, vi } from "vitest";

import { wickMonitor, monitorIntervalMs } from "@/lib/radar/wickMonitor";
import { lowerWickSignal, wickShape } from "@/lib/radar/wickSignal";

/** The reference candle at any scale: body 1, tail 4.5, upper 0.3. */
function reference(scale: number) {
  const body = 1 * scale;
  const tail = 4.5 * scale;
  const upper = 0.3 * scale;
  const close = 100 * scale;
  return { open: close - body, high: close + upper, low: close - body - tail, close };
}

describe("wickShape — the reference structure at any size", () => {
  it("accepts the reference candle, large or small", () => {
    for (const scale of [1, 0.01, 250]) {
      const r = reference(scale);
      expect(wickShape(r.open, r.high, r.low, r.close)).not.toBeNull();
    }
  });

  it("rejects red and flat candles regardless of tail", () => {
    const r = reference(1);
    expect(wickShape(r.close, r.high, r.low, r.open)).toBeNull(); // red
    expect(wickShape(100, 100, 100, 100)).toBeNull(); // flat
  });

  it("rejects candles without a lower wick", () => {
    expect(wickShape(99, 101, 99, 100)).toBeNull(); // low == open
  });

  it("rejects when the tail is smaller than the body", () => {
    // body 1, tail 0.5, upper 0.1 — a normal green candle, no signal
    expect(wickShape(100, 101.1, 99.5, 101)).toBeNull();
  });

  it("rejects when the upper shadow beats the tail", () => {
    // body 1, tail 2, upper 3 — tail not dominant
    expect(wickShape(100, 105, 98, 101)).toBeNull();
  });

  it("accepts any green candle whose tail merely dominates body and upper shadow", () => {
    // body 1, tail 1.5, upper 1.2 — modest but structurally matching
    const s = wickShape(100, 102.2, 98.5, 101);
    expect(s).not.toBeNull();
  });
});

describe("lowerWickSignal", () => {
  it("carries the venue close time and closing price", () => {
    const r = reference(1);
    const s = lowerWickSignal("BTCUSDT", "15m", 1_000, 1_000 + 900_000, r.open, r.high, r.low, r.close)!;
    expect(s.closedAt).toBe(1_000 + 900_000);
    expect(s.close).toBe(r.close);
    expect(s.wick).toBeCloseTo(4.5, 9);
    expect(s.interval).toBe("15m");
  });

  it("maps intervals to their length", () => {
    expect(monitorIntervalMs("15m")).toBe(900_000);
    expect(monitorIntervalMs("1h")).toBe(3_600_000);
    expect(monitorIntervalMs("4h")).toBe(14_400_000);
  });
});

type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

const INTERVAL_LENGTH: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

function kline(interval: string, openTime: number, o: number, h: number, l: number, c: number): KlineRow {
  const ms = INTERVAL_LENGTH[interval];
  return [openTime, String(o), String(h), String(l), String(c), "1", openTime + ms - 1, 0, 0, 0, "0", 0];
}

/** Drive the shared monitor with a canned fetch, answered per URL. */
function monitorWith(handler: (url: string) => KlineRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({ ok: true, json: async () => handler(url) }) as Response),
  );
  return () => vi.unstubAllGlobals();
}

function hammer(interval: string, openTime: number, o = 100, drift = 0): KlineRow {
  // body 1, tail 4.5, upper 0.3 — the reference shape
  return kline(interval, openTime, o, o + 1 + 0.3, o - 4.5, o + 1 + drift);
}

describe("wickMonitor — closed candles only, once each", () => {
  afterEach(() => {
    wickMonitor.stop();
    wickMonitor.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits a signal only when a new qualifying candle closes, and never repeats it", async () => {
    const m15 = 900_000;
    const base = Date.now(); // candle times are fixed — no clock drift between sweeps
    const t = (n: number) => base - n * m15;
    let calls15m = 0;
    const cleanup = monitorWith((url) => {
      const interval = new URL(url).searchParams.get("interval")!;
      if (interval !== "15m") return [hammer(interval, t(3))]; // other TFs: static baseline
      calls15m++;
      if (calls15m === 1) return [hammer("15m", t(3)), hammer("15m", t(2))]; // history
      return [hammer("15m", t(3)), hammer("15m", t(2)), hammer("15m", t(1))]; // fresh close
    });

    wickMonitor.setSymbols(["BTCUSDT"]);
    await wickMonitor.tick(); // baseline — no emission
    expect(wickMonitor.snapshot().signals).toHaveLength(0);
    await wickMonitor.tick(); // the fresh 15m close
    const signals = wickMonitor.snapshot().signals;
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ symbol: "BTCUSDT", interval: "15m", close: 101 });
    await wickMonitor.tick(); // same data again — no repeat
    expect(wickMonitor.snapshot().signals).toHaveLength(1);
    cleanup();
  });

  it("never emits history on first sight and ignores red candles", async () => {
    const m15 = 900_000;
    const base = Date.now();
    const t = (n: number) => base - n * m15;
    const cleanup = monitorWith((url) => {
      const interval = new URL(url).searchParams.get("interval")!;
      return interval === "15m"
        ? [kline("15m", t(2), 100, 100.3, 95.5, 99.9)] // closed but red
        : [hammer(interval, t(3))];
    });

    wickMonitor.setSymbols(["ETHUSDT"]);
    await wickMonitor.tick();
    await wickMonitor.tick();
    expect(wickMonitor.snapshot().signals).toHaveLength(0);
    cleanup();
  });

  it("reports blocked after repeated failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("cors"); }));
    wickMonitor.setSymbols(["XRPUSDT"]);
    // 3 requests per tick × 4 ticks = 12 consecutive failures → blocked
    for (let i = 0; i < 5; i++) await wickMonitor.tick();
    expect(wickMonitor.snapshot().status).toBe("blocked");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
