import { ChevronLeft, ChevronRight, Download, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, Metric, Panel, Segmented, Tag } from "@/components/kit";
import { fmtPct, fmtSignedUsd, fmtUsd } from "@/lib/format";
import {
  WEEKDAYS,
  buildMonthGrid,
  dayKeyOf,
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
import { cn } from "@/lib/utils";
import { useAccount } from "@/store/AccountProvider";
import { useJournal } from "@/store/JournalProvider";

type Side = "profit" | "loss";

function longDate(key: string): string {
  const p = parseDayKey(key);
  if (!p) return key;
  return new Date(p.year, p.month, p.day)
    .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
}

/** Month-to-date cumulative curve. One scale, zero baseline, no axes. */
function MonthCurve({ points }: { points: { day: number; cumulative: number }[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.cumulative);
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const span = max - min || 1;
    const x = (i: number) => (i / (points.length - 1)) * 100;
    const y = (v: number) => 100 - ((v - min) / span) * 100;

    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(3)},${y(p.cumulative).toFixed(3)}`).join(" ");
    const zero = y(0);
    return {
      line,
      area: `${line} L100,${zero.toFixed(3)} L0,${zero.toFixed(3)} Z`,
      zero,
      final: values[values.length - 1],
    };
  }, [points]);

  if (!path) return null;
  const positive = path.final >= 0;
  const stroke = positive ? "hsl(var(--pos))" : "hsl(var(--neg))";

  return (
    <div className="relative h-[54px] w-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <line
          x1="0"
          x2="100"
          y1={path.zero}
          y2={path.zero}
          stroke="hsl(var(--line))"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <path d={path.area} fill={stroke} opacity={0.12} />
        <path
          d={path.line}
          fill="none"
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

export default function Journal() {
  const { entries, addEntry, removeEntry, clearDay } = useJournal();
  const { settings } = useAccount();

  const today = useMemo(() => dayKeyOf(new Date()), []);
  const now = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState<{ year: number; month: number }>({
    year: now.getFullYear(),
    month: now.getMonth(),
  });
  const [selected, setSelected] = useState<string>(today);
  const [side, setSide] = useState<Side>("profit");
  const [amountDraft, setAmountDraft] = useState<string>("");
  const [tagDraft, setTagDraft] = useState<string>("");

  const weeks = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const summary = useMemo(() => monthSummary(entries, cursor.year, cursor.month), [entries, cursor]);
  const curve = useMemo(() => monthCurve(entries, cursor.year, cursor.month), [entries, cursor]);
  const perDay = useMemo(() => netByDay(entries), [entries]);
  const byDay = useMemo(() => groupByDay(entries), [entries]);
  const yearStats = useMemo(() => statsFor(entriesInYear(entries, cursor.year)), [entries, cursor.year]);

  const dayEntries = useMemo<JournalEntry[]>(() => byDay.get(selected) ?? [], [byDay, selected]);
  const dayNet = useMemo(() => dayEntries.reduce((s, e) => s + e.amount, 0), [dayEntries]);

  const step = useCallback((delta: number) => {
    setCursor((prev) => shiftMonth(prev.year, prev.month, delta));
  }, []);

  const jumpToday = useCallback(() => {
    const d = new Date();
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(dayKeyOf(d));
  }, []);

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const magnitude = Math.abs(Number.parseFloat(amountDraft.replace(/[$,\s]/g, "")));
      if (!Number.isFinite(magnitude) || magnitude === 0) return;
      addEntry({ date: selected, amount: side === "loss" ? -magnitude : magnitude, tag: tagDraft });
      setAmountDraft("");
      setTagDraft("");
    },
    [addEntry, amountDraft, selected, side, tagDraft],
  );

  const exportCsv = useCallback(() => {
    const rows = entries
      .filter((e) => e.date.startsWith(`${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}`))
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
    const csv = ["date,amount,tag", ...rows.map((r) => `${r.date},${r.amount},"${(r.tag ?? "").replace(/"/g, "'")}"`)].join(
      "\n",
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `nova-pnl-${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [cursor, entries]);

  const netTone = summary.net > 0 ? "pos" : summary.net < 0 ? "neg" : "muted";

  return (
    <div className="animate-fade-in space-y-3 pb-6">
      {/* ---------------- month bar ---------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-px">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous month"
            className="grid h-8 w-8 place-items-center rounded-[3px] border border-input bg-secondary/40 text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
          >
            <ChevronLeft className="h-[14px] w-[14px]" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next month"
            className="grid h-8 w-8 place-items-center rounded-[3px] border border-input bg-secondary/40 text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
          >
            <ChevronRight className="h-[14px] w-[14px]" />
          </button>
        </div>

        <h1 className="num text-[15px] font-semibold uppercase tracking-[0.14em]">
          {monthLabel(cursor.year, cursor.month).split(" ")[0]}{" "}
          <span className="text-muted-foreground">{cursor.year}</span>
        </h1>

        <Tag tone={summary.net > 0 ? "pos" : summary.net < 0 ? "neg" : "muted"}>
          {summary.activeDays} active {summary.activeDays === 1 ? "day" : "days"}
        </Tag>

        <div className="ml-auto flex items-center gap-2">
          <span className="num text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
            {cursor.year} net{" "}
            <span className={cn(yearStats.net > 0 ? "text-pos" : yearStats.net < 0 ? "text-neg" : "text-foreground")}>
              {fmtSignedUsd(yearStats.net, 0)}
            </span>
          </span>
          <Button size="sm" onClick={exportCsv} disabled={summary.trades === 0} title="Export this month as CSV">
            <Download className="h-3 w-3" />
            CSV
          </Button>
          <Button size="sm" onClick={jumpToday}>
            Today
          </Button>
        </div>
      </div>

      {/* ---------------- month dashboard ---------------- */}
      <div className="panel">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-3 sm:grid-cols-4">
          <Metric label="Gross profit" value={fmtUsd(summary.grossProfit, 2)} tone="pos" size="lg" />
          <Metric label="Gross loss" value={fmtUsd(-summary.grossLoss, 2)} tone="neg" size="lg" />
          <Metric
            label="Net P&L"
            value={fmtSignedUsd(summary.net, 2)}
            sub={settings.equity > 0 ? `${fmtPct((summary.net / settings.equity) * 100)} of equity` : undefined}
            tone={netTone}
            size="lg"
          />
          <Metric
            label="Win rate"
            value={summary.wins + summary.losses > 0 ? fmtPct(summary.winRatePct, 1) : "—"}
            sub={`${summary.wins}W / ${summary.losses}L`}
            tone="brand"
            size="lg"
          />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line-soft px-3 py-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Trades" value={String(summary.trades)} size="sm" />
          <Metric label="Green days" value={`${summary.greenDays} / ${summary.activeDays}`} size="sm" tone="pos" />
          <Metric label="Avg win" value={summary.wins > 0 ? fmtUsd(summary.averageWin, 2) : "—"} size="sm" />
          <Metric label="Avg loss" value={summary.losses > 0 ? fmtUsd(-summary.averageLoss, 2) : "—"} size="sm" />
          <Metric
            label="Profit factor"
            value={summary.profitFactor === null ? (summary.grossProfit > 0 ? "∞" : "—") : summary.profitFactor.toFixed(2)}
            size="sm"
            tone={summary.profitFactor !== null && summary.profitFactor >= 1 ? "pos" : "default"}
          />
          <Metric
            label="Best / worst day"
            value={summary.activeDays > 0 ? `${fmtUsd(summary.bestDay, 0)} / ${fmtUsd(-summary.worstDay, 0)}` : "—"}
            size="sm"
          />
        </div>

        {summary.trades > 0 ? (
          <div className="border-t border-line-soft px-3 pb-2 pt-1">
            <div className="lbl mb-1">Month curve</div>
            <MonthCurve points={curve} />
          </div>
        ) : null}
      </div>

      {/* ---------------- calendar + day log ---------------- */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_286px]">
        <div className="panel overflow-hidden">
          <div className="grid grid-cols-7 border-b border-border bg-secondary/40">
            {WEEKDAYS.map((d) => (
              <div key={d} className="lbl px-2 py-[7px] text-center">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-px bg-border">
            {weeks.flat().map((cell) => {
              const net = perDay.get(cell.key) ?? 0;
              const count = byDay.get(cell.key)?.length ?? 0;
              const isSelected = cell.key === selected;
              const isToday = cell.key === today;
              const positive = net > 0;
              const negative = net < 0;

              return (
                <button
                  key={cell.key}
                  type="button"
                  onClick={() => setSelected(cell.key)}
                  className={cn(
                    "group relative flex h-[70px] flex-col items-stretch bg-card px-2 pb-1.5 pt-1.5 text-left transition-colors",
                    !cell.inMonth && "opacity-30",
                    positive && "bg-pos-soft/50",
                    negative && "bg-neg-soft/50",
                    !isSelected && "hover:bg-secondary/60",
                    isSelected && "bg-secondary ring-1 ring-inset ring-primary",
                  )}
                >
                  {positive || negative ? (
                    <span
                      className={cn("absolute left-0 top-0 h-full w-[2px]", positive ? "bg-pos" : "bg-neg")}
                      aria-hidden
                    />
                  ) : null}

                  <div className="flex items-start justify-between">
                    <span
                      className={cn(
                        "num text-[11px] font-medium leading-none",
                        isToday ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {String(cell.day).padStart(2, "0")}
                      {isToday ? <span className="ml-1 animate-blink">●</span> : null}
                    </span>
                    {count > 0 ? (
                      <span className="num text-[9px] leading-none text-muted-foreground">{count}</span>
                    ) : null}
                  </div>

                  {count > 0 ? (
                    <span
                      className={cn(
                        "num mt-auto truncate text-[12.5px] font-semibold leading-none",
                        positive ? "text-pos" : negative ? "text-neg" : "text-muted-foreground",
                      )}
                    >
                      {fmtSignedUsd(net, 0)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* ---------------- day log ---------------- */}
        <Panel
          title={longDate(selected)}
          aside={
            <span
              className={cn(
                "num text-[12px] font-semibold",
                dayNet > 0 ? "text-pos" : dayNet < 0 ? "text-neg" : "text-muted-foreground",
              )}
            >
              {dayEntries.length > 0 ? fmtSignedUsd(dayNet, 2) : "—"}
            </span>
          }
          bodyClassName="space-y-2.5"
        >
          <form onSubmit={submit} className="space-y-2.5">
            <Segmented<Side>
              value={side}
              onChange={setSide}
              options={[
                { value: "profit", label: "Profit" },
                { value: "loss", label: "Loss" },
              ]}
            />

            <div>
              <label htmlFor="pnl-amount" className="lbl mb-1 block">
                Amount
              </label>
              <div className="relative flex items-center">
                <input
                  id="pnl-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountDraft}
                  onChange={(e) => setAmountDraft(e.target.value)}
                  className={cn("field pr-7", side === "loss" ? "text-neg" : "text-pos")}
                />
                <span className="num pointer-events-none absolute right-2 text-[10.5px] text-muted-foreground">$</span>
              </div>
            </div>

            <div>
              <label htmlFor="pnl-tag" className="lbl mb-1 block">
                Tag
              </label>
              <input
                id="pnl-tag"
                maxLength={24}
                autoComplete="off"
                placeholder="BTC, scalp…"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                className="field"
              />
            </div>

            <Button type="submit" tone="solid" className="w-full" disabled={amountDraft.trim().length === 0}>
              <Plus className="h-3.5 w-3.5" />
              Log {side}
            </Button>
          </form>

          <div className="border-t border-line-soft pt-1">
            {dayEntries.length === 0 ? (
              <p className="num py-3 text-center text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
                No trades logged
              </p>
            ) : (
              <ul>
                {dayEntries.map((e) => (
                  <li
                    key={e.id}
                    className="flex h-[27px] items-center gap-2 border-b border-line-soft last:border-b-0"
                  >
                    <span className="num flex-1 truncate text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
                      {e.tag ?? "—"}
                    </span>
                    <span
                      className={cn("num text-[12px] font-semibold", e.amount >= 0 ? "text-pos" : "text-neg")}
                    >
                      {fmtSignedUsd(e.amount, 2)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeEntry(e.id)}
                      aria-label="Delete entry"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-[2px] text-muted-foreground transition-colors hover:bg-secondary hover:text-neg"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {dayEntries.length > 0 ? (
            <Button tone="ghost" size="sm" className="w-full" onClick={() => clearDay(selected)}>
              Clear day
            </Button>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
