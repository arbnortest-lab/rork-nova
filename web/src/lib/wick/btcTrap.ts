/**
 * BTCUSDT failed-breakout log.
 *
 * A small watch on ONE gate of ONE contract: gate 3, "Failed breakout trap",
 * on BTCUSDT. It adds a row only at the moment that gate switches from
 * waiting to passed — never on every scan while it stays passed — and records
 * when that happened and the rejection wick at that moment.
 *
 * It reads the same `ExhaustionRead` the focus panel renders, so a row always
 * matches what the gate list showed. It never feeds back into the engine:
 * nothing here can arm, alert or re-rank anything.
 *
 * Everything here is pure, so the edge detector is testable without a socket.
 */

import type { ExhaustionRead } from "./types";

/** The only contract this log watches. */
export const BTC_TRAP_SYMBOL = "BTCUSDT";
/** Rows kept, newest first. */
export const BTC_TRAP_MAX_ROWS = 50;
/** Storage key for the log (the storage module adds its own prefix). */
export const BTC_TRAP_STORAGE_KEY = "wick-btc-trap-log";

/** One logged switch to pass. */
export interface BtcTrapRow {
  id: string;
  /** Scan time at which the gate was first reported as passed, epoch ms. */
  at: number;
  /** Rejection wick at that moment, as a percent of the candle's range. */
  wickPct: number;
}

/** Gate 3 of one read, reduced to what the log needs. */
export interface TrapObservation {
  /** False until kline history is attached. An unmeasured gate is not a state. */
  measured: boolean;
  passed: boolean;
  wickPct?: number;
  /** Scan time of the read, epoch ms. */
  at: number;
}

/** Gate 3's state in the gate list's own words: no data, waiting or pass. */
export type BtcTrapLive = "idle" | "waiting" | "pass";

/** Pulls gate 3 out of a read. Undefined when there is no read yet. */
export function observeTrap(read: ExhaustionRead | undefined): TrapObservation | undefined {
  if (!read) return undefined;
  const gate = read.gates.find((g) => g.key === "trap");
  if (!gate) return undefined;
  return { measured: gate.measured, passed: gate.passed, wickPct: read.wickPct, at: read.at };
}

/** BTCUSDT's gate 3 out of a whole scan. Every other contract is ignored. */
export function observeBtcTrap(
  bySymbol: ReadonlyMap<string, ExhaustionRead>,
): TrapObservation | undefined {
  return observeTrap(bySymbol.get(BTC_TRAP_SYMBOL));
}

/** Matches the gate list: "no data" until measured, then waiting or pass. */
export function liveTrapState(obs: TrapObservation | undefined): BtcTrapLive {
  if (!obs || !obs.measured) return "idle";
  return obs.passed ? "pass" : "waiting";
}

/** Result of stepping the watch through one scan. */
export interface TrapStep {
  /** Last measured state, carried into the next scan. */
  passed: boolean | undefined;
  /** Present only on a genuine switch from waiting to passed. */
  row?: Omit<BtcTrapRow, "id">;
}

/**
 * Edge detector for the log. Feed it every scan; it returns a row only when
 * the gate goes from waiting to passed.
 *
 * - A missing or unmeasured read carries no information. It leaves the last
 *   known state in place, so a gap in the data can neither log a switch nor
 *   swallow one.
 * - The first measured read only sets the baseline. A gate that was already
 *   passing when the watch started was never seen switching, and logging it
 *   would stamp an older trap with the wrong time.
 * - A read scored before `notBefore` is ignored. The caller moves it forward
 *   when the wick threshold changes: a threshold edit can flip the gate with
 *   no market event behind it, so reads scored under the old threshold must
 *   not count.
 */
export function stepTrapWatch(
  prev: boolean | undefined,
  obs: TrapObservation | undefined,
  notBefore = 0,
): TrapStep {
  if (!obs || !obs.measured || obs.at < notBefore) return { passed: prev };
  // Only waiting -> passed is a switch. A baseline or a pass that is still
  // holding just carries the state forward.
  if (prev !== false || !obs.passed) return { passed: obs.passed };

  const wickPct = obs.wickPct;
  if (wickPct === undefined || !Number.isFinite(wickPct)) return { passed: true };
  return { passed: true, row: { at: obs.at, wickPct } };
}

/** Adds a row at the top and trims the log to its cap. */
export function appendTrapRow(rows: readonly BtcTrapRow[], row: BtcTrapRow): BtcTrapRow[] {
  return [row, ...rows].slice(0, BTC_TRAP_MAX_ROWS);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Restores a saved log. Anything malformed is dropped rather than repaired, so
 * a hand-edited or older entry can never put a bogus row on screen.
 */
export function sanitizeTrapRows(raw: unknown): BtcTrapRow[] {
  if (!Array.isArray(raw)) return [];
  const out: BtcTrapRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const at = finite(r.at);
    const wickPct = finite(r.wickPct);
    if (at === undefined || at <= 0 || wickPct === undefined) continue;
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : `row-${at}`,
      at,
      wickPct: Math.min(100, Math.max(0, wickPct)),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, BTC_TRAP_MAX_ROWS);
}
