/**
 * Confluence Analysis — the 14-row market read for one instrument.
 *
 * Clearly labelled as an ADDITIONAL analytical score: the roll-up counts how
 * many rows lean bullish vs bearish. It is a vote tally, never a probability
 * of success, and it never feeds back into the exhaustion engine.
 */

import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { Tag } from "@/components/kit";
import { buildConfluence, confluenceVote, type ConfluenceRow } from "@/lib/signals/confluence";
import type { InstrumentRead } from "@/store/InstrumentsProvider";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { VwapRead } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

const BIAS_TONE = { bullish: "pos", bearish: "neg", neutral: "muted" } as const;

function Row({ row, now }: { row: ConfluenceRow; now: number }) {
  const [open, setOpen] = useState<boolean>(false);
  const stale = row.at !== undefined && now - row.at > 120_000;
  return (
    <li className="border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-[5px] text-left transition-colors hover:bg-secondary/40"
      >
        <span className="num min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">{row.label}</span>
        <span
          className={cn(
            "num w-[92px] shrink-0 text-right text-[11px] font-semibold",
            stale && "text-muted-foreground/50",
          )}
        >
          {row.current}
          {stale ? " ·" : ""}
        </span>
        <span className="num w-[70px] shrink-0 text-right text-[10px] text-muted-foreground">{row.previous ?? ""}</span>
        <span className="w-[64px] shrink-0 text-right">
          <Tag tone={BIAS_TONE[row.bias]}>{row.bias === "bullish" ? "BULL" : row.bias === "bearish" ? "BEAR" : "FLAT"}</Tag>
        </span>
        <ChevronRight
          className={cn("h-[11px] w-[11px] shrink-0 text-muted-foreground/40 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="border-t border-line-soft bg-background/40 px-3 py-1.5">
          <p className="num text-[10.5px] leading-[1.5] text-muted-foreground">
            <span className="text-pos">bull:</span> {row.bull}
          </p>
          <p className="num text-[10.5px] leading-[1.5] text-muted-foreground">
            <span className="text-neg">bear:</span> {row.bear}
          </p>
          <p className="num text-[10.5px] leading-[1.5] text-muted-foreground">
            <span>range:</span> {row.neutral}
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function ConfluencePanel({
  symbol,
  macro,
  read,
  vwap,
  signals,
  now,
}: {
  symbol: string;
  macro: ExhaustionRead | undefined;
  read: InstrumentRead | undefined;
  vwap: VwapRead | undefined;
  /** All persisted wick signals; the trailing-24h counts are computed here. */
  signals: { symbol: string; type: "upper" | "lower"; signalTime: number }[];
  now: number;
}) {
  const rows = useMemo(() => {
    const dayAgo = now - 86_400_000;
    const recent = signals.filter((s) => s.symbol === symbol && s.signalTime >= dayAgo);
    return buildConfluence({
      macro,
      radar: read,
      oi: read?.oi.read,
      vwap,
      upperWicks24h: recent.filter((s) => s.type === "upper").length,
      lowerWicks24h: recent.filter((s) => s.type === "lower").length,
    });
  }, [macro, read, vwap, signals, symbol, now]);

  const vote = useMemo(() => confluenceVote(rows), [rows]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="num grid shrink-0 grid-cols-[1fr_92px_70px_64px_20px] gap-2 border-b border-line-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        <span>Measurement</span>
        <span className="text-right">Current</span>
        <span className="text-right">Prev</span>
        <span className="text-right">Lean</span>
        <span />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {rows.map((row) => (
          <Row key={row.key} row={row} now={now} />
        ))}
      </ul>
      <div className="shrink-0 border-t border-line-soft px-2.5 py-2">
        <div className="num flex items-center gap-3 text-[11px] font-semibold">
          <span className="text-pos">bull {vote.bullish}</span>
          <span className="text-neg">bear {vote.bearish}</span>
          <span className="text-muted-foreground">neutral {vote.neutral}</span>
          <Tag tone="muted" className="ml-auto">
            additional score
          </Tag>
        </div>
        <p className="num mt-1 text-[9.5px] leading-[1.5] text-muted-foreground">
          Vote tally across {rows.length} measurements — an analytical read, NOT a probability of success.
        </p>
      </div>
    </div>
  );
}
