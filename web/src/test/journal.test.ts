import { describe, expect, it } from "vitest";

import {
  buildMonthGrid,
  dayKey,
  dayKeyOf,
  daysInMonth,
  entriesInMonth,
  entriesInYear,
  groupByDay,
  monthCurve,
  monthLabel,
  monthSummary,
  netByDay,
  parseDayKey,
  shiftMonth,
  statsFor,
  type JournalEntry,
} from "@/lib/journal";

let seq = 0;
function entry(date: string, amount: number, tag?: string): JournalEntry {
  seq += 1;
  return { id: `e${seq}`, date, amount, tag, createdAt: seq };
}

describe("day keys", () => {
  it("pads month and day", () => {
    expect(dayKey(2026, 0, 5)).toBe("2026-01-05");
    expect(dayKey(2026, 11, 31)).toBe("2026-12-31");
  });

  it("uses local calendar parts, never UTC", () => {
    // 23:30 local on the 1st must stay the 1st even when UTC has rolled over.
    expect(dayKeyOf(new Date(2026, 7, 1, 23, 30))).toBe("2026-08-01");
    expect(dayKeyOf(new Date(2026, 7, 1, 0, 15))).toBe("2026-08-01");
  });

  it("round-trips through parseDayKey", () => {
    expect(parseDayKey("2026-08-04")).toEqual({ year: 2026, month: 7, day: 4 });
    expect(parseDayKey("garbage")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
  });

  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 3)).toBe(30);
    expect(daysInMonth(2026, 0)).toBe(31);
  });

  it("rolls the year over when shifting months", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 5, 12)).toEqual({ year: 2027, month: 5 });
  });

  it("labels months", () => {
    expect(monthLabel(2026, 7)).toBe("August 2026");
  });
});

describe("buildMonthGrid", () => {
  it("emits whole Monday-first weeks", () => {
    const weeks = buildMonthGrid(2026, 7);
    for (const w of weeks) expect(w).toHaveLength(7);
    expect(weeks.flat().length % 7).toBe(0);
  });

  it("places the 1st under the right weekday", () => {
    // 1 Aug 2026 is a Saturday -> index 5 in a Monday-first week.
    const first = buildMonthGrid(2026, 7).flat().findIndex((c) => c.inMonth);
    expect(first).toBe(5);
  });

  it("covers every day of the month exactly once", () => {
    const cells = buildMonthGrid(2026, 1).flat().filter((c) => c.inMonth);
    expect(cells).toHaveLength(28);
    expect(new Set(cells.map((c) => c.key)).size).toBe(28);
    expect(cells[0].key).toBe("2026-02-01");
    expect(cells[27].key).toBe("2026-02-28");
  });

  it("borrows leading days from the previous month with correct keys", () => {
    const lead = buildMonthGrid(2026, 7).flat().filter((c) => !c.inMonth);
    expect(lead[0].key).toBe("2026-07-27");
  });

  it("handles a month that starts on a Monday with no lead cells", () => {
    // 1 Jun 2026 is a Monday.
    expect(buildMonthGrid(2026, 5).flat()[0].key).toBe("2026-06-01");
  });
});

describe("statsFor", () => {
  const set = [
    entry("2026-08-03", 400),
    entry("2026-08-03", -150),
    entry("2026-08-05", 250),
    entry("2026-08-07", -600),
    entry("2026-08-09", 0),
  ];

  it("splits gross profit and gross loss as positive magnitudes", () => {
    const s = statsFor(set);
    expect(s.grossProfit).toBe(650);
    expect(s.grossLoss).toBe(750);
    expect(s.net).toBe(-100);
  });

  it("computes win rate on decided trades only", () => {
    const s = statsFor(set);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.scratches).toBe(1);
    expect(s.trades).toBe(5);
    expect(s.winRatePct).toBeCloseTo(50, 10);
  });

  it("computes averages, profit factor and extremes", () => {
    const s = statsFor(set);
    expect(s.averageWin).toBeCloseTo(325, 10);
    expect(s.averageLoss).toBeCloseTo(375, 10);
    expect(s.profitFactor).toBeCloseTo(650 / 750, 10);
    expect(s.bestTrade).toBe(400);
    expect(s.worstTrade).toBe(600);
  });

  it("returns a null profit factor when nothing was lost", () => {
    expect(statsFor([entry("2026-08-01", 100)]).profitFactor).toBeNull();
  });

  it("is empty-safe", () => {
    const s = statsFor([]);
    expect(s).toMatchObject({ grossProfit: 0, grossLoss: 0, net: 0, winRatePct: 0, trades: 0 });
    expect(s.profitFactor).toBeNull();
  });

  it("ignores non-finite amounts", () => {
    const s = statsFor([entry("2026-08-01", 100), entry("2026-08-01", Number.NaN)]);
    expect(s.trades).toBe(1);
    expect(s.net).toBe(100);
  });

  it("nets to the exact sum of its inputs", () => {
    const amounts = [12.34, -5.67, 900.01, -0.99, 42];
    const s = statsFor(amounts.map((a, i) => entry(`2026-08-${String(i + 1).padStart(2, "0")}`, a)));
    expect(s.net).toBeCloseTo(
      amounts.reduce((x, y) => x + y, 0),
      8,
    );
  });
});

