import { ArrowDownRight, ArrowUpRight, ChevronRight, RotateCw } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "@/components/kit";
import { fmtClock, fmtCompactUsd, timeAgo } from "@/lib/format";
import { badgeOf, REASON_TEXT, type OnChainJob } from "@/lib/onchain/schedule";
import type { OnChainCluster, OnChainRead } from "@/lib/onchain/types";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<ReturnType<typeof badgeOf>["tone"], string> = {
  muted: "border-border bg-secondary text-muted-foreground",
  pos: "border-pos/30 bg-pos-soft text-pos",
  neg: "border-neg/30 bg-neg-soft text-neg",
  warn: "border-warn/30 bg-warn-soft text-warn",
  brand: "border-primary/40 bg-primary/10 text-primary",
};

/**
 * The add-on's one visible element: a status tag that reads "On-Chain: …".
 *
 * Hidden entirely while the add-on has nothing to say for this signal (no
 * job, or a flat result in compact mode), so the gates keep their space.
 */
export const OnChainBadge = memo(function OnChainBadge({
  job,
  now,
  compact,
  className,
}: {
  job: OnChainJob | undefined;
  now: number;
  /** Feed rows: hide idle and flat states instead of greying them out. */
  compact?: boolean;
  className?: string;
}) {
  const view = badgeOf(job, now);
  if (view.state === "idle") return null;
  if (compact && view.state === "flat") return null;

  return (
    <span
      title={view.hint}
      className={cn(
        "num inline-flex max-w-full items-center gap-1 rounded-[2px] border px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-[0.1em]",
        TONE_CLASS[view.tone],
        view.state === "unavailable" && "opacity-60",
        className,
      )}
    >
      {view.state === "scanning" ? <span className="h-[5px] w-[5px] shrink-0 animate-blink rounded-full bg-current" /> : null}
      <span className="truncate">{view.label}</span>
    </span>
  );
});

function FlowBar({ read }: { read: OnChainRead }) {
  const total = read.inflowUsd + read.outflowUsd;
  const inPct = total > 0 ? (read.inflowUsd / total) * 100 : 0;
  const outPct = total > 0 ? (read.outflowUsd / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="num text-[10.5px] text-neg">
          <ArrowDownRight className="mr-0.5 inline h-[10px] w-[10px]" />
          to exchanges {fmtCompactUsd(read.inflowUsd)}
        </span>
        <span className="num text-[10.5px] text-pos">
          off exchanges {fmtCompactUsd(read.outflowUsd)}
          <ArrowUpRight className="ml-0.5 inline h-[10px] w-[10px]" />
        </span>
      </div>
      <div className="mt-1 flex h-[4px] w-full gap-px overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-neg transition-[width] duration-500" style={{ width: `${inPct}%` }} />
        <div className="h-full bg-pos transition-[width] duration-500" style={{ width: `${outPct}%` }} />
      </div>
    </div>
  );
}

function ClusterRow({ c }: { c: OnChainCluster }) {
  const out = c.direction === "out";
  return (
    <li className="flex items-center gap-2 py-[3px]">
      {out ? (
        <ArrowUpRight className="h-[11px] w-[11px] shrink-0 text-pos" />
      ) : (
        <ArrowDownRight className="h-[11px] w-[11px] shrink-0 text-neg" />
      )}
      <span className="num min-w-0 flex-1 truncate text-[10.5px] text-foreground">
        {c.name}
        {c.tag ? <span className="ml-1 text-primary">· {c.tag}</span> : null}
        <span className="text-muted-foreground">
          {" "}
          {out ? "←" : "→"} {c.exchanges.join(", ") || "exchange"}
          {c.venue === "derivatives" ? " · futures" : c.venue === "mixed" ? " · spot+futures" : ""}
        </span>
      </span>
      <span className={cn("num shrink-0 text-[10.5px] font-semibold", out ? "text-pos" : "text-neg")}>
        {fmtCompactUsd(c.usd)}
      </span>
      {c.transfers > 1 ? (
        <span className="num shrink-0 text-[9.5px] text-muted-foreground">×{c.transfers}</span>
      ) : null}
    </li>
  );
}

/**
 * Everything behind the badge: the flow split, the counterparties that made
 * it, what was filtered out and when the window ran.
 */
export function OnChainDetail({
  job,
  now,
  onRescan,
  defaultOpen,
}: {
  job: OnChainJob;
  now: number;
  onRescan?: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);
  const view = badgeOf(job, now);
  const read = view.read;
  const final = job.final?.state === "ok" ? job.final : undefined;
  const earlyOnly = !final && job.early?.state === "ok";

  return (
    <div className="text-[10.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("mt-[2px] h-[11px] w-[11px] shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
        />
        <span className="num min-w-0 flex-1 leading-[1.45] text-muted-foreground">{view.hint}</span>
      </button>

      {open ? (
        <div className="mt-2 space-y-2 border-l border-line-soft pl-3">
          {read && read.state === "ok" ? (
            <>
              <FlowBar read={read} />
              {read.clusters.length ? (
                <ul className="divide-y divide-line-soft">
                  {read.clusters.map((c) => (
                    <ClusterRow key={`${c.direction}:${c.key}`} c={c} />
                  ))}
                </ul>
              ) : null}
              <p className="num leading-[1.5] text-muted-foreground">
                {read.stats.transfers} transfer{read.stats.transfers === 1 ? "" : "s"} of $20k–$500k scanned ·{" "}
                {read.stats.kept} cluster{read.stats.kept === 1 ? "" : "s"} in $100k–$500k
                {read.stats.small ? ` · ${read.stats.small} under $100k` : ""}
                {read.stats.outliers ? ` · ${read.stats.outliers} above $500k` : ""}
                {read.stats.internal ? ` · ${read.stats.internal} exchange-internal` : ""}
                {read.stats.truncated ? " · more rows than fetched" : ""}
              </p>
            </>
          ) : null}

          {read && read.state === "unavailable" ? (
            <p className="num leading-[1.5] text-muted-foreground">
              {read.reason ? REASON_TEXT[read.reason] : "Unavailable"}
              {read.message && read.message !== (read.reason ? REASON_TEXT[read.reason] : "") ? ` — ${read.message}` : ""}
            </p>
          ) : null}

          <p className="num leading-[1.5] text-muted-foreground/70">
            Window {fmtClock(job.at - 15 * 60_000)} → {fmtClock(job.at + 2 * 60_000)} (−15m / +2m around the signal)
            {read?.token ? ` · ${read.token.symbol}${read.token.chains.length ? ` on ${read.token.chains.join(", ")}` : ""}` : ""}
            {read ? ` · ${read.phase === "final" ? "final" : "early"} read ${timeAgo(read.scannedAt, now)}` : ""}
            {read?.cached ? " · cached" : ""}
            {read && read.credits ? ` · ${read.credits} credits` : ""}
          </p>

          {earlyOnly ? (
            <p className="num leading-[1.5] text-warn/80">
              Early read: the window had not closed when it ran. The final read follows once Arkham has indexed the last
              blocks.
            </p>
          ) : null}

          {onRescan && job.done ? (
            <Button tone="ghost" size="sm" onClick={() => onRescan(job.id)} className="h-6 px-2 text-[10px]">
              <RotateCw className="h-[10px] w-[10px]" />
              Rescan
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
