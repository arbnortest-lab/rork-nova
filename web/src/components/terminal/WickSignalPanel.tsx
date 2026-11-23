/**
 * Wick Signal Monitor — the right-column home of the 1H wick history.
 *
 * Shows EVERY recorded wick signal: closed 1H green candles only, every
 * non-zero wick, upper and lower independently, newest first. Nothing is
 * discarded for being small, so the table starts unfiltered and the filters
 * below only change what you SEE, never what is recorded. Export hands over
 * the complete visible selection as RFC-4180 CSV.
 */

import { ArrowDownWideNarrow, Download, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, Segmented, Tag } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { fmtCompactUsd, fmtPrice, priceDecimals, timeAgo } from "@/lib/format";
import { signalsToCsv, type WickSignal } from "@/lib/signals/wickSignal";
import { TRACKED_SYMBOLS } from "@/lib/wick/universe";
import { cn } from "@/lib/utils";

type PairFilter = "all" | "BTC" | "USDC";
type TypeFilter = "all" | "upper" | "lower";
type SortKey = "new" | "wick" | "rvol";

function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const EMPTY = "n/a";

export function WickSignalPanel({ signals, className }: { signals: WickSignal[]; className?: string }) {
  const [pair, setPair] = useState<PairFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<SortKey>("new");
  const [query, setQuery] = useState<string>("");

  const decimalsOf = (s: WickSignal) => priceDecimals(s.close || 1);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = signals.filter((s) => {
      if (pair !== "all" && !s.symbol.startsWith(pair)) return false;
      if (type !== "all" && s.type !== type) return false;
      if (q) {
        const hay = `${s.symbol} ${new Date(s.signalTime).toISOString()} ${s.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort === "wick") out = [...out].sort((a, b) => b.wickPct - a.wickPct);
    else if (sort === "rvol")
      out = [...out].sort((a, b) => (Number.isFinite(b.rvol) ? b.rvol : -1) - (Number.isFinite(a.rvol) ? a.rvol : -1));
    // "new" — the provider already returns newest first.
    return out;
  }, [signals, pair, type, sort, query]);

  const upper = rows.filter((s) => s.type === "upper").length;
  const btcCount = signals.filter((s) => s.symbol.startsWith("BTC")).length;
  const usdcCount = signals.filter((s) => s.symbol.startsWith("USDC")).length;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* filters */}
      <div className="shrink-0 space-y-2 border-b border-line-soft px-2.5 py-2">
        <div className="flex items-center gap-2">
          <Segmented<PairFilter>
            value={pair}
            options={[
              { value: "all", label: `All · ${signals.length}` },
              { value: "BTC", label: `BTC · ${btcCount}` },
              { value: "USDC", label: `USDC · ${usdcCount}` },
            ]}
            onChange={setPair}
            className="h-7 flex-1"
          />
          <Segmented<TypeFilter>
            value={type}
            options={[
              { value: "all", label: "All" },
              { value: "upper", label: "Upper" },
              { value: "lower", label: "Lower" },
            ]}
            onChange={setType}
            className="h-7 flex-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-[11px] w-[11px] -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by pair or date"
              className="h-7 pl-7 text-[11px]"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Segmented<SortKey>
            value={sort}
            options={[
              { value: "new", label: "New" },
              { value: "wick", label: "W%" },
              { value: "rvol", label: "RVOL" },
            ]}
            onChange={setSort}
            className="h-7 w-[128px] shrink-0"
          />
          <Button
            tone="outline"
            size="sm"
            className="shrink-0"
            title="Download the visible rows as CSV"
            onClick={() => download(`nova-wick-signals-${new Date().toISOString().slice(0, 10)}.csv`, signalsToCsv(rows))}
          >
            <Download className="h-3 w-3" />
            CSV
          </Button>
        </div>
        <div className="num flex items-center gap-2 text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
          <Tag tone="brand">{rows.length}</Tag>
          <span>
            upper <span className="text-neg">{upper}</span> · lower <span className="text-pos">{rows.length - upper}</span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <ArrowDownWideNarrow className="h-[10px] w-[10px]" />
            green 1H closes only
          </span>
        </div>
      </div>

      {/* table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table w-full">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="lbl text-left">Closed</th>
              <th className="lbl text-left">Pair</th>
              <th className="lbl text-right">Wick</th>
              <th className="lbl text-right">W %</th>
              <th className="lbl text-right">Wick $</th>
              <th className="lbl text-right">RVOL</th>
              <th className="lbl text-right">vs hi</th>
              <th className="lbl text-right">Funding</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center">
                  <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">No wick signals yet</p>
                  <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-foreground/70">
                    Every closed 1H green candle with any wick lands here — upper wicks (rejection above) and lower
                    wicks (rejection below), recorded independently. History is seeded from the exchange and persisted.
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((s) => {
                const dec = decimalsOf(s);
                return (
                  <tr key={s.id}>
                    <td className="num whitespace-nowrap text-[11px] text-muted-foreground" title={new Date(s.signalTime).toLocaleString()}>
                      {timeAgo(s.signalTime)}
                    </td>
                    <td className="num text-[11.5px] font-semibold">
                      {s.symbol.replace("USDT", "")}
                      <span
                        className={cn(
                          "ml-1 text-[9px] font-bold uppercase",
                          s.type === "upper" ? "text-neg" : "text-pos",
                        )}
                      >
                        {s.type === "upper" ? "▲U" : "▼L"}
                      </span>
                    </td>
                    <td className="num text-right text-[11.5px]">{fmtPrice(s.wickSize, dec)}</td>
                    <td className="num text-right text-[11.5px] font-semibold">{s.wickPct.toFixed(1)}%</td>
                    <td className="num text-right text-[11.5px] text-muted-foreground">{fmtCompactUsd(s.wickUsdt)}</td>
                    <td
                      className={cn(
                        "num text-right text-[11.5px]",
                        !Number.isFinite(s.rvol) ? "text-muted-foreground/50" : s.rvol >= 200 ? "text-warn" : undefined,
                      )}
                    >
                      {Number.isFinite(s.rvol) ? `${Math.round(s.rvol)}%` : EMPTY}
                    </td>
                    <td className="num text-right text-[11.5px]">
                      {s.distHighPct === undefined ? EMPTY : `${s.distHighPct.toFixed(2)}%`}
                    </td>
                    <td
                      className={cn(
                        "num text-right text-[11.5px]",
                        s.fundingRate === undefined ? "text-muted-foreground/50" : s.fundingRate >= 0 ? "text-neg" : "text-pos",
                      )}
                    >
                      {s.fundingRate === undefined ? EMPTY : `${s.fundingRate.toFixed(3)}%`}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="num shrink-0 border-t border-line-soft px-2.5 py-1.5 text-[9.5px] leading-[1.5] text-muted-foreground">
        1H timeframe only — the chart above never changes this feed. A signal confirms only when its candle CLOSES;
        red candles are never recorded. Context columns read {EMPTY} while that input is offline.
      </p>
    </div>
  );
}

/** Kept for the header of the host panel. */
export const WICK_PAIRS = TRACKED_SYMBOLS;