describe("grouping", () => {
  const set = [entry("2026-08-03", 400, "BTC"), entry("2026-08-03", -150), entry("2026-08-05", 250)];

  it("groups by day preserving order", () => {
    const g = groupByDay(set);
    expect(g.get("2026-08-03")).toHaveLength(2);
    expect(g.get("2026-08-03")?.[0].tag).toBe("BTC");
    expect(g.get("2026-08-05")).toHaveLength(1);
  });

  it("nets by day", () => {
    const n = netByDay(set);
    expect(n.get("2026-08-03")).toBe(250);
    expect(n.get("2026-08-05")).toBe(250);
    expect(n.get("2026-08-04")).toBeUndefined();
  });

  it("scopes entries to a month and a year without touching neighbours", () => {
    const wide = [...set, entry("2026-09-01", 999), entry("2025-08-03", 111)];
    expect(entriesInMonth(wide, 2026, 7)).toHaveLength(3);
    expect(entriesInMonth(wide, 2026, 8)).toHaveLength(1);
    expect(entriesInYear(wide, 2026)).toHaveLength(4);
    expect(entriesInYear(wide, 2025)).toHaveLength(1);
  });
});

describe("monthSummary", () => {
  const set = [
    entry("2026-08-03", 400),
    entry("2026-08-03", -150), // day nets +250 -> green
    entry("2026-08-05", -600), // red
    entry("2026-08-07", 250), // green
    entry("2026-09-01", 10_000), // different month, must not leak
  ];

  it("aggregates only the requested month", () => {
    const s = monthSummary(set, 2026, 7);
    expect(s.grossProfit).toBe(650);
    expect(s.grossLoss).toBe(750);
    expect(s.net).toBe(-100);
    expect(s.trades).toBe(4);
  });

  it("counts day colours from the day net, not from single trades", () => {
    const s = monthSummary(set, 2026, 7);
    expect(s.activeDays).toBe(3);
    expect(s.greenDays).toBe(2);
    expect(s.redDays).toBe(1);
    expect(s.bestDay).toBe(250);
    expect(s.worstDay).toBe(600);
  });

  it("is zeroed for an empty month", () => {
    const s = monthSummary(set, 2026, 0);
    expect(s.trades).toBe(0);
    expect(s.net).toBe(0);
    expect(s.activeDays).toBe(0);
  });
});

describe("monthCurve", () => {
  it("emits one point per calendar day and accumulates", () => {
    const c = monthCurve([entry("2026-08-02", 100), entry("2026-08-04", -30)], 2026, 7);
    expect(c).toHaveLength(31);
    expect(c[0]).toMatchObject({ day: 1, net: 0, cumulative: 0 });
    expect(c[1]).toMatchObject({ day: 2, net: 100, cumulative: 100 });
    expect(c[2].cumulative).toBe(100);
    expect(c[3]).toMatchObject({ day: 4, net: -30, cumulative: 70 });
    expect(c[30].cumulative).toBe(70);
  });

  it("ends on the month net", () => {
    const set = [entry("2026-02-01", 12.5), entry("2026-02-28", -4.25)];
    const c = monthCurve(set, 2026, 1);
    expect(c).toHaveLength(28);
    expect(c[c.length - 1].cumulative).toBeCloseTo(monthSummary(set, 2026, 1).net, 10);
  });
});
