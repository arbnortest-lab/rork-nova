/**
 * ExhaustionPanel — the four-gate engine's verdict for the focused contract.
 *
 * Extracted verbatim from the v1 dashboard's FocusPanel (GateLine and
 * RangeRail included): same gates, same measurements, same on-chain add-on.
 * The engine behind it is untouched; this is its read-only face.
 */

import { Activity, Check, Pin, ScanSearch } from "lucide-react";
import { memo } from "react";

import { Button, Metric, Tag } from "@/components/kit";
import { OnChainBadge, OnChainDetail } from "@/components/OnChainBadge";
import { fmtClock, fmtCompactUsd, fmtPrice, fmtSignedPct, timeAgo } from "@/lib/format";
import type { OnChainJob } from "@/lib/onchain/schedule";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { GateRead, TrapSide } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

function sideTone(side: TrapSide): "neg" | "muted" {
  return side === "short" ? "neg" : "muted";
}

/**
 * One gate line: a state mark, the criterion, the numbers behind it, and a
 * meter that fills to the threshold and stops there.
 */
const GateLine = memo(function GateLine({ gate, index }: { gate: GateRead; index: number }) {
  const state = gate.passed ? "pass" : gate.measured ? "fail" : "idle";

  return (
    <li className="flex gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0">
      <span
        className={cn(
          "mt-[1px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[3px] border text-[9px] font-bold",
          state === "pass"
            ? "border-pos/50 bg-pos-soft text-pos"
            : state === "fail"
              ? "border-border bg-secondary text-muted-foreground/60"
              : "border-dashed border-border text-muted-foreground/35",
        )}
      >
        {state === "pass" ? <Check className="h-[9px] w-[9px]" strokeWidth={3.5} /> : index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "num text-[10.5px] font-semibold uppercase tracking-[0.1em]",
              state === "pass" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {gate.label}
          </span>
          <span
            className={cn(
              "num shrink-0 text-[9.5px] uppercase tracking-[0.1em]",
              state === "pass" ? "text-pos" : state === "fail" ? "text-muted-foreground/70" : "text-muted-foreground/40",
            )}
          >
            {state === "pass" ? "pass" : state === "fail" ? "waiting" : "no data"}
          </span>
        </div>

        <p
          className={cn(
            "mt-1 text-[11.5px] leading-[1.45]",
            state === "idle" ? "italic text-muted-foreground/55" : "text-muted-foreground",
          )}
        >
          {gate.detail}
        </p>

        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-out",
              gate.passed ? "bg-pos" : "bg-muted-foreground/45",
            )}
            style={{ width: `${Math.round(gate.progress * 100)}%` }}
          />
        </div>
      </div>
    </li>
  );
});

/** Where price sits in its 24h range. The high is the level that matters. */
function RangeRail({ read }: { read: ExhaustionRead }) {
  const pos = Math.max(0, Math.min(1, read.rangePos));
  const pinned = read.gates.find((g) => g.key === "pin")?.passed ?? false;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="lbl">24h low {fmtPrice(read.low24h)}</span>
        <span className="lbl">{fmtPrice(read.high24h)} 24h high</span>
      </div>
      <div className="relative h-[6px] w-full rounded-full bg-secondary">
        <div className="absolute inset-y-0 left-0 w-[14%] rounded-l-full bg-pos/20" />
        <div className="absolute inset-y-0 right-0 w-[14%] rounded-r-full bg-neg/20" />
        <div
          className={cn(
            "absolute top-1/2 h-[13px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-700 ease-out",
            pinned
              ? read.rangePos > 0.5
                ? "bg-neg shadow-[0_0_8px_hsl(var(--neg))]"
                : "bg-pos shadow-[0_0_8px_hsl(var(--pos))]"
              : "bg-foreground",
          )}
          style={{ left: `${pos * 100}%` }}
        />
      </div>
    </div>
  );
}

