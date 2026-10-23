/**
 * Nova DCA Pro — realized P&L journal.
 *
 * Pure calendar + aggregation math for the PnL calendar. No React, no I/O.
 *
 * Day keys are plain `YYYY-MM-DD` strings built from **local** calendar parts.
 * `Date.toISOString()` is never used: it shifts to UTC and would move trades
 * logged late at night into the wrong day.
 */

export interface JournalEntry {
  id: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Realized result in quote currency. Positive = profit, negative = loss. */
  amount: number;
  /** Optional instrument or free-text tag. */
  tag?: string;
  createdAt: number;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD` from explicit calendar parts (month is 0-based). */
export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** `YYYY-MM-DD` for a Date, using its local calendar parts. */
export function dayKeyOf(date: Date): string {
  return dayKey(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `YYYY-MM` prefix of a day key. */
export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month + 1)}`;
}

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[((month % 12) + 12) % 12]} ${year}`;
}

/** Splits a day key back into calendar parts (month 0-based). */
export function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Moves a year/month cursor by `delta` months, rolling the year over. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

export interface CalendarCell {
  key: string;
  day: number;
  /** False for the leading/trailing days borrowed from adjacent months. */
  inMonth: boolean;
}

/**
 * Week-aligned grid for a month, Monday first.
 * Always whole weeks, so every row has exactly 7 cells.
 */
export function buildMonthGrid(year: number, month: number): CalendarCell[][] {
  const first = new Date(year, month, 1);
  // getDay() is 0=Sun..6=Sat; convert to 0=Mon..6=Sun.
  const lead = (first.getDay() + 6) % 7;
  const total = daysInMonth(year, month);
  const cells: CalendarCell[] = [];

  const prev = shiftMonth(year, month, -1);
  const prevTotal = daysInMonth(prev.year, prev.month);
  for (let i = lead - 1; i >= 0; i -= 1) {
    const day = prevTotal - i;
    cells.push({ key: dayKey(prev.year, prev.month, day), day, inMonth: false });
  }

  for (let day = 1; day <= total; day += 1) {
    cells.push({ key: dayKey(year, month, day), day, inMonth: true });
  }

  const next = shiftMonth(year, month, 1);
  let trail = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ key: dayKey(next.year, next.month, trail), day: trail, inMonth: false });
    trail += 1;
  }

  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export interface PnlStats {
  /** Sum of every winning entry. Always >= 0. */
  grossProfit: number;
  /** Sum of every losing entry as a **positive magnitude**. Always >= 0. */
  grossLoss: number;
  /** grossProfit − grossLoss. */
  net: number;
  /** Winners / (winners + losers) × 100. Zero-amount entries are excluded. */
  winRatePct: number;
  trades: number;
  wins: number;
  losses: number;
  /** Entries logged at exactly zero. */
  scratches: number;
  averageWin: number;
  /** Positive magnitude. */
  averageLoss: number;
  /** grossProfit / grossLoss. `null` when there are no losses. */
  profitFactor: number | null;
  /** Largest single winning entry. */
  bestTrade: number;
  /** Largest single losing entry, as a positive magnitude. */
  worstTrade: number;
}

const EMPTY_STATS: PnlStats = {
  grossProfit: 0,
  grossLoss: 0,
  net: 0,
  winRatePct: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  scratches: 0,
  averageWin: 0,
  averageLoss: 0,
  profitFactor: null,
  bestTrade: 0,
  worstTrade: 0,
};

/** Aggregates any set of entries. Non-finite amounts are ignored. */
export function statsFor(entries: JournalEntry[]): PnlStats {
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let trades = 0;
  let bestTrade = 0;
  let worstTrade = 0;

  for (const e of entries) {
    if (!Number.isFinite(e.amount)) continue;
    trades += 1;
    if (e.amount > 0) {
      grossProfit += e.amount;
      wins += 1;
      if (e.amount > bestTrade) bestTrade = e.amount;
    } else if (e.amount < 0) {
      grossLoss += -e.amount;
      losses += 1;
      if (-e.amount > worstTrade) worstTrade = -e.amount;
    } else {
      scratches += 1;
    }
  }

  if (trades === 0) return { ...EMPTY_STATS };

  const decided = wins + losses;
  return {
    grossProfit,
    grossLoss,
    net: grossProfit - grossLoss,
    winRatePct: decided > 0 ? (wins / decided) * 100 : 0,
    trades,
    wins,
    losses,
    scratches,
    averageWin: wins > 0 ? grossProfit / wins : 0,
    averageLoss: losses > 0 ? grossLoss / losses : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    bestTrade,
    worstTrade,
  };
}

/** Groups entries by day key, preserving input order within each day. */
export function groupByDay(entries: JournalEntry[]): Map<string, JournalEntry[]> {
  const map = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const bucket = map.get(e.date);
    if (bucket) bucket.push(e);
    else map.set(e.date, [e]);
  }
  return map;
}

/** Net realized P&L per day key. */
export function netByDay(entries: JournalEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (!Number.isFinite(e.amount)) continue;
    map.set(e.date, (map.get(e.date) ?? 0) + e.amount);
  }
  return map;
}

export function entriesInMonth(entries: JournalEntry[], year: number, month: number): JournalEntry[] {
  const prefix = `${monthKey(year, month)}-`;
  return entries.filter((e) => e.date.startsWith(prefix));
}

export function entriesInYear(entries: JournalEntry[], year: number): JournalEntry[] {
  const prefix = `${year}-`;
  return entries.filter((e) => e.date.startsWith(prefix));
}

export interface MonthSummary extends PnlStats {
  /** Days that closed net positive. */
  greenDays: number;
  /** Days that closed net negative. */
  redDays: number;
  /** Days with at least one logged entry. */
  activeDays: number;
  /** Net of the single best day. */
  bestDay: number;
  /** Net of the single worst day, as a positive magnitude. */
  worstDay: number;
}

/** Month dashboard: trade-level stats plus day-level colouring counts. */
export function monthSummary(entries: JournalEntry[], year: number, month: number): MonthSummary {
  const scoped = entriesInMonth(entries, year, month);
  const base = statsFor(scoped);
  const perDay = netByDay(scoped);

  let greenDays = 0;
  let redDays = 0;
  let bestDay = 0;
  let worstDay = 0;
  for (const net of perDay.values()) {
    if (net > 0) {
      greenDays += 1;
      if (net > bestDay) bestDay = net;
    } else if (net < 0) {
      redDays += 1;
      if (-net > worstDay) worstDay = -net;
    }
  }

  return { ...base, greenDays, redDays, activeDays: perDay.size, bestDay, worstDay };
}

export interface CurvePoint {
  day: number;
  key: string;
  /** Net realized P&L for that calendar day. */
  net: number;
  /** Running month-to-date total up to and including that day. */
  cumulative: number;
}

/** Day-by-day month curve, including flat days, for the equity sparkline. */
export function monthCurve(entries: JournalEntry[], year: number, month: number): CurvePoint[] {
  const perDay = netByDay(entriesInMonth(entries, year, month));
  const total = daysInMonth(year, month);
  const out: CurvePoint[] = [];
  let cumulative = 0;
  for (let day = 1; day <= total; day += 1) {
    const key = dayKey(year, month, day);
    const net = perDay.get(key) ?? 0;
    cumulative += net;
    out.push({ day, key, net, cumulative });
  }
  return out;
}
