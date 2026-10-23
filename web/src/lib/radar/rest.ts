/**
 * Squeeze Radar REST — the three slices the socket cannot carry.
 *
 *   /fapi/v1/klines                 chart history for the focused contract
 *   /futures/data/openInterestHist  5-minute open-interest snapshots
 *   /fapi/v1/openInterest           the live open-interest figure
 *
 * Same venue as the socket, called straight from the browser like the macro
 * layer's tier-2 history. Every call is bounded by a timeout and reports
 * failure as a thrown error the caller turns into a "—" readout, never into a
 * substitute number.
 */

import type { OiPoint } from "@/lib/wick/types";

import type { ChartBar, ChartInterval } from "./types";

const REST = "https://fapi.binance.com";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function getJson<T>(path: string, timeoutMs = 12_000): Promise<T> {
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

/** Chart history, oldest first. The last bar is the one still in progress. */
export async function fetchChartBars(symbol: string, interval: ChartInterval, limit = 300): Promise<ChartBar[]> {
  const rows = await getJson<unknown>(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!Array.isArray(rows)) return [];
  const out: ChartBar[] = [];
  const now = Date.now();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const time = num(row[0]);
    const closeTime = num(row[6]);
    out.push({
      time,
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
      quoteVolume: num(row[7]),
      closed: closeTime > 0 && closeTime < now,
    });
  }
  return out;
}

/** 5-minute open-interest snapshots, oldest first. 36 points cover three hours. */
export async function fetchOiHistory(symbol: string, limit = 36): Promise<OiPoint[]> {
  const rows = await getJson<unknown>(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=${limit}`);
  if (!Array.isArray(rows)) return [];
  const out: OiPoint[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const at = num(row.timestamp);
    const openInterest = num(row.sumOpenInterest);
    if (at <= 0 || openInterest <= 0) continue;
    const notional = num(row.sumOpenInterestValue);
    out.push({ at, openInterest, notional: notional > 0 ? notional : undefined });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The live open-interest figure, in contracts. */
export async function fetchOiLive(symbol: string): Promise<OiPoint | undefined> {
  const row = await getJson<unknown>(`/fapi/v1/openInterest?symbol=${symbol}`);
  if (!isRecord(row)) return undefined;
  const openInterest = num(row.openInterest);
  if (openInterest <= 0) return undefined;
  return { at: num(row.time) || Date.now(), openInterest };
}
