import { memo } from "react";

import { Tag } from "@/components/kit";
import { fmtCompactUsd } from "@/lib/format";
import { OI_TREND_LABEL, oiTone } from "@/lib/radar/tone";
import type { OiTrendRead, SqueezeRead } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Order book imbalance                                                */
/* ------------------------------------------------------------------ */

/** Chip-sized bid/ask split. */
export const MiniImbalance = memo(function MiniImbalance({
  bidShare,
  className,
}: {
  bidShare: number;
  className?: string;
}) {
  const bid = Math.max(0, Math.min(100, bidShare));
  return (
    <span
      className={cn("relative inline-flex h-[6px] w-[34px] shrink-0 overflow-hidden rounded-[1px] bg-secondary", className)}
      title={`Weighted book: bids ${bid.toFixed(1)}% · asks ${(100 - bid).toFixed(1)}%`}
      aria-label={`Order book imbalance, bids ${bid.toFixed(0)} percent`}
    >
      <span className="h-full bg-pos/80 transition-[width] duration-300" style={{ width: `${bid}%` }} />
      <span className="h-full flex-1 bg-neg/80" />
      <span className="absolute inset-y-0 left-1/2 w-px bg-background/80" />
    </span>
  );
});

/** The full-width imbalance bar: weighted split, raw split and the pressure label. */
export const ImbalanceBar = memo(function ImbalanceBar({
  weightedBidShare,
  rawBidShare,
  bidNotional,
  askNotional,
  pressure,
  pressurePts,
}: {
  weightedBidShare: number;
  rawBidShare: number;
  bidNotional: number;
  askNotional: number;
  pressure: "bids" | "asks" | "balanced";
  pressurePts: number;
}) {
  const bid = Math.max(0, Math.min(100, weightedBidShare));
  const ask = 100 - bid;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="lbl">Order book imbalance</span>
          <Tag tone="muted">weighted</Tag>
        </div>
        <span
          className={cn(
            "num text-[11px] font-semibold",
            pressure === "bids" ? "text-pos" : pressure === "asks" ? "text-neg" : "text-muted-foreground",
          )}
        >
          {pressure === "balanced" ? "Balanced" : pressure === "bids" ? "Bulls" : "Bears"} +{pressurePts.toFixed(1)}%
        </span>
      </div>
      <div className="relative flex h-[26px] w-full overflow-hidden rounded-[3px] border border-line-soft bg-secondary">
        <div
          className="flex h-full items-center bg-pos/25 pl-2 transition-[width] duration-300"
          style={{ width: `${bid}%` }}
        >
          <span className="num whitespace-nowrap text-[10.5px] font-semibold text-pos">Bids {bid.toFixed(1)}%</span>
        </div>
        <div className="flex h-full flex-1 items-center justify-end bg-neg/25 pr-2">
          <span className="num whitespace-nowrap text-[10.5px] font-semibold text-neg">Asks {ask.toFixed(1)}%</span>
        </div>
        <div className="absolute inset-y-0 w-[2px] bg-foreground/70" style={{ left: `calc(${bid}% - 1px)` }} />
      </div>
      <div className="num mt-1 flex items-center justify-between text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <span>
          <span className="text-pos">●</span> W.bid {fmtCompactUsd(bidNotional)} · raw {rawBidShare.toFixed(1)}%
        </span>
        <span>
          raw {(100 - rawBidShare).toFixed(1)}% · W.ask {fmtCompactUsd(askNotional)} <span className="text-neg">●</span>
        </span>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Squeeze meter                                                       */
/* ------------------------------------------------------------------ */

/** Log-scale position of a volume on a track running from medAt/8 to highAt×4. */
function trackPos(volume: number, medAt: number, highAt: number): number {
  const lo = Math.max(1, medAt / 8);
  const hi = Math.max(lo * 10, highAt * 4);
  if (!(volume > lo)) return 0;
  return Math.max(0, Math.min(1, Math.log(volume / lo) / Math.log(hi / lo)));
}

/** Chip-sized squeeze readout: three segments, lit to the current level. */
export const MiniSqueeze = memo(function MiniSqueeze({ squeeze, className }: { squeeze: SqueezeRead; className?: string }) {
  const lit = squeeze.level === "hot" ? 3 : squeeze.level === "warm" ? 2 : squeeze.volume > 0 ? 1 : 0;
  const color = squeeze.level === "hot" ? "bg-neg" : squeeze.level === "warm" ? "bg-warn" : "bg-muted-foreground/70";
  return (
    <span
      className={cn("inline-flex items-end gap-[2px]", className)}
      title={`Squeeze volume 1h ${fmtCompactUsd(squeeze.volume)} · ${squeeze.level}`}
      aria-label={`Squeeze level ${squeeze.level}`}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-[1px]", i < lit ? color : "bg-secondary")}
          style={{ height: `${4 + i * 2}px` }}
        />
      ))}
    </span>
  );
});

export const SqueezeMeter = memo(function SqueezeMeter({ squeeze }: { squeeze: SqueezeRead }) {
  const pos = trackPos(squeeze.volume, squeeze.medAt, squeeze.highAt);
  const med = trackPos(squeeze.medAt, squeeze.medAt, squeeze.highAt);
  const high = trackPos(squeeze.highAt, squeeze.medAt, squeeze.highAt);
  const fill = squeeze.level === "hot" ? "bg-neg" : squeeze.level === "warm" ? "bg-warn" : "bg-primary/70";
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="lbl">1-hr squeeze volume</span>
        <span className="num text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
          low &lt;{fmtCompactUsd(squeeze.medAt)} · med {fmtCompactUsd(squeeze.medAt)}–{fmtCompactUsd(squeeze.highAt)} · high
          ≥{fmtCompactUsd(squeeze.highAt)}
        </span>
      </div>
      <div className="relative h-[8px] w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full transition-[width] duration-500", fill)} style={{ width: `${pos * 100}%` }} />
        <span className="absolute inset-y-0 w-px bg-warn/70" style={{ left: `${med * 100}%` }} />
        <span className="absolute inset-y-0 w-px bg-neg/70" style={{ left: `${high * 100}%` }} />
      </div>
      <div className="num mt-1 flex items-center gap-3 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <span>
          <span className="text-primary">●</span> low
        </span>
        <span>
          <span className="text-warn">●</span> med
        </span>
        <span>
          <span className="text-neg">●</span> high
        </span>
        <span className="ml-auto">
          shorts liq {fmtCompactUsd(squeeze.shortLiq)} · longs liq {fmtCompactUsd(squeeze.longLiq)}
        </span>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Open interest trend                                                 */
/* ------------------------------------------------------------------ */

export const OiTrendTag = memo(function OiTrendTag({ oi }: { oi: OiTrendRead }) {
  return <Tag tone={oiTone(oi.trend)}>{OI_TREND_LABEL[oi.trend]}</Tag>;
});
