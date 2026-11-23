/**
 * Data Quality — a badge for every input of every instrument.
 *
 * A panel that cannot measure something says "n/a" — it never substitutes a
 * zero. Freshness bands: FRESH under 10s, STALE under 60s, otherwise DOWN.
 */

import { memo } from "react";

import { Tag } from "@/components/kit";
import { fmtClock, timeAgo } from "@/lib/format";
import type { InstrumentRead } from "@/store/InstrumentsProvider";

type Fresh = "fresh" | "stale" | "down";

const BADGE: Record<Fresh, { label: string; tone: "pos" | "warn" | "neg" }> = {
  fresh: { label: "FRESH", tone: "pos" },
  stale: { label: "STALE", tone: "warn" },
  down: { label: "DOWN", tone: "neg" },
};

function badge(at: number | undefined, now: number): { fresh: Fresh; age: string } {
  if (!at) return { fresh: "down", age: "n/a" };
  const age = now - at;
  const fresh: Fresh = age < 10_000 ? "fresh" : age < 60_000 ? "stale" : "down";
  return { fresh, age: timeAgo(at, now) };
}

function QualityRow({ label, at, now }: { label: string; at: number | undefined; now: number }) {
  const b = badge(at, now);
  return (
    <tr>
      <td className="num text-[10.5px] text-muted-foreground">{label}</td>
      <td className="num text-right text-[10.5px]">{at ? fmtClock(at) : "—"}</td>
      <td className="num text-right text-[10.5px]">{b.age}</td>
      <td className="w-[64px] text-right">
        <Tag tone={BADGE[b.fresh].tone}>{BADGE[b.fresh].label}</Tag>
      </td>
    </tr>
  );
}

function InstrumentQuality({
  read,
  k1h,
  k5m,
  now,
}: {
  read: InstrumentRead | undefined;
  k1h?: number;
  k5m?: number;
  now: number;
}) {
  return (
    <div>
      <div className="num flex items-center gap-2 border-b border-line-soft bg-secondary/40 px-2.5 py-1">
        <span className="text-[11px] font-bold tracking-[0.06em]">{read?.symbol ?? "—"}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {read && read.bidWalls.length + read.askWalls.length > 0 ? (
            <Tag tone="brand">{read.bidWalls.length + read.askWalls.length} walls</Tag>
          ) : null}
          {read ? <Tag tone="muted">{read.liquidations.length} liqs 1h</Tag> : null}
        </span>
      </div>
      <table className="grid-table w-full">
        <tbody>
          <QualityRow label="Depth 20@100ms" at={read?.lastDepthAt} now={now} />
          <QualityRow label="Aggressive tape" at={read?.lastTradeAt} now={now} />
          <QualityRow label="Mark price 1s" at={read?.mark?.at} now={now} />
          <QualityRow label="Klines 1h" at={k1h} now={now} />
          <QualityRow label="Klines 5m" at={k5m} now={now} />
          <QualityRow label="Open interest poll" at={read?.oiPolledAt} now={now} />
        </tbody>
      </table>
    </div>
  );
}

export const DataQualityPanel = memo(function DataQualityPanel({
  reads,
  order,
  now,
}: {
  reads: Map<string, InstrumentRead>;
  order: readonly string[];
  now: number;
}) {
  return (
    <div className="grid gap-px bg-line-soft md:grid-cols-2">
      {order.map((symbol) => {
        const read = reads.get(symbol);
        return <InstrumentQuality key={symbol} read={read} k1h={read?.lastKline1h} k5m={read?.lastKline5m} now={now} />;
      })}
    </div>
  );
});
