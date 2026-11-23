/**
 * Market Overview — both instruments at a glance, always-on data.
 * Clicking a card selects that instrument across the terminal.
 */

import { memo } from "react";

import { Metric, Tag } from "@/components/kit";
import { fmtCompactUsd, fmtPrice, fmtSignedPct, priceDecimals, timeAgo } from "@/lib/format";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { InstrumentRead } from "@/store/InstrumentsProvider";
import type { VwapRead } from "@/lib/wick/types";
import { cn } from "@/lib/utils";


export const MarketOverviewPanel = memo(function MarketOverviewPanel({
  symbols,
  reads,
  macros,
  vwaps,
  selected,
  onSelect,
  now,
}: {
  symbols: readonly string[];
  reads: Map<string, InstrumentRead>;
  macros: Map<string, ExhaustionRead | undefined>;
  vwaps: Map<string, VwapRead | undefined>;
  selected: string;
  onSelect: (symbol: string) => void;
  now: number;
}) {
  return (
    <div className="grid gap-px bg-line-soft">
      {symbols.map((symbol) => {
        const read = reads.get(symbol);
        const macro = macros.get(symbol);
        const vwap = vwaps.get(symbol);
        const price = read?.depth.mid ?? macro?.price ?? 0;
        const dec = priceDecimals(price || 1);
        const change = macro?.changePct;
        const gates = macro?.passedCount ?? 0;
        const stale = read ? now - Math.max(read.lastDepthAt ?? 0, read.lastTradeAt ?? 0) > 15_000 : true;

        return (
          <button
            key={symbol}
            type="button"
            onClick={() => onSelect(symbol)}
            className={cn(
              "w-full bg-card px-2.5 py-2 text-left transition-colors hover:bg-secondary/40",
              selected === symbol && "bg-primary/[0.07]",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="num text-[12px] font-bold tracking-[0.04em]">{symbol.replace("USDT", "")}</span>
              <span
                className={cn("num text-[13px] font-semibold", change === undefined ? "" : change >= 0 ? "text-pos" : "text-neg")}
              >
                {price ? fmtPrice(price, dec) : "n/a"}
              </span>
              <span
                className={cn(
                  "num text-[10.5px]",
                  change === undefined ? "text-muted-foreground/50" : change >= 0 ? "text-pos" : "text-neg",
                )}
              >
                {change === undefined ? "n/a" : fmtSignedPct(change, 2)}
              </span>
              {stale ? <Tag tone="warn">stale</Tag> : null}
              {macro && gates > 0 ? <Tag tone={gates >= 3 ? "warn" : "muted"}>{gates}/4</Tag> : null}
            </div>
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              <Metric label="24h hi" value={macro?.high24h ? fmtPrice(macro.high24h, dec) : "n/a"} size="sm" tone="muted" />
              <Metric label="24h lo" value={macro?.low24h ? fmtPrice(macro.low24h, dec) : "n/a"} size="sm" tone="muted" />
              <Metric
                label="VWAP dist"
                value={vwap?.deviation === undefined ? "n/a" : fmtSignedPct(vwap.deviation, 2)}
                size="sm"
                tone={(vwap?.deviation ?? 0) >= 0 ? "neg" : "pos"}
              />
              <Metric
                label="Turnover"
                value={macro?.quoteVolume ? fmtCompactUsd(macro.quoteVolume) : "n/a"}
                size="sm"
                tone="muted"
              />
            </div>
            <div className="num mt-1 flex items-center gap-2 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
              <span>
                squeeze{" "}
                <span
                  className={cn(
                    "font-semibold",
                    read?.squeeze.level === "hot" ? "text-neg" : read?.squeeze.level === "warm" ? "text-warn" : "text-pos",
                  )}
                >
                  {read?.squeeze.level ?? "n/a"}
                </span>
              </span>
              <span>
                book{" "}
                <span className="text-foreground">
                  {read ? `${read.depth.weightedBidShare.toFixed(0)}/${(100 - read.depth.weightedBidShare).toFixed(0)}` : "n/a"}
                </span>
              </span>
              <span className="ml-auto">
                {read?.lastTradeAt ? `tape ${timeAgo(read.lastTradeAt, now)}` : "tape n/a"}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
});
