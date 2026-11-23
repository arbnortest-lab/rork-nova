/**
 * Squeeze History — what the radar's squeeze read has been doing over time.
 *
 * The instrument layer samples `readSqueeze` every 30 seconds per instrument
 * and keeps 24 hours. The thresholds that decide warm/hot are the radar's
 * own turnover-derived ones — nothing here redefines them. The strip shows
 * the day at a glance; the table lists the warm+hot episodes (transitions
 * out of cold), newest first.
 */

import { useMemo } from "react";

import { Tag } from "@/components/kit";
import { fmtClock, fmtCompactUsd } from "@/lib/format";
import type { SqueezeSample } from "@/store/InstrumentsProvider";
import { cn } from "@/lib/utils";

const LEVEL_BG = {
  cold: "bg-secondary",
  warm: "bg-warn/60",
  hot: "bg-neg/70",
} as const;

/** At most this many bars are drawn; older samples fold into the first. */
const MAX_BARS = 120;

export function SqueezeHistoryPanel({
  symbol,
  history,
  now,
}: {
  symbol: string;
  history: SqueezeSample[];
  now: number;
}) {
  const stats = useMemo(() => {
    const dayAgo = now - 86_400_000;
    const day = history.filter((s) => s.at >= dayAgo);
    const hot = day.filter((s) => s.level === "hot").length;
    const warm = day.filter((s) => s.level === "warm").length;
    const peak = day.reduce((m, s) => Math.max(m, s.volume), 0);
    return { total: day.length, hot, warm, peak, cold: day.length - hot - warm };
  }, [history, now]);

  const episodes = useMemo(() => {
    // Transitions from cold into warm/hot: candidate squeeze starts.
    const out: { at: number; level: "warm" | "hot"; volume: number; direction: SqueezeSample["direction"] }[] = [];
    let prev: SqueezeSample["level"] = "cold";
    for (const s of history) {
      if (s.level !== "cold" && prev === "cold") {
        out.unshift({ at: s.at, level: s.level === "hot" ? "hot" : "warm", volume: s.volume, direction: s.direction });
      }
      prev = s.level;
      if (out.length >= 40) break;
    }
    return out;
  }, [history]);

  // Fold the day into MAX_BARS buckets so the strip stays stable.
  const strip = useMemo(() => {
    if (history.length <= MAX_BARS) return history;
    const bucket = Math.ceil(history.length / MAX_BARS);
    const out: SqueezeSample[] = [];
    for (let i = 0; i < history.length; i += bucket) {
      const chunk = history.slice(i, i + bucket);
      const worst = chunk.find((s) => s.level === "hot") ?? chunk.find((s) => s.level === "warm") ?? chunk[chunk.length - 1];
      out.push(worst);
    }
    return out;
  }, [history]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-2.5 py-1.5">
        <span className="num text-[11px] font-bold tracking-[0.06em]">{symbol}</span>
        <span className="num text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
          {stats.total} samples · 24h
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Tag tone="neg">hot {stats.hot}</Tag>
          <Tag tone="warn">warm {stats.warm}</Tag>
          <Tag tone="muted">cold {stats.cold}</Tag>
          <Tag tone="brand" title="Peak forced-order notional in one 30s window">
            peak {fmtCompactUsd(stats.peak)}
          </Tag>
        </div>
      </div>

      {/* level strip */}
      <div className="flex h-8 items-stretch gap-px border-b border-line-soft px-2.5 py-1.5">
        {strip.length === 0 ? (
          <p className="num self-center text-[10px] text-muted-foreground/60">
            Sampling every 30 seconds — the first buckets appear shortly.
          </p>
        ) : (
          strip.map((s) => (
            <div
              key={s.at}
              title={`${fmtClock(s.at)} — ${s.level} · ${fmtCompactUsd(s.volume)} · ${s.direction}`}
              className={cn("min-w-[2px] flex-1 rounded-[1px]", LEVEL_BG[s.level])}
            />
          ))
        )}
      </div>

      {/* episodes */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table w-full">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="lbl text-left">Episode start</th>
              <th className="lbl text-left">Level</th>
              <th className="lbl text-left">Direction</th>
              <th className="lbl text-right">Forced 1h</th>
            </tr>
          </thead>
          <tbody>
            {episodes.length === 0 ? (
              <tr>
                <td colSpan={4} className="num px-3 py-6 text-center text-[11px] text-muted-foreground/70">
                  No warm or hot episodes in the kept history — every 30s sample sat cold.
                </td>
              </tr>
            ) : (
              episodes.map((e) => (
                <tr key={e.at}>
                  <td className="num text-[10.5px] text-muted-foreground">{fmtClock(e.at)}</td>
                  <td className="num text-[10.5px] font-semibold">
                    <span className={e.level === "hot" ? "text-neg" : "text-warn"}>{e.level.toUpperCase()}</span>
                  </td>
                  <td className="num text-[10.5px] text-muted-foreground">{e.direction.replace("-", " ")}</td>
                  <td className="num text-right text-[10.5px]">{fmtCompactUsd(e.volume)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