export const ExhaustionPanel = memo(function ExhaustionPanel({
  read,
  symbol,
  pinned,
  onTogglePin,
  blocked,
  paused,
  onChain,
  now,
  onScanNow,
  onRescan,
  lastScanAt,
}: {
  read: ExhaustionRead | undefined;
  symbol: string;
  pinned: boolean;
  onTogglePin: () => void;
  blocked: boolean;
  paused: boolean;
  /** The add-on's newest scan for this contract, if any. */
  onChain: OnChainJob | undefined;
  now: number;
  onScanNow: () => void;
  onRescan: (id: string) => void;
  /** When the macro scanner last ticked, for the empty state. */
  lastScanAt?: number;
}) {
  if (!read) {
    return (
      <section className="panel flex min-h-[280px] flex-col items-center justify-center gap-2 px-6 text-center">
        <Activity className="h-5 w-5 text-muted-foreground/40" />
        <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">
          {blocked ? "Venue unreachable" : paused ? "Engine paused" : `Waiting for ${symbol}`}
        </p>
        {!blocked && !paused ? (
          <p className="max-w-[320px] text-[11px] leading-[1.5] text-muted-foreground/70">
            Two all-market streams are connecting. The four exhaustion gates start reporting within a couple of
            seconds.
            {lastScanAt ? ` Last scan ${fmtClock(lastScanAt)} (${timeAgo(lastScanAt, now)}).` : ""}
          </p>
        ) : null}
      </section>
    );
  }

  const armed = read.armed;
  // Every armed setup is a short, so the accent is always the bearish one.
  const tone = sideTone(armed ? "short" : "none");

  return (
    <section
      className={cn(
        "panel relative overflow-hidden transition-shadow duration-500",
        armed && "shadow-[0_0_0_1px_hsl(var(--neg)/0.5)]",
      )}
    >
      {/* verdict band */}
      <div
        className={cn(
          "relative border-b border-border px-3.5 py-3 transition-colors duration-500",
          armed ? "bg-neg-soft" : "bg-secondary/25",
        )}
      >
        {armed ? <div className="pulse-rail absolute inset-x-0 top-0 h-[2px]" data-side="short" /> : null}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onTogglePin}
                aria-label={pinned ? `Unpin ${read.symbol}` : `Pin ${read.symbol}`}
                title={pinned ? "Unpin — may lose its history slot" : "Pin — keeps kline history attached"}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-[3px] transition-colors",
                  pinned ? "text-primary" : "text-muted-foreground/40 hover:text-foreground",
                )}
              >
                <Pin className="h-[12px] w-[12px]" />
              </button>
              <h2 className="num text-[15px] font-semibold tracking-[0.04em] text-foreground">{read.symbol}</h2>
              {read.deep ? <Tag tone="pos">history</Tag> : <Tag tone="muted">tier 1</Tag>}
            </div>

            <p
              className={cn(
                "num mt-2 text-[13px] font-bold uppercase leading-none tracking-[0.1em]",
                armed ? "text-neg" : "text-muted-foreground",
              )}
            >
              {armed
                ? "SHORT — bull trap at the 24h high"
                : `${read.passedCount} of 4 gates — no setup`}
            </p>
          </div>

          <div className="flex items-start gap-4">
            <div className="text-right">
              <div className="num text-[19px] font-semibold leading-none">{fmtPrice(read.price)}</div>
              <div className={cn("num mt-1.5 text-[11px] leading-none", read.changePct >= 0 ? "text-pos" : "text-neg")}>
                {fmtSignedPct(read.changePct, 2)}
              </div>
            </div>
            <div className="text-right">
              <div className="lbl">Conviction</div>
              <div
                className={cn(
                  "num mt-1 text-[19px] font-semibold leading-none",
                  armed ? "text-neg" : "text-muted-foreground/40",
                )}
              >
                {armed ? read.conviction : "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3">
          <RangeRail read={read} />
        </div>
      </div>

      {/* measurements */}
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5 border-b border-border px-3.5 py-2.5">
        <Metric
          label="To 24h high"
          value={read.extremeBps === undefined ? "—" : `${read.extremeBps.toFixed(1)} bps`}
          size="sm"
          tone={read.gates[0]?.passed ? tone : "muted"}
        />
        <Metric
          label="RVOL"
          value={read.rvol === undefined ? "—" : `${Math.round(read.rvol)}%`}
          size="sm"
          tone={read.gates[1]?.passed ? "warn" : "muted"}
        />
        <Metric
          label="Cooling"
          value={
            read.rvolAcceleration === undefined
              ? "—"
              : `${read.rvolAcceleration > 0 ? "+" : ""}${Math.round(read.rvolAcceleration)}`
          }
          size="sm"
          tone={(read.rvolAcceleration ?? 1) <= 0 ? "pos" : "neg"}
        />
        <Metric
          label="Rejection wick"
          value={read.wickPct === undefined ? "—" : `${read.wickPct.toFixed(1)}%`}
          size="sm"
          tone={read.gates[2]?.passed ? tone : "muted"}
        />
        <Metric
          label={read.yearDays ? `${read.yearDays}d high` : "Horizon high"}
          value={read.yearHigh === undefined ? "—" : fmtPrice(read.yearHigh)}
          size="sm"
        />
        <Metric
          label={read.yearDays ? `${read.yearDays}d low` : "Horizon low"}
          value={read.yearLow === undefined ? "—" : fmtPrice(read.yearLow)}
          size="sm"
        />
        <Metric label="Turnover" value={fmtCompactUsd(read.quoteVolume)} size="sm" />
      </div>

      {/* the four gates */}
      <ul>
        {read.gates.map((gate, i) => (
          <GateLine key={gate.key} gate={gate} index={i} />
        ))}
      </ul>

      {/* on-chain add-on: reads the gates' verdict, never feeds back into it */}
      <div className="border-t border-line-soft px-3.5 py-2">
        <div className="flex items-center gap-2">
          {onChain ? (
            <OnChainBadge job={onChain} now={now} />
          ) : (
            <span className="num text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/60">
              On-Chain: — · scans when a signal fires
            </span>
          )}
          <Button
            tone="ghost"
            size="sm"
            onClick={onScanNow}
            className="ml-auto h-6 px-2 text-[10px]"
            title="Scan exchange flow for this contract now, anchored at the current time"
          >
            <ScanSearch className="h-[10px] w-[10px]" />
            Scan now
          </Button>
        </div>
        {onChain ? (
          <div className="mt-1.5">
            <OnChainDetail job={onChain} now={now} onRescan={onRescan} />
          </div>
        ) : null}
      </div>

      <p className="num border-t border-line-soft px-3.5 py-2 text-[10px] leading-[1.5] text-muted-foreground">
        All four gates must pass together. A gate that cannot be measured never counts as passed, so a contract
        without kline history can never arm.
      </p>
    </section>
  );
});
