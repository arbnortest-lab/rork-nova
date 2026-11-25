import { memo, useEffect, useRef, useState } from "react";

import { Tag } from "@/components/kit";
import { fmtClock, fmtDate, fmtPrice, priceDecimals } from "@/lib/format";
import {
  WICK_SIGNALS_KEPT,
  newestClosedTime,
  scanClosedBars,
  type LowerWickSignal,
} from "@/lib/radar/wickSignal";
import type { RadarChart } from "@/lib/radar/types";
import { cn } from "@/lib/utils";

/**
 * Watches the focused contract's candles and records bullish lower-wick
 * signals the moment a candle FULLY CLOSES. Additive only: it reads the
 * chart feed and touches nothing else in the radar.
 */
function useLowerWickSignals(chart: RadarChart): LowerWickSignal[] {
  const [signals, setSignals] = useState<LowerWickSignal[]>([]);
  const baselineRef = useRef(new Map<string, number>());

  useEffect(() => {
    const key = `${chart.symbol}:${chart.interval}`;
    const baseline = baselineRef.current.get(key);
    if (baseline === undefined) {
      // First sight of this contract/timeframe: mark history as seen without
      // emitting, so only candles that close while watching produce signals.
      baselineRef.current.set(key, newestClosedTime(chart.bars));
      return;
    }
    const fresh = scanClosedBars(chart.bars, chart.symbol, chart.interval, baseline);
    const newest = newestClosedTime(chart.bars);
    if (newest > baseline) baselineRef.current.set(key, newest);
    if (fresh.length) {
      setSignals((prev) => [...fresh.reverse(), ...prev].slice(0, WICK_SIGNALS_KEPT));
    }
  }, [chart]);

  return signals;
}

/** Tail strength: the larger the lower wick, the hotter the row. */
const STRENGTH_CLASS: Record<"pos" | "brand" | "warn", string> = {
  pos: "text-pos",
  brand: "text-primary",
  warn: "text-warn",
};

function strengthTone(rangeShare: number): "pos" | "brand" | "warn" {
  return rangeShare >= 0.85 ? "pos" : rangeShare >= 0.78 ? "brand" : "warn";
}

export const LowerWickSignals = memo(function LowerWickSignals({ chart }: { chart: RadarChart }) {
  const signals = useLowerWickSignals(chart);

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-pos" />
          <h2 className="lbl">Bullish lower wick signals{signals.length ? ` — ${signals.length}` : ""}</h2>
        </div>
        <Tag tone={signals.length ? "pos" : "muted"}>closed candles only</Tag>
      </header>
      {signals.length === 0 ? (
        <p className="num px-3 py-2.5 text-[10.5px] leading-[1.5] text-muted-foreground">
          No qualifying candle has closed yet. A row lands here the moment a candle closes green with a lower shadow of at
          least 70% of its range and 3× its body — never while forming, never for red candles. Larger tails score stronger.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Time</th>
                <th>Timeframe</th>
                <th className="text-right">Price</th>
                <th className="text-right">Lower wick</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => {
                const decimals = priceDecimals(s.close || 1);
                return (
                  <tr key={`${s.symbol}:${s.interval}:${s.time}`}>
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
