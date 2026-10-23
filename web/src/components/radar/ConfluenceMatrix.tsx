import { Radar } from "lucide-react";
import { memo } from "react";

import { Tag } from "@/components/kit";
import { fmtCompactUsd, fmtPrice, fmtSignedPct, timeAgo } from "@/lib/format";
import { routeSummary } from "@/lib/radar/stream";
import { OI_TREND_LABEL, oiTone, SQUEEZE_TONE, TEXT_TONE } from "@/lib/radar/tone";
import { RADAR_STATE_LABEL, type RadarRead, type RadarStreamStatus } from "@/lib/radar/types";
import type { SocketState } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

import { MiniImbalance, MiniSqueeze } from "./gauges";

const SOCKET_TONE: Record<SocketState, "pos" | "warn" | "neg" | "muted"> = {
  open: "pos",
  connecting: "warn",
  retrying: "warn",
  blocked: "neg",
  idle: "muted",
};

function stateTone(state: RadarRead["state"]): "neg" | "warn" | "muted" {
  return state === "signal" ? "neg" : state === "armed" ? "warn" : "muted";
}

const MatrixRow = memo(function MatrixRow({
  read,
  active,
  now,
  onSelect,
}: {
  read: RadarRead;
  active: boolean;
  now: number;
  onSelect: (symbol: string) => void;
}) {
  const top = read.clusters[0];
  const price = read.depth.mid ?? read.trades[0]?.price;
  const lastAt = Math.max(read.lastDepthAt ?? 0, read.lastTradeAt ?? 0);
  const wallsText =
    read.bidWalls.length || read.askWalls.length
      ? `${read.bidWalls.length}↑ ${read.askWalls.length}↓`
      : "none";

  return (
    <tr
      onClick={() => onSelect(read.symbol)}
      className={cn("cursor-pointer", active && "bg-primary/[0.07]")}
      aria-selected={active}
    >
      <td>
        <div className="flex items-center gap-2">
          <span className={cn("font-semibold", active ? "text-primary" : "text-foreground")}>{read.symbol}</span>
          <Tag tone={stateTone(read.state)}>{RADAR_STATE_LABEL[read.state]}</Tag>
        </div>
      </td>
      <td className="text-right">{price ? fmtPrice(price) : "—"}</td>
      <td>
        <div className="flex items-center gap-2">
          <MiniImbalance bidShare={read.depth.weightedBidShare} />
          <span
            className={cn(
              "text-[11px]",
              read.depth.pressure === "bids" ? "text-pos" : read.depth.pressure === "asks" ? "text-neg" : "text-muted-foreground",
            )}
          >
            {read.depth.at ? `${read.depth.weightedBidShare.toFixed(0)}/${(100 - read.depth.weightedBidShare).toFixed(0)}` : "—"}
          </span>
        </div>
      </td>
      <td>
        <span className={cn("text-[11px]", wallsText === "none" ? "text-muted-foreground/60" : "text-foreground")}>
          {wallsText}
        </span>
        {read.askWalls[0] ? (
          <span className="ml-1.5 text-[10px] text-neg">{fmtPrice(read.askWalls[0].price)}</span>
        ) : null}
      </td>
      <td>
        <span className={cn("text-[11px]", TEXT_TONE[oiTone(read.oi.trend)])}>{OI_TREND_LABEL[read.oi.trend]}</span>
        {read.oi.read.change5m !== undefined ? (
          <span className="ml-1.5 text-[10px] text-muted-foreground">{fmtSignedPct(read.oi.read.change5m, 2)}</span>
        ) : null}
      </td>
      <td>
        <div className="flex items-center gap-2">
          <MiniSqueeze squeeze={read.squeeze} />
          <span className={cn("text-[11px]", TEXT_TONE[SQUEEZE_TONE[read.squeeze.level]])}>
            {fmtCompactUsd(read.squeeze.volume)}
          </span>
        </div>
      </td>
      <td>
        {top ? (
          <span className="text-[11px]">
            <span className={top.shortLiq >= top.longLiq ? "text-pos" : "text-neg"}>{fmtPrice(top.price)}</span>
            <span className="ml-1.5 text-muted-foreground">
              {fmtCompactUsd(top.notional)} · {read.clusters.length} bins
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">none in 1h</span>
        )}
      </td>
      <td className="text-right text-muted-foreground">{lastAt ? timeAgo(lastAt, now) : "—"}</td>
    </tr>
  );
});

/**
 * One row per armed contract: the whole micro layer at a glance. Clicking a
 * row focuses the contract, which loads its chart and full depth below.
 */
export const ConfluenceMatrix = memo(function ConfluenceMatrix({
  rows,
  selected,
  status,
  streams,
  now,
  enabled,
  onSelect,
}: {
  rows: RadarRead[];
  selected: string;
  status: RadarStreamStatus;
  streams: number;
  now: number;
  enabled: boolean;
  onSelect: (symbol: string) => void;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="flex items-center gap-2">
          <Radar className={cn("h-[13px] w-[13px]", rows.length ? "text-neg" : "text-muted-foreground")} />
          <h2 className="lbl">Confluence matrix{rows.length ? ` — ${rows.length} armed` : ""}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Tag tone={enabled ? SOCKET_TONE[status.state] : "muted"} title={enabled ? routeSummary(status, now) : undefined}>
            Radar {enabled ? status.state : "off"}
            {enabled && status.state === "open" ? ` · ${streams} streams` : ""}
          </Tag>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="num px-3 py-2.5 text-[10.5px] leading-[1.5] text-muted-foreground">
          {enabled
            ? "Radar idle. Depth, trades, mark price and liquidation streams attach automatically the moment a contract reaches 3 of 4 gates, and detach two minutes after it falls away. Only the focused contract streams right now."
            : "Radar off. Enable it under Settings → Radar to attach live micro-structure streams to armed contracts."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th className="text-right">Price</th>
                <th>Book imbalance</th>
                <th>Whale walls</th>
                <th>OI 5-min</th>
                <th>Squeeze 1h</th>
                <th>Liq. cluster</th>
                <th className="text-right">Tick</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((read) => (
                <MatrixRow key={read.symbol} read={read} active={read.symbol === selected} now={now} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
