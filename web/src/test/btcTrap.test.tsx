import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BtcTrapTable } from "@/components/BtcTrapTable";
import { fmtClock } from "@/lib/format";
import {
  appendTrapRow,
  BTC_TRAP_MAX_ROWS,
  BTC_TRAP_SYMBOL,
  liveTrapState,
  observeBtcTrap,
  observeTrap,
  sanitizeTrapRows,
  stepTrapWatch,
  type BtcTrapRow,
} from "@/lib/wick/btcTrap";
import { evaluateExhaustion } from "@/lib/wick/exhaustion";
import { WickFeed } from "@/lib/wick/feed";
import { DEFAULT_WICK_RULES } from "@/lib/wick/rules";
import type { ExhaustionRead, Kline, TickerTick, VolumeRead, WickRules } from "@/lib/wick/types";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_700_000_000_000;

/* ------------------------------------------------------------------ */
/* Fixtures — real engine reads, so the watch sees what the UI sees    */
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

/** 18 identical bars: nothing in them extends the range. */
function flat(count = 18): Kline[] {
  return Array.from({ length: count }, (_, i) => candle(T - (count - i) * 5 * MIN, 99, 101));
}

const NO_HIGHER_HIGH = flat();
const TRAP_60 = [...flat(), candle(T, 99, 110, 0.6)];
const TRAP_72 = [...flat(), candle(T, 99, 110, 0.72)];
/** A new high that closed near its top: continuation, gate 3 waiting. */
const HELD = [...flat(), candle(T, 99, 110, 0.1)];

const VOLUME: VolumeRead = {
  quoteVolume24h: 5e9,
  trades24h: 1e6,
  rvol: 100,
  spike: false,
  acceleration: 0,
  precise: true,
};

function tick(symbol: string): TickerTick {
  return { symbol, last: 105, open: 100, high: 110, low: 95, vwap24h: 102, quoteVolume: 5e9, trades: 1e6, at: T };
}

function read(
  at: number,
  klines?: Kline[],
  symbol: string = BTC_TRAP_SYMBOL,
  rules: WickRules = DEFAULT_WICK_RULES,
): ExhaustionRead {
  return evaluateExhaustion({ symbol, ticker: tick(symbol), volume: VOLUME, klines, rules, at });
}

function scan(...reads: ExhaustionRead[]): Map<string, ExhaustionRead> {
  return new Map(reads.map((r) => [r.symbol, r]));
}

/** Drives the watch exactly the way the provider does, one scan at a time. */
function watch(scans: Map<string, ExhaustionRead>[]): BtcTrapRow[] {
  let prev: boolean | undefined;
  let rows: BtcTrapRow[] = [];
  scans.forEach((s, i) => {
    const step = stepTrapWatch(prev, observeBtcTrap(s));
    prev = step.passed;
    if (step.row) rows = appendTrapRow(rows, { id: `row-${i}`, ...step.row });
  });
  return rows;
}

function trapDetail(r: ExhaustionRead): string | undefined {
  return r.gates.find((g) => g.key === "trap")?.detail;
}

/* ------------------------------------------------------------------ */
/* Edge detection                                                      */
/* ------------------------------------------------------------------ */

