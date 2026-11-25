import { memo, useEffect, useState } from "react";

import { Tag } from "@/components/kit";
import { fmtClock, fmtDate, fmtPrice, priceDecimals } from "@/lib/format";
import { wickMonitor, type WickMonitorState } from "@/lib/radar/wickMonitor";
import { cn } from "@/lib/utils";

/** Tail strength: the larger the lower wick, the hotter the row. */
const STRENGTH_CLASS: Record<"pos" | "brand" | "warn", string> = {
  pos: "text-pos",
  brand: "text-primary",
  warn: "text-warn",
};

function strengthTone(rangeShare: number): "pos" | "brand" | "warn" {
  return rangeShare >= 0.85 ? "pos" : rangeShare >= 0.78 ? "brand" : "warn";
}

const STATUS_TONE: Record<WickMonitorState["status"], "pos" | "warn" | "muted"> = {
  polling: "pos",
  blocked: "warn",
  idle: "muted",
};

const EMPTY_HINT: Record<WickMonitorState["status"], string> = {
  polling:
    "No qualifying candle has closed yet. A row lands here the moment a 15m, 1h or 4h candle closes green with its lower wick dominating the candle — at any absolute size. Red and still-forming candles are never reported.",
  blocked:
    "The monitor cannot reach the venue's REST endpoint from this connection, so no candles can be evaluated right now. It retries every minute; the live sockets are unaffected.",
  idle: "Waiting for the tracked contract list.",
};

/**
 * "Bullish lower wick signals" — a pure view over the independent candle
 * monitor. It renders whatever closed-candle signals the monitor reports
 * and touches nothing else in the radar.
 */
export const LowerWickSignals = memo(function LowerWickSignals() {
  const [state, setState] = useState<WickMonitorState>(() => wickMonitor.snapshot());
  useEffect(() => wickMonitor.subscribe(setState), []);

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              state.status === "polling" ? "bg-pos" : state.status === "blocked" ? "bg-warn" : "bg-muted-foreground/40",
            )}
          />
          <h2 className="lbl">Bullish lower wick signals{state.signals.length ? ` — ${state.signals.length}` : ""}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Tag tone={STATUS_TONE[state.status]}>15m · 1h · 4h</Tag>
          <Tag tone={STATUS_TONE[state.status]}>{state.status}</Tag>
        </div>
      </header>
      {state.signals.length === 0 ? (
        <p className="num px-3 py-2.5 text-[10.5px] leading-[1.5] text-muted-foreground">{EMPTY_HINT[state.status]}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Closing time</th>
                <th>Timeframe</th>
                <th className="text-right">Closing price</th>
                <th className="text-right">Lower wick</th>
              </tr>
            </thead>
            <tbody>
              {state.signals.map((s) => {
                const decimals = priceDecimals(s.close || 1);
                return (
                  <tr key={`${s.symbol}:${s.interval}:${s.closedAt}`}>
                    <td className="font-semibold text-pos">{s.symbol}</td>
                    <td title={fmtDate(s.closedAt)}>{fmtClock(s.closedAt)}</td>
                    <td>{s.interval}</td>
                    <td className="text-right">{fmtPrice(s.close, decimals)}</td>
                    <td className="text-right">
                      <span className={cn("font-semibold", STRENGTH_CLASS[strengthTone(s.rangeShare)])}>
                        {fmtPrice(s.wick, decimals)}
                      </span>
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        {Math.round(s.rangeShare * 100)}% · {s.bodyMultiple.toFixed(1)}× body
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
