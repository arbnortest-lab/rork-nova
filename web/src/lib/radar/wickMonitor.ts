/**
 * Independent lower-wick monitor — additive, reads nothing but public REST.
 *
 * Watches every tracked contract on 15m, 1h and 4h, polling
 * /fapi/v1/klines on a staggered round-robin so the full sweep costs a few
 * requests per second at most. A signal is emitted only when a candle has
 * FULLY closed (venue close time in the past) and passes the shape test in
 * `wickSignal.ts`. Each symbol+timeframe keeps a watermark of the newest
 * closed candle it has seen, so history never floods the table and every
 * candle is reported exactly once.
 *
 * The monitor shares no state or code path with the engine, the radar
 * sockets or the chart: if REST is blocked it simply reports `blocked` and
 * retries quietly.
 */

import {
  INTERVAL_MS,
  MONITOR_INTERVALS,
  WICK_SIGNALS_KEPT,
  lowerWickSignal,
  type LowerWickSignal,
  type MonitorInterval,
} from "./wickSignal";

const KLINE_URL = "https://fapi.binance.com/fapi/v1/klines";

/** One sweep tick every 20 s, this many requests per tick, staggered. */
const TICK_MS = 20_000;
const REQUESTS_PER_TICK = 24;
const REQUEST_STAGGER_MS = 200;
/** After this many consecutive failures, cool down before retrying. */
const FAILURE_LIMIT = 12;
const COOLDOWN_MS = 60_000;

/** One kline row: [openTime, o, h, l, c, volume, closeTime, …]. */
type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export interface WickMonitorState {
  signals: LowerWickSignal[];
  /** idle = no symbols yet, polling = sweeping, blocked = REST unreachable. */
  status: "idle" | "polling" | "blocked";
  symbols: number;
  lastPollAt: number;
}

type Listener = (state: WickMonitorState) => void;

class WickMonitor {
  private symbols: string[] = [];
  private items: { symbol: string; interval: MonitorInterval }[] = [];
  /** Newest closed candle open-time already handled, per symbol:interval. */
  private watermark = new Map<string, number>();
  private signals: LowerWickSignal[] = [];
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor = 0;
  private failures = 0;
  private blockedUntil = 0;
  private lastPollAt = 0;
  private status: WickMonitorState["status"] = "idle";

  setSymbols(symbols: string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.length === this.symbols.length && next.every((s, i) => s === this.symbols[i])) return;
    this.symbols = next;
    this.items = next.flatMap((symbol) => MONITOR_INTERVALS.map((interval) => ({ symbol, interval })));
    this.cursor = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): WickMonitorState {
    return {
      signals: this.signals,
      status: this.status,
      symbols: this.symbols.length,
      lastPollAt: this.lastPollAt,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Clear signals, watermarks and failure state (used by tests). */
  reset(): void {
    this.watermark.clear();
    this.signals = [];
    this.failures = 0;
    this.blockedUntil = 0;
    this.status = "idle";
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  /** One sweep: the next batch of requests, settled before it returns. */
  async tick(): Promise<void> {
    if (!this.items.length || Date.now() < this.blockedUntil) return;
    const batch: typeof this.items = [];
    for (let i = 0; i < Math.min(REQUESTS_PER_TICK, this.items.length); i++) {
      batch.push(this.items[this.cursor % this.items.length]);
      this.cursor++;
    }
    await Promise.all(
      batch.map(
        (item, i) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              this.poll(item.symbol, item.interval).then(resolve);
            }, i * REQUEST_STAGGER_MS);
          }),
      ),
    );
  }

  private async poll(symbol: string, interval: MonitorInterval): Promise<void> {
    const url = `${KLINE_URL}?symbol=${symbol}&interval=${interval}&limit=3`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as KlineRow[];
      this.failures = 0;
      if (this.status !== "polling") {
        this.status = "polling";
        this.emit();
      }
      this.absorb(symbol, interval, rows);
    } catch {
      this.failures++;
      this.lastPollAt = Date.now();
      if (this.failures >= FAILURE_LIMIT) {
        this.status = "blocked";
        this.blockedUntil = Date.now() + COOLDOWN_MS;
        this.failures = 0;
        this.emit();
      }
    }
  }

  /** Fold freshly fetched klines into the watermark and the signal list. */
  private absorb(symbol: string, interval: MonitorInterval, rows: KlineRow[]): void {
    const key = `${symbol}:${interval}`;
    const now = Date.now();
    const closed = rows
      .map((r) => ({ openTime: r[0], closeTime: r[6], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }))
      .filter((k) => Number.isFinite(k.o) && k.closeTime < now) // fully closed only
      .sort((a, b) => a.openTime - b.openTime);
    if (!closed.length) return;

    const mark = this.watermark.get(key);
    if (mark === undefined) {
      // First sight: baseline the history without emitting.
      this.watermark.set(key, closed[closed.length - 1].openTime);
      return;
    }
    const fresh: LowerWickSignal[] = [];
    let newest = mark;
    for (const k of closed) {
      if (k.openTime <= mark) continue;
      const signal = lowerWickSignal(symbol, interval, k.openTime, k.closeTime, k.o, k.h, k.l, k.c);
      if (signal) fresh.push(signal);
      newest = Math.max(newest, k.openTime);
    }
    if (newest !== mark) this.watermark.set(key, newest);
    if (fresh.length) {
      this.signals = [...fresh, ...this.signals].slice(0, WICK_SIGNALS_KEPT);
      this.emit();
    }
  }
}

/** Shared monitor for the radar's signal table. */
export const wickMonitor = new WickMonitor();

/** Interval length, for labels and tests. */
export function monitorIntervalMs(interval: MonitorInterval): number {
  return INTERVAL_MS[interval];
}