describe("BTCUSDT failed-breakout watch", () => {
  it("watches the gate the table is named after", () => {
    expect(trapDetail(read(T, NO_HIGHER_HIGH))).toBe("No higher high in the last 3 bars");
    expect(observeTrap(read(T, NO_HIGHER_HIGH))).toMatchObject({ measured: true, passed: false });
    expect(observeTrap(read(T, TRAP_60))).toMatchObject({ measured: true, passed: true });
  });

  it("adds a row only on the switch from waiting to pass", () => {
    const rows = watch([
      scan(read(T, NO_HIGHER_HIGH)),
      scan(read(T + 2_000, NO_HIGHER_HIGH)),
      scan(read(T + 4_000, TRAP_60)),
      scan(read(T + 6_000, TRAP_60)),
      scan(read(T + 8_000, TRAP_60)),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(T + 4_000);
    expect(rows[0].wickPct).toBeCloseTo(60, 6);
  });

  it("logs every fresh switch, newest first, whatever the waiting reason was", () => {
    const rows = watch([
      scan(read(T, NO_HIGHER_HIGH)),
      scan(read(T + 2_000, TRAP_60)),
      scan(read(T + 4_000, HELD)),
      scan(read(T + 6_000, TRAP_72)),
    ]);

    expect(trapDetail(read(T, HELD))).toMatch(/^Higher high held/);
    expect(rows.map((r) => r.at)).toEqual([T + 6_000, T + 2_000]);
    expect(rows[0].wickPct).toBeCloseTo(72, 6);
    expect(rows[1].wickPct).toBeCloseTo(60, 6);
  });

  it("does not log a pass that was already showing when the watch started", () => {
    expect(watch([scan(read(T, TRAP_60)), scan(read(T + 2_000, TRAP_60))])).toHaveLength(0);

    const later = watch([
      scan(read(T, TRAP_60)),
      scan(read(T + 2_000, NO_HIGHER_HIGH)),
      scan(read(T + 4_000, TRAP_72)),
    ]);
    expect(later).toHaveLength(1);
    expect(later[0].at).toBe(T + 4_000);
  });

  it("treats missing history as no information, never as a state change", () => {
    // Loading history is not a market event: "no data" -> pass is a baseline.
    expect(watch([scan(), scan(read(T, undefined)), scan(read(T + 2_000, TRAP_60))])).toHaveLength(0);

    // A gap cannot create a switch...
    expect(
      watch([scan(read(T, TRAP_60)), scan(read(T + 2_000, undefined)), scan(), scan(read(T + 4_000, TRAP_60))]),
    ).toHaveLength(0);

    // ...and cannot swallow one.
    const across = watch([scan(read(T, NO_HIGHER_HIGH)), scan(), scan(read(T + 4_000, TRAP_60))]);
    expect(across).toHaveLength(1);
    expect(across[0].at).toBe(T + 4_000);
  });

  it("ignores every other contract", () => {
    const rows = watch([
      scan(read(T, NO_HIGHER_HIGH), read(T, NO_HIGHER_HIGH, "ETHUSDT")),
      scan(read(T + 2_000, NO_HIGHER_HIGH), read(T + 2_000, TRAP_60, "ETHUSDT")),
      scan(read(T + 4_000, NO_HIGHER_HIGH), read(T + 4_000, TRAP_72, "SOLUSDT")),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("does not log a flip caused by moving the wick threshold", () => {
    const strict: WickRules = { ...DEFAULT_WICK_RULES, wickPct: 70 };
    // A 60% wick waits under a 70% threshold.
    const baseline = stepTrapWatch(undefined, observeBtcTrap(scan(read(T, TRAP_60, BTC_TRAP_SYMBOL, strict))));
    expect(baseline).toEqual({ passed: false });

    // Same candle after the threshold drops to 45%. Carried over blindly, this
    // would read as a switch...
    const next = observeBtcTrap(scan(read(T + 2_000, TRAP_60)));
    expect(stepTrapWatch(baseline.passed, next).row).toBeDefined();

    // ...so the provider restarts the baseline at the change, and it is not one.
    const changedAt = T + 1_000;
    expect(stepTrapWatch(undefined, next, changedAt)).toEqual({ passed: true });

    // A read scored before the change is ignored outright.
    const stale = observeBtcTrap(scan(read(T, TRAP_60)));
    expect(stepTrapWatch(false, stale, changedAt)).toEqual({ passed: false });
  });

  it("skips a pass that carries no wick reading", () => {
    expect(stepTrapWatch(false, { measured: true, passed: true, at: T })).toEqual({ passed: true });
  });

  it("reports the live state in the gate list's own words", () => {
    expect(liveTrapState(undefined)).toBe("idle");
    expect(liveTrapState(observeTrap(read(T, undefined)))).toBe("idle");
    expect(liveTrapState(observeTrap(read(T, NO_HIGHER_HIGH)))).toBe("waiting");
    expect(liveTrapState(observeTrap(read(T, TRAP_60)))).toBe("pass");
  });
});

/* ------------------------------------------------------------------ */
/* Stored log                                                          */
/* ------------------------------------------------------------------ */

describe("BTCUSDT failed-breakout log storage", () => {
  it("keeps the newest rows up to the cap", () => {
    let rows: BtcTrapRow[] = [];
    for (let i = 0; i < BTC_TRAP_MAX_ROWS + 5; i += 1) {
      rows = appendTrapRow(rows, { id: `r${i}`, at: T + i, wickPct: 50 });
    }
    expect(rows).toHaveLength(BTC_TRAP_MAX_ROWS);
    expect(rows[0].id).toBe(`r${BTC_TRAP_MAX_ROWS + 4}`);
  });

  it("restores a saved log and drops anything malformed", () => {
    const restored = sanitizeTrapRows([
      { id: "old", at: T, wickPct: 51.5 },
      { id: "new", at: T + 5_000, wickPct: 140 },
      { id: "no-wick", at: T + 1 },
      { id: "bad-time", at: -1, wickPct: 60 },
      { at: T + 2_000, wickPct: Number.NaN },
      "junk",
      null,
    ]);

    expect(restored.map((r) => r.id)).toEqual(["new", "old"]);
    expect(restored[0].wickPct).toBe(100);
    expect(sanitizeTrapRows({ rows: [] })).toEqual([]);
    expect(sanitizeTrapRows(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Fresh candles                                                       */
/* ------------------------------------------------------------------ */

describe("BTCUSDT candles stay fresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      }),
    );
    return urls;
  }

  const btc5m = (u: string) => u.includes(`symbol=${BTC_TRAP_SYMBOL}&interval=5m`);

  /**
   * Each kline load asks for 5m bars, then daily bars. Waiting for the daily
   * requests means no load can outlive the stub and reach the real network.
   */
  async function drained(urls: string[], loads: number): Promise<void> {
    await vi.waitFor(() => expect(urls.filter((u) => u.includes("interval=1d"))).toHaveLength(loads));
  }

  it("refreshes BTCUSDT candles while another contract is focused", async () => {
    const urls = stubFetch();
    const feed = new WickFeed({ alwaysFresh: [BTC_TRAP_SYMBOL] });
    await feed.refreshNow("ETHUSDT");
    expect(urls.some(btc5m)).toBe(true);
    expect(urls.some((u) => u.includes("symbol=ETHUSDT&interval=5m"))).toBe(true);
  });

  it("includes BTCUSDT on the periodic refresh clock", async () => {
    const urls = stubFetch();
    const feed = new WickFeed({ alwaysFresh: [BTC_TRAP_SYMBOL] });
    feed.refreshDeep();
    await drained(urls, 1);
    expect(urls.some(btc5m)).toBe(true);
  });

  it("does not take one of the scanner's history slots", async () => {
    const urls = stubFetch();
    const feed = new WickFeed({ alwaysFresh: [BTC_TRAP_SYMBOL] });
    feed.setDeepWatch(["ETHUSDT", "SOLUSDT"]);
    expect(feed.status().deepCount).toBe(2);
    await drained(urls, 2);
  });

  it("is what keeps an unfocused BTCUSDT loaded", async () => {
    const urls = stubFetch();
    const feed = new WickFeed();
    await feed.refreshNow("ETHUSDT");
    expect(urls.some(btc5m)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

describe("BTCUSDT failed-breakout table", () => {
  const NOW = new Date(2026, 8, 22, 15, 0, 0).getTime();

  it("shows one row per logged pass with its time and rejection wick", () => {
    const rows: BtcTrapRow[] = [
      { id: "b", at: NOW - MIN, wickPct: 61.24 },
      { id: "a", at: NOW - 3 * DAY, wickPct: 48 },
    ];
    const html = renderToStaticMarkup(
      <BtcTrapTable rows={rows} live="pass" onClear={() => undefined} now={NOW} />,
    );

    expect(html).toContain("Passed at");
    expect(html).toContain("Rejection wick");
    expect(html).toContain(fmtClock(NOW - MIN));
    expect(html).toContain("61.2%");
    expect(html).toContain("48.0%");
    // Older rows carry their day; today's show the time alone.
    expect(html).toContain(new Date(NOW - 3 * DAY).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
    expect(html.match(/<tr[\s>]/g) ?? []).toHaveLength(3);
  });

  it("shows an empty state until the first pass", () => {
    const html = renderToStaticMarkup(<BtcTrapTable rows={[]} live="waiting" onClear={() => undefined} now={NOW} />);
    expect(html).toContain("No passes logged yet");
    expect(html).toContain("waiting");
    expect(html).not.toContain("<table");
  });
});
