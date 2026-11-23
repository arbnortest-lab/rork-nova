/**
 * Open Interest & Funding — both instruments, side by side.
 *
 * The four open-interest regimes, exactly as the engine's
 * `readOpenInterest` classifies them:
 *
 *   price ↑ OI ↑  new longs entering      price ↓ OI ↑  new shorts entering
 *   price ↑ OI ↓  short covering          price ↓ OI ↓  long liquidation
 *
 * Read-only: the same OiPoint series the instrument layer polls.
 */

import { useMemo } from "react";

import { Metric, Tag } from "@/components/kit";
import { fmtCompactUsd, fmtSignedPct, timeAgo } from "@/lib/format";
import type { InstrumentRead } from "@/store/InstrumentsProvider";
import { cn } from "@/lib/utils";

const REGIME_LABEL: Record<string, string> = {
  "new-longs": "NEW LONGS",
  "new-shorts": "NEW SHORTS",
  "short-covering": "SHORT COVERING",
  "long-liquidation": "LONG LIQUIDATION",
  flat: "FLAT",
};

const REGIME_TONE: Record<string, "pos" | "neg" | "warn" | "muted" | "brand"> = {
  "new-longs": "pos",
  "new-shorts": "neg",
  "short-covering": "brand",
  "long-liquidation": "warn",
  flat: "muted",
};

function InstrumentOiFunding({ read, now }: { read: InstrumentRead | undefined; now: number }) {
  const oi = read?.oi;
  const mark = read?.mark;
  const funding = mark?.fundingRate;

  return (
    <div className="space-y-2 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="num text-[11px] font-bold tracking-[0.06em]">{read?.symbol ?? "—"}</span>
        {oi ? (
          <Tag tone={REGIME_TONE[oi.read.regime] ?? "muted"} title={`from ${oi.snapshots} OI snapshots`}>
            {REGIME_LABEL[oi.read.regime] ?? oi.read.regime}
          </Tag>
        ) : (
          <Tag tone="muted">NOT AVAILABLE</Tag>
        )}
        <span className="num ml-auto text-[9.5px] text-muted-foreground">
          {read?.oiPolledAt ? `polled ${timeAgo(read.oiPolledAt, now)}` : "never polled"}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Metric
          label="OI"
          value={oi?.notionalUsd ? fmtCompactUsd(oi.notionalUsd) : oi?.current ? oi.current.toLocaleString("en-US") : "n/a"}
          size="sm"
          sub={oi?.trend ? `trend ${oi.trend}` : undefined}
        />
        <Metric
          label="OI 5m"
          value={oi?.read.change5m === undefined ? "n/a" : fmtSignedPct(oi.read.change5m, 2)}
          size="sm"
          tone={(oi?.read.change5m ?? 0) >= 0 ? "pos" : "neg"}
        />
        <Metric
          label="OI 1h"
          value={oi?.read.change1h === undefined ? "n/a" : fmtSignedPct(oi.read.change1h, 2)}
          size="sm"
          tone={(oi?.read.change1h ?? 0) >= 0 ? "pos" : "neg"}
        />
        <Metric
          label="Funding"
          value={funding === undefined ? "n/a" : `${funding.toFixed(4)}%`}
          size="sm"
          tone={funding === undefined ? "muted" : funding >= 0 ? "neg" : "pos"}
          sub={funding === undefined ? undefined : funding >= 0 ? "longs pay" : "shorts pay"}
        />
      </div>

      {mark ? (
        <div className="num flex items-center gap-3 text-[9.5px] text-muted-foreground">
          <span>
            mark <span className="text-foreground">{mark.markPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
          </span>
          <span>
            next funding{" "}
            <span className="text-foreground">
              {Math.max(0, mark.nextFundingTime - now) > 0
                ? `${Math.ceil((mark.nextFundingTime - now) / 3_600_000)}h`
                : "now"}
            </span>
          </span>
          <span className="ml-auto">mark stream {timeAgo(mark.at, now)}</span>
        </div>
      ) : (
        <p className="num text-[9.5px] text-muted-foreground/60">Mark price stream not connected — funding n/a.</p>
      )}
    </div>
  );
}

export function OiFundingPanel({
  reads,
  order,
  now,
}: {
  reads: Map<string, InstrumentRead>;
  order: readonly string[];
  now: number;
}) {
  const list = useMemo(() => order.map((s) => reads.get(s)), [reads, order]);
  return (
    <div className="flex min-h-0 flex-col">
      {list.map((read, i) => (
        <div key={order[i]} className={cn(i > 0 && "border-t border-border")}>
          <InstrumentOiFunding read={read} now={now} />
        </div>
      ))}
    </div>
  );
}
