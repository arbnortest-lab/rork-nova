import { Lock, LockOpen, Radar, Zap } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { Button, Metric, Segmented, Tag } from "@/components/kit";
import { fmtClock, fmtCompactUsd, fmtPrice, fmtQty, fmtSignedPct, priceDecimals, timeAgo } from "@/lib/format";
import { routeSummary } from "@/lib/radar/stream";
import {
  CHART_INTERVALS,
  RADAR_STATE_LABEL,
  type ChartInterval,
  type DepthRow,
  type LiqCluster,
  type LiquidationEvent,
  type RadarChart as RadarChartData,
  type RadarRead,
  type RadarStreamStatus,
  type SqueezeRead,
} from "@/lib/radar/types";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { AggTrade, SocketState } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

import { ImbalanceBar, OiTrendTag, SqueezeMeter } from "./gauges";
import { CHART_COLORS, RadarChart, type PriceLineSpec } from "./RadarChart";

/** Whale prints kept per contract — mirrors the provider's cap. */
const WHALES_SHOWN = 40;

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

function fmtCountdown(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function squeezeHeadline(s: SqueezeRead): string {
  if (s.volume <= 0) return "No squeeze pressure detected";
  const amount = fmtCompactUsd(s.volume);
  const heavy = s.level === "hot" ? "Heavy " : s.level === "warm" ? "" : "Light ";
  switch (s.direction) {
    case "short-squeeze":
      return `${heavy}short squeeze — ${fmtCompactUsd(s.shortLiq)} of forced buys in 1h`;
    case "long-flush":
      return `${heavy}long flush — ${fmtCompactUsd(s.longLiq)} of forced sells in 1h`;
    case "mixed":
      return `${heavy}two-sided liquidations — ${amount} in 1h`;
    default:
      return `${amount} of forced orders in 1h`;
  }
}

/* ------------------------------------------------------------------ */
/* Depth                                                               */
/* ------------------------------------------------------------------ */

const DepthLine = memo(function DepthLine({
  row,
  side,
  maxTotal,
  decimals,
}: {
  row: DepthRow;
  side: "bid" | "ask";
  maxTotal: number;
  decimals: number;
}) {
  const share = maxTotal > 0 ? Math.min(100, (row.total / maxTotal) * 100) : 0;
  return (
    <div
      className={cn(
        "relative grid h-[17px] grid-cols-[1fr_1fr_1fr] items-center px-2 text-[10.5px]",
        row.wall && "font-semibold",
      )}
    >
      <span
        className={cn("absolute inset-y-[1px] right-0 rounded-[1px]", side === "bid" ? "bg-pos/[0.12]" : "bg-neg/[0.12]")}
        style={{ width: `${share}%` }}
      />
      {row.wall ? (
        <span className={cn("absolute inset-y-0 left-0 w-[2px]", side === "bid" ? "bg-pos" : "bg-neg")} />
      ) : null}
      <span className={cn("relative", side === "bid" ? "text-pos" : "text-neg")}>{fmtPrice(row.price, decimals)}</span>
      <span className="relative text-right text-foreground/85">{fmtCompactUsd(row.notional).replace("$", "")}</span>
      <span className="relative text-right text-muted-foreground">{fmtCompactUsd(row.total).replace("$", "")}</span>
    </div>
  );
});

export const DepthTable = memo(function DepthTable({ read, decimals }: { read: RadarRead; decimals: number }) {
  const { depth } = read;
  const maxTotal = Math.max(depth.bids[depth.bids.length - 1]?.total ?? 0, depth.asks[depth.asks.length - 1]?.total ?? 0);
  const asks = useMemo(() => depth.asks.slice().reverse(), [depth.asks]);
  const live = !!depth.at;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="lbl">Order book depth</span>
          <span className="num text-[9.5px] uppercase tracking-[0.08em] text-primary">
            {live ? "Live · 20 levels · 100ms" : "waiting"}
          </span>
        </div>
        <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-pos" : "bg-muted-foreground/40")} />
      </div>
      <div className="num grid grid-cols-[1fr_1fr_1fr] px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        <span>Price</span>
        <span className="text-right">Size $</span>
        <span className="text-right">Total $</span>
      </div>
      <div className="num max-h-[560px] overflow-auto">
        {asks.map((row) => (
          <DepthLine key={`a${row.price}`} row={row} side="ask" maxTotal={maxTotal} decimals={decimals} />
        ))}
        <div className="flex h-[22px] items-center justify-between border-y border-line-soft bg-secondary/40 px-2">
          <span className="num text-[11px] font-semibold text-primary">{depth.mid ? fmtPrice(depth.mid, decimals) : "—"}</span>
          <span className="num text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
            spread <span className="text-foreground">{depth.spreadPct === undefined ? "—" : `${depth.spreadPct.toFixed(3)}%`}</span>
          </span>
        </div>
        {depth.bids.map((row) => (
          <DepthLine key={`b${row.price}`} row={row} side="bid" maxTotal={maxTotal} decimals={decimals} />
        ))}
      </div>
      <div className="border-t border-line-soft px-2 py-1.5">
        <div className="lbl mb-1">Whale walls detected</div>
        {read.bidWalls.length || read.askWalls.length ? (
          <div className="num flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]">
            <span className="text-muted-foreground">
              Bid walls:{" "}
              {read.bidWalls.length ? (
                read.bidWalls.map((w, i) => (
                  <span key={w.price} className="text-pos">
                    {i > 0 ? ", " : ""}
                    {fmtPrice(w.price, decimals)}
                    <span className="text-pos/60"> ×{w.strength.toFixed(1)}</span>
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground/60">none</span>
              )}
            </span>
            <span className="text-muted-foreground">
              Ask walls:{" "}
              {read.askWalls.length ? (
                read.askWalls.map((w, i) => (
                  <span key={w.price} className="text-neg">
                    {i > 0 ? ", " : ""}
                    {fmtPrice(w.price, decimals)}
                    <span className="text-neg/60"> ×{w.strength.toFixed(1)}</span>
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground/60">none</span>
              )}
            </span>
          </div>
        ) : (
          <p className="num text-[10.5px] text-muted-foreground/70">
            No level holds 3× the mean resting size on its side.
          </p>
        )}
        {read.book.spoofSuspected ? (
          <p className="num mt-1 text-[10px] text-warn">
            Spoof suspected — {read.book.pulled} wall{read.book.pulled === 1 ? "" : "s"} pulled without trading.
          </p>
        ) : read.book.absorbed ? (
          <p className="num mt-1 text-[10px] text-primary">A wall was absorbed — price traded through it.</p>
        ) : null}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Tape                                                                */
/* ------------------------------------------------------------------ */

const TradeLine = memo(function TradeLine({ t, decimals, whaleAt }: { t: AggTrade; decimals: number; whaleAt: number }) {
  const whale = t.notional >= whaleAt;
  return (
    <div
      className={cn(
        "relative grid h-[19px] grid-cols-[62px_1fr_1fr_44px] items-center gap-2 border-b border-line-soft px-2 text-[10.5px]",
        whale && (t.isBuy ? "bg-pos/[0.08]" : "bg-neg/[0.08]"),
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-[2px]", t.isBuy ? "bg-pos" : "bg-neg", !whale && "opacity-50")} />
      <span className="text-muted-foreground">{fmtClock(t.at)}</span>
      <span className={cn("font-medium", t.isBuy ? "text-pos" : "text-neg")}>{fmtPrice(t.price, decimals)}</span>
      <span className={cn("text-right", whale ? "font-semibold text-foreground" : "text-foreground/80")}>
        {fmtQty(t.qty)}
        {whale ? <span className="ml-1 text-[9px] text-primary">{fmtCompactUsd(t.notional)}</span> : null}
      </span>
      <span className={cn("text-right text-[9.5px] font-semibold uppercase", t.isBuy ? "text-pos" : "text-neg")}>
        {t.isBuy ? "buy" : "sell"}
      </span>
    </div>
  );
});

export const TradeTape = memo(function TradeTape({ read, decimals }: { read: RadarRead; decimals: number }) {
  const [mode, setMode] = useState<"all" | "whales">("all");
  const rows = mode === "whales" ? read.whales : read.trades;
  const flowTone =
    read.recent.imbalance > 0.15 ? "pos" : read.recent.imbalance < -0.15 ? "neg" : ("muted" as const);
  const flowLabel = read.recent.imbalance > 0.15 ? "buyers" : read.recent.imbalance < -0.15 ? "sellers" : "neutral";

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-2 py-1.5">
        <Segmented<"all" | "whales">
          value={mode}
          options={[
            { value: "all", label: `Live trades (${read.trades.length})` },
            { value: "whales", label: `Whales (${read.whales.length})` },
          ]}
          onChange={setMode}
          className="h-7 w-[272px]"
        />
        <span className="num ml-auto text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          1h buy <span className="text-pos">{fmtCompactUsd(read.flow.buy)}</span> · sell{" "}
          <span className="text-neg">{fmtCompactUsd(read.flow.sell)}</span>
        </span>
        <Tag tone={flowTone}>{flowLabel}</Tag>
      </div>
      <div className="num grid grid-cols-[62px_1fr_1fr_44px] gap-2 px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        <span>Time</span>
        <span>Price</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Side</span>
      </div>
      <div className="num max-h-[560px] overflow-auto">
        {rows.length ? (
          rows.map((t, i) => <TradeLine key={`${t.at}-${i}`} t={t} decimals={decimals} whaleAt={read.whaleAt} />)
        ) : (
          <p className="px-2 py-6 text-center text-[10.5px] text-muted-foreground/70">
            {mode === "whales" ? `No print above ${fmtCompactUsd(read.whaleAt)} yet.` : "Waiting for prints…"}
          </p>
        )}
      </div>
      <p className="num border-t border-line-soft px-2 py-1.5 text-[9.5px] leading-[1.5] text-muted-foreground">
        Whale = print ≥ {fmtCompactUsd(read.whaleAt)}, scaled to this contract&apos;s tape; last {WHALES_SHOWN} kept. Absorption:{" "}
        <span className={read.recent.absorption === "none" ? "text-muted-foreground" : "text-warn"}>
          {read.recent.absorption === "none" ? "none" : read.recent.absorption === "upper" ? "buying absorbed" : "selling absorbed"}
        </span>
        {read.recent.divergence !== "none" ? (
          <>
            {" "}
            · CVD divergence <span className={read.recent.divergence === "bearish" ? "text-neg" : "text-pos"}>{read.recent.divergence}</span>
          </>
        ) : null}
      </p>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Liquidations                                                        */
/* ------------------------------------------------------------------ */

const ClusterLine = memo(function ClusterLine({ c, decimals }: { c: LiqCluster; decimals: number }) {
  const shortSide = c.shortLiq >= c.longLiq;
  return (
    <div className="relative grid h-[20px] grid-cols-[1fr_auto_auto] items-center gap-2 px-2 text-[10.5px]">
      <span
        className={cn("absolute inset-y-[2px] left-0 rounded-r-[1px]", shortSide ? "bg-pos/[0.14]" : "bg-neg/[0.14]")}
        style={{ width: `${Math.round(c.share * 100)}%` }}
      />
      <span className={cn("relative font-medium", shortSide ? "text-pos" : "text-neg")}>
        {fmtPrice(c.price, decimals)}
        <span className="ml-1.5 text-[9.5px] text-muted-foreground">{fmtSignedPct(c.distancePct, 2)}</span>
      </span>
      <span className="relative text-foreground/85">{fmtCompactUsd(c.notional)}</span>
      <span className="relative w-10 text-right text-muted-foreground">{Math.round(c.share * 100)}%</span>
    </div>
  );
});

const LiqLine = memo(function LiqLine({ l, decimals }: { l: LiquidationEvent; decimals: number }) {
  const short = l.side === "BUY";
  return (
    <div className="grid h-[19px] grid-cols-[62px_auto_1fr_auto] items-center gap-2 border-b border-line-soft px-2 text-[10.5px]">
      <span className="text-muted-foreground">{fmtClock(l.at)}</span>
      <span className={cn("text-[9px] font-semibold uppercase tracking-[0.08em]", short ? "text-pos" : "text-neg")}>
        {short ? "short liq" : "long liq"}
      </span>
      <span className="text-foreground/85">{fmtPrice(l.price, decimals)}</span>
      <span className="font-semibold">{fmtCompactUsd(l.notional)}</span>
    </div>
  );
});

export const LiquidationsPane = memo(function LiquidationsPane({ read, decimals }: { read: RadarRead; decimals: number }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="lbl">Liquidations</span>
          <span className={cn("num text-[10.5px] font-semibold", read.squeeze.count ? "text-neg" : "text-muted-foreground")}>
            ({read.squeeze.count})
          </span>
          <span className="num text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">1h · !forceOrder@arr</span>
        </div>
        <span className={cn("h-1.5 w-1.5 rounded-full", read.squeeze.count ? "bg-neg" : "bg-muted-foreground/40")} />
      </div>

      <div className="border-b border-line-soft px-2 py-1.5">
        <div className="lbl mb-1">Synthetic liquidation clusters</div>
        {read.clusters.length ? (
          <div className="num -mx-2">
            {read.clusters.map((c) => (
              <ClusterLine key={c.price} c={c} decimals={decimals} />
            ))}
          </div>
        ) : (
          <p className="num text-[10.5px] text-muted-foreground/70">No forced orders inside the window yet.</p>
        )}
        <p className="num mt-1 text-[9.5px] leading-[1.5] text-muted-foreground">
          Forced-order notional bucketed in 0.2% price bins around the mid; green = shorts liquidated there, red = longs.
          The venue samples this stream (≤1 order per contract per second), so density is a floor.
        </p>
      </div>

      <div className="num max-h-[400px] overflow-auto">
        {read.liquidations.length ? (
          read.liquidations.map((l, i) => <LiqLine key={`${l.at}-${i}`} l={l} decimals={decimals} />)
        ) : (
          <p className="px-2 py-6 text-center text-[10.5px] text-muted-foreground/70">No liquidations in the last hour.</p>
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

const EMPTY_TITLE: Record<"off" | "paused" | "waiting", string> = {
  off: "Radar off",
  paused: "Engine paused",
  waiting: "Attaching streams",
};

/**
 * The focused contract's micro-structure: chart, weighted book imbalance,
 * 20-level depth with whale walls, the tape, liquidations and the squeeze
 * meter. Loads for whichever contract is clicked in the list.
 */
export const RadarPanel = memo(function RadarPanel({
  symbol,
  read,
  macro,
  chart,
  interval,
  onInterval,
  held,
  onToggleHold,
  enabled,
  paused,
  status,
  now,
}: {
  symbol: string;
  read: RadarRead | undefined;
  macro: ExhaustionRead | undefined;
  chart: RadarChartData;
  interval: ChartInterval;
  onInterval: (interval: ChartInterval) => void;
  held: boolean;
  onToggleHold: () => void;
  enabled: boolean;
  paused: boolean;
  status: RadarStreamStatus;
  now: number;
}) {
  const price = read?.depth.mid ?? read?.trades[0]?.price ?? macro?.price ?? chart.bars[chart.bars.length - 1]?.close ?? 0;
  const decimals = priceDecimals(price || 1);

  const lines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    if (macro?.high24h) out.push({ id: "h24", price: macro.high24h, color: CHART_COLORS.down, title: "24H HIGH", style: "dashed" });
    if (read) {
      for (const w of read.askWalls.slice(0, 2)) {
        out.push({ id: `aw${w.price}`, price: w.price, color: CHART_COLORS.down, title: `WALL ${fmtCompactUsd(w.notional)}`, style: "dotted" });
      }
      for (const w of read.bidWalls.slice(0, 2)) {
        out.push({ id: `bw${w.price}`, price: w.price, color: CHART_COLORS.up, title: `WALL ${fmtCompactUsd(w.notional)}`, style: "dotted" });
      }
      for (const c of read.clusters.slice(0, 3)) {
        out.push({ id: `lq${c.price}`, price: c.price, color: CHART_COLORS.amber, title: `LIQ ${fmtCompactUsd(c.notional)}` });
      }
    }
    return out;
  }, [macro?.high24h, read]);

  const emptyReason: "off" | "paused" | "waiting" | null = !enabled ? "off" : paused ? "paused" : !read ? "waiting" : null;
  const squeeze = read?.squeeze;
  const squeezeTone = squeeze?.level === "hot" ? "text-neg" : squeeze?.level === "warm" ? "text-warn" : "text-primary";
  const lastTick = read ? Math.max(read.lastDepthAt ?? 0, read.lastTradeAt ?? 0) : 0;

  return (
    <section className={cn("panel overflow-hidden", read?.state === "signal" && "shadow-[0_0_0_1px_hsl(var(--neg)/0.5)]")}>
      {/* header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-secondary/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <Zap className={cn("h-[13px] w-[13px]", read?.state === "signal" ? "text-neg" : "text-primary")} />
          <h2 className="num text-[12px] font-semibold uppercase tracking-[0.14em] text-foreground">
            Squeeze radar · {symbol}
          </h2>
          {read ? <Tag tone={stateTone(read.state)}>{RADAR_STATE_LABEL[read.state]}</Tag> : null}
          {macro ? <Tag tone="muted">{macro.passedCount}/4 gates</Tag> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Tag tone={enabled ? SOCKET_TONE[status.state] : "muted"} title={enabled ? routeSummary(status, now) : undefined}>
            <Radar className="h-[9px] w-[9px]" />
            {enabled ? status.state : "off"}
            {lastTick ? ` · ${timeAgo(lastTick, now)}` : ""}
          </Tag>
          <Segmented
            value={interval}
            options={CHART_INTERVALS.map((i) => ({ value: i.value, label: i.label }))}
            onChange={onInterval}
            className="h-7 w-[150px]"
          />
          <Button
            tone={held ? "solid" : "ghost"}
            size="sm"
            onClick={onToggleHold}
            title={held ? "Release — streams detach when the contract disarms" : "Hold — keep streams attached while in a position"}
          >
            {held ? <Lock className="h-[11px] w-[11px]" /> : <LockOpen className="h-[11px] w-[11px]" />}
            {held ? "Held" : "Hold"}
          </Button>
        </div>
      </header>

      {emptyReason ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <Radar className="h-5 w-5 text-muted-foreground/40" />
          <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">{EMPTY_TITLE[emptyReason]}</p>
          <p className="max-w-[360px] text-[11px] leading-[1.5] text-muted-foreground/70">
            {emptyReason === "off"
              ? "Enable the radar in Config to stream depth, trades and liquidations for armed contracts."
              : emptyReason === "paused"
                ? "Resume the engine to reopen the radar socket."
                : `Subscribing ${symbol} to depth on the public socket and trades, mark price and liquidations on the market socket. First frames land within a second or two.`}
          </p>
        </div>
      ) : read ? (
        <>
          {/* status band */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2.5",
              read.squeeze.level === "hot" ? "bg-neg-soft" : read.squeeze.level === "warm" ? "bg-warn-soft" : "bg-secondary/25",
            )}
          >
            <div className="min-w-0">
              <div className="num text-[15px] font-bold uppercase leading-none tracking-[0.1em]">
                <span className="text-muted-foreground">Status: </span>
                <span className={squeezeTone}>{read.squeeze.level}</span>
              </div>
              <p className="num mt-1.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">{squeezeHeadline(read.squeeze)}</p>
            </div>
            <div className="ml-auto text-right">
              <div className="lbl">Squeeze volume</div>
              <div className={cn("num mt-1 text-[19px] font-semibold leading-none", squeezeTone)}>{fmtCompactUsd(read.squeeze.volume)}</div>
            </div>
          </div>

          {/* metrics */}
          <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5 border-b border-border px-3 py-2.5">
            <Metric label="Mark price" value={read.mark ? fmtPrice(read.mark.markPrice, decimals) : "—"} size="sm" tone="brand" />
            <Metric label="Last price" value={price ? fmtPrice(price, decimals) : "—"} size="sm" />
            <Metric
              label="Funding rate"
              value={read.mark ? `${read.mark.fundingRate >= 0 ? "+" : ""}${read.mark.fundingRate.toFixed(4)}%` : "—"}
              size="sm"
              tone={read.mark ? (read.mark.fundingRate >= 0 ? "pos" : "neg") : "muted"}
            />
            <Metric label="Next funding" value={read.mark ? fmtCountdown(read.mark.nextFundingTime - now) : "—"} size="sm" />
            <Metric
              label="Open interest"
              value={read.oi.current !== undefined ? fmtQty(read.oi.current) : "—"}
              sub={read.oi.notionalUsd !== undefined ? fmtCompactUsd(read.oi.notionalUsd) : undefined}
              size="sm"
            />
            <div className="min-w-0">
              <div className="lbl truncate">OI 5-min trend</div>
              <div className="mt-1 flex items-center gap-1.5">
                <OiTrendTag oi={read.oi} />
                <span className="num text-[10px] text-muted-foreground">
                  {read.oi.snapshots ? `${read.oi.snapshots} snapshots` : read.oiPolledAt ? "no data from venue" : "loading"}
                  {read.oi.read.change5m !== undefined ? ` · ${fmtSignedPct(read.oi.read.change5m, 2)}` : ""}
                </span>
              </div>
            </div>
            <Metric label="OI regime" value={read.oi.read.regime.replace("-", " ")} size="sm" tone="muted" />
            <Metric label="24h volume" value={macro ? fmtCompactUsd(macro.quoteVolume) : "—"} size="sm" />
            <Metric
              label="24h change"
              value={macro ? fmtSignedPct(macro.changePct, 2) : "—"}
              size="sm"
              tone={macro ? (macro.changePct >= 0 ? "pos" : "neg") : "muted"}
            />
          </div>

          {/* imbalance + squeeze meter */}
          <div className="grid gap-4 border-b border-border px-3 py-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ImbalanceBar
              weightedBidShare={read.depth.weightedBidShare}
              rawBidShare={read.depth.rawBidShare}
              bidNotional={read.depth.bidNotional}
              askNotional={read.depth.askNotional}
              pressure={read.depth.pressure}
              pressurePts={read.depth.pressurePts}
            />
            <SqueezeMeter squeeze={read.squeeze} />
          </div>

          {/* chart */}
          <div className="relative border-b border-border">
            <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-2">
              <span className="num text-[10.5px] font-semibold uppercase tracking-[0.1em] text-foreground">
                {symbol} · {interval}
              </span>
              <span className="num text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                {chart.loading ? "loading history" : chart.error ? `history failed: ${chart.error}` : `${chart.bars.length} bars · live`}
              </span>
            </div>
            <RadarChart bars={chart.bars} seriesKey={`${chart.symbol}:${chart.interval}`} decimals={decimals} lines={lines} />
            <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              <span>
                <span className="text-neg">— —</span> 24h high
              </span>
              <span>
                <span className="text-neg">···</span> ask wall
              </span>
              <span>
                <span className="text-pos">···</span> bid wall
              </span>
              <span>
                <span className="text-primary">—</span> liquidation cluster
              </span>
            </div>
          </div>

          {/* depth · tape · liquidations */}
          <div className="grid divide-y divide-border lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
            <DepthTable read={read} decimals={decimals} />
            <TradeTape read={read} decimals={decimals} />
            <LiquidationsPane read={read} decimals={decimals} />
          </div>

          <p className="num border-t border-line-soft px-3 py-2 text-[10px] leading-[1.5] text-muted-foreground">
            Pure signal radar — no auto-trading. Streams attached {timeAgo(read.attachedAt, now)}; they close two minutes after
            the contract leaves 3 of 4 unless it is held or in focus.
          </p>
        </>
      ) : null}
    </section>
  );
});
