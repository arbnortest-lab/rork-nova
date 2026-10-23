import { Button, Panel, Tag } from "@/components/kit";
import { fmtClock } from "@/lib/format";
import { BTC_TRAP_SYMBOL, type BtcTrapLive, type BtcTrapRow } from "@/lib/wick/btcTrap";
import { GATE_LABEL } from "@/lib/wick/types";

/** Same words the gate list uses, so the two never disagree. */
const LIVE_TAG: Record<BtcTrapLive, { tone: "pos" | "muted"; label: string }> = {
  pass: { tone: "pos", label: "pass" },
  waiting: { tone: "muted", label: "waiting" },
  idle: { tone: "muted", label: "no data" },
};

/** Sticky, opaque header cell, so rows never show through while scrolling. */
const HEAD_CELL = "sticky top-0 z-[1] !bg-surface-2 shadow-[inset_0_-1px_0_hsl(var(--border))]";

/** Day prefix for rows from an earlier day. Today's rows show the time only. */
function dayOf(ts: number, now: number): string | undefined {
  const day = new Date(ts);
  if (day.toDateString() === new Date(now).toDateString()) return undefined;
  return day.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export interface BtcTrapTableProps {
  /** Logged switches to pass, newest first. */
  rows: BtcTrapRow[];
  /** The gate's state right now. */
  live: BtcTrapLive;
  onClear: () => void;
  /** Reference time for the day prefix. */
  now?: number;
}

/**
 * BTCUSDT failed-breakout log: one row each time gate 3 switched to pass, with
 * the time it passed and the rejection wick at that moment.
 */
export function BtcTrapTable({ rows, live, onClear, now = Date.now() }: BtcTrapTableProps) {
  const tag = LIVE_TAG[live];

  return (
    <Panel
      title={`${BTC_TRAP_SYMBOL} · ${GATE_LABEL.trap}`}
      flush
      aside={
        <div className="flex items-center gap-1.5">
          <span title={`${BTC_TRAP_SYMBOL} failed breakout trap right now`}>
            <Tag tone={tag.tone}>{tag.label}</Tag>
          </span>
          {rows.length > 0 ? (
            <Button tone="ghost" size="sm" onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      }
    >
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="num text-[11px] uppercase tracking-[0.12em] text-muted-foreground">No passes logged yet</p>
          <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-foreground/70">
            {`A row is added each time ${BTC_TRAP_SYMBOL}'s failed breakout trap switches to pass.`}
          </p>
        </div>
      ) : (
        <div className="max-h-[248px] overflow-auto">
          <table className="grid-table" aria-label={`${BTC_TRAP_SYMBOL} failed breakout trap passes`}>
            <thead>
              <tr>
                <th scope="col" className={HEAD_CELL}>
                  Passed at
                </th>
                <th scope="col" className={`${HEAD_CELL} !text-right`}>
                  Rejection wick
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const day = dayOf(row.at, now);
                return (
                  <tr key={row.id}>
                    <td>
                      {day ? <span className="mr-1.5 text-muted-foreground">{day}</span> : null}
                      {fmtClock(row.at)}
                    </td>
                    <td className="text-right font-semibold">{`${row.wickPct.toFixed(1)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
