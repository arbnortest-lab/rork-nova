/**
 * Walls — the whale walls around one instrument's price, both sides, with
 * the engine's own spoofing verdict. The wording "SPOOFING SUSPECTED" is the
 * exact label the specification requires; walls are read-only.
 */

import { Layers } from "lucide-react";

import { Tag } from "@/components/kit";
import { fmtCompactUsd, fmtPrice, priceDecimals } from "@/lib/format";
import type { InstrumentRead } from "@/store/InstrumentsProvider";
import type { Wall } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

function WallLine({ wall, dec }: { wall: Wall; dec: number }) {
  return (
    <div className="num flex h-[22px] items-center gap-2 border-b border-line-soft px-2.5 text-[10.5px] last:border-b-0">
      <span className={cn("w-[54px] font-semibold", wall.side === "buy" ? "text-pos" : "text-neg")}>
        {fmtPrice(wall.price, dec)}
      </span>
      <span className="text-muted-foreground">{wall.distance >= 0 ? "+" : ""}{wall.distance.toFixed(2)}%</span>
      <span className="ml-auto text-foreground/85">{fmtCompactUsd(wall.notional)}</span>
      <span className="w-[42px] text-right text-primary">×{wall.strength.toFixed(1)}</span>
    </div>
  );
}

export function WallsPanel({ read, price }: { read: InstrumentRead | undefined; price: number }) {
  if (!read) {
    return (
      <p className="num px-3 py-6 text-center text-[11px] text-muted-foreground/70">
        Depth stream connecting — walls appear with the first book snapshots.
      </p>
    );
  }
  const dec = priceDecimals(price || 1);
  const { bidWalls, askWalls, book } = read;

  return (
    <div className="flex min-h-0 flex-col">
      {book.spoofSuspected ? (
        <div className="border-b border-warn/25 bg-warn-soft px-2.5 py-1.5">
          <p className="num text-[10px] font-bold uppercase tracking-[0.12em] text-warn">
            SPOOFING SUSPECTED — {book.pulled} wall{book.pulled === 1 ? "" : "s"} pulled without trading
          </p>
        </div>
      ) : null}
      <div className="num grid grid-cols-[1fr_1fr] gap-px bg-line-soft">
        <div>
          <div className="lbl border-b border-line-soft bg-secondary/40 px-2.5 py-1 text-pos">Bid walls</div>
          {bidWalls.length ? (
            bidWalls.map((w) => <WallLine key={`b${w.price}`} wall={w} dec={dec} />)
          ) : (
            <p className="num px-2.5 py-3 text-[10.5px] text-muted-foreground/60">None ≥ 3× the mean level.</p>
          )}
        </div>
        <div>
          <div className="lbl border-b border-line-soft bg-secondary/40 px-2.5 py-1 text-neg">Ask walls</div>
          {askWalls.length ? (
            askWalls.map((w) => <WallLine key={`a${w.price}`} wall={w} dec={dec} />)
          ) : (
            <p className="num px-2.5 py-3 text-[10.5px] text-muted-foreground/60">None ≥ 3× the mean level.</p>
          )}
        </div>
      </div>
      <div className="num flex items-center gap-3 border-t border-line-soft px-2.5 py-1.5 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <Layers className="h-[10px] w-[10px]" />
        <span>
          imbalance <span className="text-foreground">{book.imbalance >= 0 ? "+" : ""}{(book.imbalance * 100).toFixed(0)}%</span>
        </span>
        <span>
          pressure <span className="text-foreground">{read.depth.pressure}</span>
        </span>
        {book.absorbed ? <Tag tone="warn">absorbed</Tag> : null}
        {book.relocated > 0 ? <Tag tone="muted">relocated {book.relocated}</Tag> : null}
      </div>
    </div>
  );
}
