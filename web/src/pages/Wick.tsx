import {
  Activity,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  Pause,
  Pin,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { BtcTrapPanel } from "@/components/BtcTrapPanel";
import { Button, Metric, Panel, Tag } from "@/components/kit";
import { OnChainBadge, OnChainDetail } from "@/components/OnChainBadge";
import { ConfluenceMatrix } from "@/components/radar/ConfluenceMatrix";
import { MiniImbalance, MiniSqueeze } from "@/components/radar/gauges";
import { RadarPanel } from "@/components/radar/RadarPanel";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Input } from "@/components/ui/input";
import { fmtClock, fmtCompactUsd, fmtPrice, fmtSignedPct, timeAgo } from "@/lib/format";
import {
  INDICATOR_MANUAL_FIGURES,
  INDICATOR_MANUAL_PAGES,
  ENGINE_AUDIT_PAGES,
  ENGINE_AUDIT_URL,
  ENGINE_AUDIT_VERSION,
  INDICATOR_MANUAL_URL,
  MONTHLY_MANUAL_FIGURES,
  MONTHLY_MANUAL_PAGES,
  MONTHLY_MANUAL_URL,
  MONTHLY_PINE_FILENAME,
  MONTHLY_PINE_URL,
  MONTHLY_PINE_VERSION,
  PINE_FILENAME,
  PINE_URL,
  PINE_VERSION,
  VWAP_PINE_FILENAME,
  VWAP_PINE_URL,
  VWAP_PINE_VERSION,
} from "@/lib/manual";
import type { OnChainJob } from "@/lib/onchain/schedule";
import { chainBackendView } from "@/lib/onchainView";
import type { RadarRead } from "@/lib/radar/types";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import type { GateRead, SocketState, TrapSide, WickAlert } from "@/lib/wick/types";
import { UNIVERSE_LABEL } from "@/lib/wick/universe";
import { cn } from "@/lib/utils";
import { useOnChain } from "@/store/OnChainProvider";
import { RADAR_ARM_AT, useRadar } from "@/store/RadarProvider";
import { useWick } from "@/store/WickProvider";

/* ------------------------------------------------------------------ */
/* Presentational helpers                                              */
/* ------------------------------------------------------------------ */

const SOCKET_TONE: Record<SocketState, "pos" | "warn" | "neg" | "muted"> = {
  open: "pos",
  connecting: "warn",
  retrying: "warn",
  blocked: "neg",
  idle: "muted",
};

function sideTone(side: TrapSide): "neg" | "muted" {
  return side === "short" ? "neg" : "muted";
}

/**
 * One gate line: a state mark, the criterion, the numbers behind it, and a
 * meter that fills to the threshold and stops there.
 */
const GateLine = memo(function GateLine({ gate, index }: { gate: GateRead; index: number }) {
  const state = gate.passed ? "pass" : gate.measured ? "fail" : "idle";

  return (
    <li className="flex gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0">
      <span
        className={cn(
          "mt-[1px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[3px] border text-[9px] font-bold",
          state === "pass"
            ? "border-pos/50 bg-pos-soft text-pos"
            : state === "fail"
              ? "border-border bg-secondary text-muted-foreground/60"
              : "border-dashed border-border text-muted-foreground/35",
        )}
      >
        {state === "pass" ? <Check className="h-[9px] w-[9px]" strokeWidth={3.5} /> : index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "num text-[10.5px] font-semibold uppercase tracking-[0.1em]",
              state === "pass" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {gate.label}
          </span>
          <span
            className={cn(
              "num shrink-0 text-[9.5px] uppercase tracking-[0.1em]",
              state === "pass" ? "text-pos" : state === "fail" ? "text-muted-foreground/70" : "text-muted-foreground/40",
            )}
          >
            {state === "pass" ? "pass" : state === "fail" ? "waiting" : "no data"}
          </span>
        </div>

        <p
          className={cn(
            "mt-1 text-[11.5px] leading-[1.45]",
            state === "idle" ? "italic text-muted-foreground/55" : "text-muted-foreground",
          )}
        >
          {gate.detail}
        </p>

        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-out",
              gate.passed ? "bg-pos" : "bg-muted-foreground/45",
            )}
            style={{ width: `${Math.round(gate.progress * 100)}%` }}
          />
        </div>
      </div>
    </li>
  );
});

/** Where price sits in its 24h range. The high is the level that matters. */
function RangeRail({ read }: { read: ExhaustionRead }) {
  const pos = Math.max(0, Math.min(1, read.rangePos));
  const pinned = read.gates.find((g) => g.key === "pin")?.passed ?? false;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="lbl">24h low {fmtPrice(read.low24h)}</span>
        <span className="lbl">{fmtPrice(read.high24h)} 24h high</span>
      </div>
      <div className="relative h-[6px] w-full rounded-full bg-secondary">
        <div className="absolute inset-y-0 left-0 w-[14%] rounded-l-full bg-pos/20" />
        <div className="absolute inset-y-0 right-0 w-[14%] rounded-r-full bg-neg/20" />
        <div
          className={cn(
            "absolute top-1/2 h-[13px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-700 ease-out",
            pinned
              ? read.rangePos > 0.5
                ? "bg-neg shadow-[0_0_8px_hsl(var(--neg))]"
                : "bg-pos shadow-[0_0_8px_hsl(var(--pos))]"
              : "bg-foreground",
          )}
          style={{ left: `${pos * 100}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Focus panel                                                         */
/* ------------------------------------------------------------------ */

const FocusPanel = memo(function FocusPanel({
  read,
  symbol,
  pinned,
  onTogglePin,
  blocked,
  paused,
  onChain,
  now,
  onScanNow,
  onRescan,
}: {
  read: ExhaustionRead | undefined;
  symbol: string;
  pinned: boolean;
  onTogglePin: () => void;
  blocked: boolean;
  paused: boolean;
  /** The add-on's newest scan for this contract, if any. */
  onChain: OnChainJob | undefined;
  now: number;
  onScanNow: () => void;
  onRescan: (id: string) => void;
}) {
  if (!read) {
    return (
      <section className="panel flex min-h-[420px] flex-col items-center justify-center gap-2 px-6 text-center">
        <Activity className="h-5 w-5 text-muted-foreground/40" />
        <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">
          {blocked ? "Venue unreachable" : paused ? "Engine paused" : `Waiting for ${symbol}`}
        </p>
        {!blocked && !paused ? (
          <p className="max-w-[320px] text-[11px] leading-[1.5] text-muted-foreground/70">
            Two all-market streams are connecting. The four exhaustion gates start reporting within a couple of
            seconds.
          </p>
        ) : null}
      </section>
    );
  }

  const armed = read.armed;
  // Every armed setup is a short, so the accent is always the bearish one.
  const tone = sideTone(armed ? "short" : "none");

  return (
    <section
      className={cn(
        "panel relative overflow-hidden transition-shadow duration-500",
        armed && "shadow-[0_0_0_1px_hsl(var(--neg)/0.5)]",
      )}
    >
      {/* verdict band */}
      <div
        className={cn(
          "relative border-b border-border px-3.5 py-3 transition-colors duration-500",
          armed ? "bg-neg-soft" : "bg-secondary/25",
        )}
      >
        {armed ? <div className="pulse-rail absolute inset-x-0 top-0 h-[2px]" data-side="short" /> : null}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onTogglePin}
                aria-label={pinned ? `Unpin ${read.symbol}` : `Pin ${read.symbol}`}
                title={pinned ? "Unpin — may lose its history slot" : "Pin — keeps kline history attached"}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-[3px] transition-colors",
                  pinned ? "text-primary" : "text-muted-foreground/40 hover:text-foreground",
                )}
              >
                <Pin className="h-[12px] w-[12px]" />
              </button>
              <h2 className="num text-[15px] font-semibold tracking-[0.04em] text-foreground">{read.symbol}</h2>
              {read.deep ? <Tag tone="pos">history</Tag> : <Tag tone="muted">tier 1</Tag>}
            </div>

            <p
              className={cn(
                "num mt-2 text-[13px] font-bold uppercase leading-none tracking-[0.1em]",
                armed ? "text-neg" : "text-muted-foreground",
              )}
            >
              {armed
                ? "SHORT — bull trap at the 24h high"
                : `${read.passedCount} of 4 gates — no setup`}
            </p>
          </div>

          <div className="flex items-start gap-4">
            <div className="text-right">
              <div className="num text-[19px] font-semibold leading-none">{fmtPrice(read.price)}</div>
              <div className={cn("num mt-1.5 text-[11px] leading-none", read.changePct >= 0 ? "text-pos" : "text-neg")}>
                {fmtSignedPct(read.changePct, 2)}
              </div>
            </div>
            <div className="text-right">
              <div className="lbl">Conviction</div>
              <div
                className={cn(
                  "num mt-1 text-[19px] font-semibold leading-none",
                  armed ? "text-neg" : "text-muted-foreground/40",
                )}
              >
                {armed ? read.conviction : "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3">
          <RangeRail read={read} />
        </div>
      </div>

      {/* measurements */}
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5 border-b border-border px-3.5 py-2.5">
        <Metric
          label="To 24h high"
          value={read.extremeBps === undefined ? "—" : `${read.extremeBps.toFixed(1)} bps`}
          size="sm"
          tone={read.gates[0]?.passed ? tone : "muted"}
        />
        <Metric
          label="RVOL"
          value={read.rvol === undefined ? "—" : `${Math.round(read.rvol)}%`}
          size="sm"
          tone={read.gates[1]?.passed ? "warn" : "muted"}
        />
        <Metric
          label="Cooling"
          value={
            read.rvolAcceleration === undefined
              ? "—"
              : `${read.rvolAcceleration > 0 ? "+" : ""}${Math.round(read.rvolAcceleration)}`
          }
          size="sm"
          tone={(read.rvolAcceleration ?? 1) <= 0 ? "pos" : "neg"}
        />
        <Metric
          label="Rejection wick"
          value={read.wickPct === undefined ? "—" : `${read.wickPct.toFixed(1)}%`}
          size="sm"
          tone={read.gates[2]?.passed ? tone : "muted"}
        />
        <Metric
          label={read.yearDays ? `${read.yearDays}d high` : "Horizon high"}
          value={read.yearHigh === undefined ? "—" : fmtPrice(read.yearHigh)}
          size="sm"
        />
        <Metric
          label={read.yearDays ? `${read.yearDays}d low` : "Horizon low"}
          value={read.yearLow === undefined ? "—" : fmtPrice(read.yearLow)}
          size="sm"
        />
        <Metric label="Turnover" value={fmtCompactUsd(read.quoteVolume)} size="sm" />
      </div>

      {/* the four gates */}
      <ul>
        {read.gates.map((gate, i) => (
          <GateLine key={gate.key} gate={gate} index={i} />
        ))}
      </ul>

      {/* on-chain add-on: reads the gates' verdict, never feeds back into it */}
      <div className="border-t border-line-soft px-3.5 py-2">
        <div className="flex items-center gap-2">
          {onChain ? (
            <OnChainBadge job={onChain} now={now} />
          ) : (
            <span className="num text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/60">
              On-Chain: — · scans when a signal fires
            </span>
          )}
          <Button
            tone="ghost"
            size="sm"
            onClick={onScanNow}
            className="ml-auto h-6 px-2 text-[10px]"
            title="Scan exchange flow for this contract now, anchored at the current time"
          >
            <ScanSearch className="h-[10px] w-[10px]" />
            Scan now
          </Button>
        </div>
        {onChain ? (
          <div className="mt-1.5">
            <OnChainDetail job={onChain} now={now} onRescan={onRescan} />
          </div>
        ) : null}
      </div>

      <p className="num border-t border-line-soft px-3.5 py-2 text-[10px] leading-[1.5] text-muted-foreground">
        All four gates must pass together. A gate that cannot be measured never counts as passed, so a contract
        without kline history can never arm.
      </p>
    </section>
  );
});

/* ------------------------------------------------------------------ */
/* Candidate strip                                                     */
/* ------------------------------------------------------------------ */

const CandidateChip = memo(function CandidateChip({
  read,
  active,
  radar,
  onSelect,
}: {
  read: ExhaustionRead;
  active: boolean;
  /** The micro layer's read, present only while streams are attached. */
  radar: RadarRead | undefined;
  onSelect: (symbol: string) => void;
}) {
  const armedRadar = radar && radar.state !== "watch";
  return (
    <button
      type="button"
      onClick={() => onSelect(read.symbol)}
      className={cn(
        "num flex shrink-0 items-center gap-1.5 rounded-[3px] border px-2 py-1 text-[10.5px] transition-colors",
        active
          ? "border-primary/50 bg-primary/12 text-primary"
          : read.armed
            ? "border-neg/40 bg-neg-soft text-neg"
            : read.passedCount >= RADAR_ARM_AT
              ? "border-warn/40 bg-warn-soft text-warn"
              : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="font-semibold">{read.symbol.replace(/USDT$/, "")}</span>
      <span className="text-[9.5px] opacity-70">{read.passedCount}/4</span>
      {armedRadar ? (
        <span className="ml-0.5 flex items-center gap-1.5 border-l border-border pl-1.5">
          <MiniImbalance bidShare={radar.depth.weightedBidShare} className="w-[28px]" />
          <MiniSqueeze squeeze={radar.squeeze} />
        </span>
      ) : null}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Alert feed                                                          */
/* ------------------------------------------------------------------ */

const AlertRow = memo(function AlertRow({
  alert,
  onSelect,
  onDismiss,
  job,
  now,
  onRescan,
}: {
  alert: WickAlert;
  onSelect: (symbol: string) => void;
  onDismiss: (id: string) => void;
  /** The add-on's scan for this signal, when one was started. */
  job: OnChainJob | undefined;
  now: number;
  onRescan: (id: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(false);

  return (
    <li className={cn("border-b border-line-soft last:border-b-0", !alert.seen && "bg-primary/[0.06]")}>
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            onSelect(alert.symbol);
            setOpen((v) => !v);
          }}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="num mt-[2px] shrink-0 rounded-[2px] bg-neg/15 px-1 py-[1px] text-[9px] font-bold uppercase tracking-[0.08em] text-neg">
            SHORT
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="num text-[12px] font-semibold">{alert.symbol}</span>
              <span className="num text-[11px] text-muted-foreground">{fmtPrice(alert.price)}</span>
              {alert.conviction > 0 ? (
                <span className="num text-[11px] font-bold text-neg">{alert.conviction}</span>
              ) : null}
              <span className="num ml-auto shrink-0 text-[10px] text-muted-foreground">{timeAgo(alert.at)}</span>
            </div>
            <p className="num mt-0.5 truncate text-[10.5px] text-muted-foreground">
              extreme {fmtPrice(alert.extreme)}
              {alert.rvol === undefined ? "" : ` · RVOL ${Math.round(alert.rvol)}%`}
              {alert.wickPct === undefined ? "" : ` · wick ${alert.wickPct.toFixed(0)}%`}
            </p>
            {job ? <OnChainBadge job={job} now={now} compact className="mt-1" /> : null}
          </div>
          <ChevronRight
            className={cn(
              "mt-[2px] h-[12px] w-[12px] shrink-0 text-muted-foreground/50 transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          onClick={() => onDismiss(alert.id)}
          aria-label="Dismiss"
          className="mt-[2px] shrink-0 text-muted-foreground/35 transition-colors hover:text-neg"
        >
          <X className="h-[11px] w-[11px]" />
        </button>
      </div>

      {open ? (
        <ul className="border-t border-line-soft bg-background/40 px-3 py-1.5">
          {alert.reasons.map((reason) => (
            <li key={reason} className="num py-[3px] text-[10.5px] leading-[1.45] text-muted-foreground">
              <span className="text-pos">✓</span> {reason}
            </li>
          ))}
          {job ? (
            <li className="mt-1 border-t border-line-soft pt-1.5">
              <OnChainDetail job={job} now={now} onRescan={onRescan} defaultOpen />
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Wick() {
  const {
    rules,
    prefs,
    patchPrefs,
    reads,
    focus,
    select,
    togglePin,
    armedCount,
    tracked,
    excluded,
    alerts,
    unseen,
    markAllSeen,
    dismiss,
    clearAlerts,
    status,
    scannedAt,
    refreshNow,
    refreshing,
    refreshedAt,
    requestPermission,
    permission,
  } = useWick();

  const {
    enabled: chainEnabled,
    byId: chainById,
    forSymbol: chainForSymbol,
    scanNow: chainScanNow,
    rescan: chainRescan,
    busy: chainBusy,
    clock: chainNow,
    status: chainStatus,
    statusAt: chainStatusAt,
    statusFailed: chainStatusFailed,
  } = useOnChain();

  const {
    enabled: radarEnabled,
    reads: radarReads,
    armed: radarArmed,
    focus: radarFocus,
    status: radarStatus,
    streams: radarStreams,
    holds: radarHolds,
    toggleHold: toggleRadarHold,
    chart: radarChart,
    interval: radarInterval,
    setInterval: setRadarInterval,
    now: radarNow,
  } = useRadar();

  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [theater, setTheater] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");

  const blocked = status.market === "blocked";
  const onToggleRadarHold = useCallback(() => toggleRadarHold(prefs.selected), [toggleRadarHold, prefs.selected]);

  const focusJob = useMemo(() => chainForSymbol(prefs.selected), [chainForSymbol, prefs.selected]);
  const onScanNow = useCallback(() => chainScanNow(prefs.selected), [chainScanNow, prefs.selected]);

  const chainBackend = useMemo(
    () =>
      chainBackendView({
        enabled: chainEnabled,
        statusAt: chainStatusAt,
        statusFailed: chainStatusFailed,
        configured: chainStatus?.configured,
        busy: chainBusy,
      }),
    [chainEnabled, chainStatusAt, chainStatusFailed, chainStatus?.configured, chainBusy],
  );

  const candidates = useMemo(() => {
    const q = query.trim().toUpperCase();
    const pool = q ? reads.filter((r) => r.symbol.includes(q)) : reads;
    return pool.slice(0, 14);
  }, [reads, query]);

  const near = useMemo(() => reads.filter((r) => r.passedCount >= 3 && !r.armed).length, [reads]);

  const onSelect = useCallback(
    (symbol: string) => {
      select(symbol);
      setQuery("");
    },
    [select],
  );

  const onTogglePin = useCallback(() => togglePin(prefs.selected), [togglePin, prefs.selected]);

  /* Theater mode: Escape closes the overlay and the page behind it stops scrolling. */
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTheater(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [theater]);

  return (
    <div className="space-y-3">
      {/* ---------------- status strip ---------------- */}
      <section className="panel">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Activity
              className={cn("h-[15px] w-[15px]", status.market === "open" ? "text-primary" : "text-muted-foreground")}
            />
            <div>
              <div className="num text-[12px] font-semibold uppercase tracking-[0.14em] text-foreground">
                Liquidity Exhaustion Engine
              </div>
              <div className="num text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
                Binance USDⓈ-M · {UNIVERSE_LABEL} · shorts
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Metric label="Tracked" value={String(tracked)} size="sm" />
            <Metric label="Outside band" value={String(excluded)} size="sm" tone="muted" />
            <Metric label="History" value={String(status.deepCount)} size="sm" tone="brand" />
            <Metric label="Armed" value={String(armedCount)} size="sm" tone={armedCount > 0 ? "neg" : "muted"} />
            <Metric label="3 of 4" value={String(near)} size="sm" tone={near > 0 ? "warn" : "muted"} />
            <Metric
              label="Radar"
              value={radarEnabled ? `${radarArmed.length} · ${radarStreams.length}s` : "off"}
              size="sm"
              tone={!radarEnabled ? "muted" : radarArmed.length > 0 ? "warn" : "brand"}
            />
            <Metric label="Updated" value={scannedAt ? fmtClock(scannedAt) : "—"} size="sm" />
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Tag tone={SOCKET_TONE[status.market]}>MKT {status.market}</Tag>
            {!status.restOk ? <Tag tone="warn">REST blocked</Tag> : null}
            {chainBackend ? <Tag tone={chainBackend.tone}>ON-CHAIN {chainBackend.text}</Tag> : null}

            <Button
              tone={prefs.paused ? "solid" : "outline"}
              size="sm"
              onClick={() => patchPrefs({ paused: !prefs.paused })}
              title={prefs.paused ? "Resume streaming" : "Pause streaming"}
            >
              {prefs.paused ? <Play className="h-[12px] w-[12px]" /> : <Pause className="h-[12px] w-[12px]" />}
              {prefs.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              tone="ghost"
              size="sm"
              onClick={() => (permission === "granted" ? patchPrefs({ desktop: !prefs.desktop }) : requestPermission())}
              title={permission === "granted" ? "Toggle desktop notifications" : "Grant desktop notifications"}
              aria-label="Desktop notifications"
              aria-pressed={prefs.desktop && permission === "granted"}
            >
              {prefs.desktop && permission === "granted" ? (
                <Bell className="h-[13px] w-[13px]" />
              ) : (
                <BellOff className="h-[13px] w-[13px]" />
              )}
            </Button>
            <Button
              tone="ghost"
              size="sm"
              onClick={() => patchPrefs({ sound: !prefs.sound })}
              title="Toggle chime"
              aria-label="Sound"
              aria-pressed={prefs.sound}
            >
              {prefs.sound ? <Volume2 className="h-[13px] w-[13px]" /> : <VolumeX className="h-[13px] w-[13px]" />}
            </Button>
            <Button
              tone="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              title="Gate thresholds, alert channels, radar and on-chain settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <SlidersHorizontal className="h-[12px] w-[12px]" />
              Settings
            </Button>
          </div>
        </div>

        {blocked ? (
          <div className="border-t border-neg/25 bg-neg-soft px-3 py-2">
            <p className="text-[11.5px] leading-[1.5] text-neg">
              <strong className="font-semibold">Binance Futures is not reachable from this network.</strong> The venue
              refused the stream after {status.marketRetries} attempts — usually a regional block (HTTP 451). This
              engine is Binance-Futures-only by design and will not substitute another exchange&apos;s data, so it stays
              idle until the venue answers. It keeps retrying with backoff.
              {status.lastError ? <span className="text-neg/75"> Last error: {status.lastError}.</span> : null}
            </p>
          </div>
        ) : null}
      </section>

      {/* ---------------- settings (modal) ---------------- */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* ---------------- theater (full-viewport alert feed overlay) ---------------- */}
      {theater ? (
        <div
          className="fixed inset-0 z-[70] flex flex-col bg-background"
          role="dialog"
          aria-modal="true"
          aria-label="Alert feed — theater view"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-3 py-2">
            <div className="num text-[12px] font-semibold uppercase tracking-[0.14em] text-foreground">
              Alert feed{unseen > 0 ? ` — ${unseen} new` : ""}
            </div>
            <Button tone="ghost" size="sm" onClick={() => setTheater(false)} title="Close theater view">
              <X className="h-3.5 w-3.5" />
              Close
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {alerts.length === 0 ? (
              <div className="flex h-full items-center justify-center px-3 py-8 text-center">
                <div>
                  <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">No signals yet</p>
                  <p className="mx-auto mt-1.5 max-w-[360px] text-[11px] leading-[1.5] text-muted-foreground/70">
                    A contract has to pin its 24h high, spike and cool its volume, print a rejected higher high, and run
                    out of upside liquidity — all at once. Signals land here the moment that happens.
                  </p>
                </div>
              </div>
            ) : (
              <ul>
                {alerts.map((alert) => (
                  <AlertRow
                    key={alert.id}
                    alert={alert}
                    onSelect={onSelect}
                    onDismiss={dismiss}
                    job={chainById.get(alert.id)}
                    now={chainNow}
                    onRescan={chainRescan}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {/*
       * Focus + feed. Below `xl` everything stacks in one column with the
       * alert feed first, so a signal is the first thing on a phone. At `xl`
       * the feed heads a 400px side column and the engine panels span both
       * rows on the left. The explicit `minmax(0,1fr)` track is what stops
       * wide children (chip strip, tables, chart) from stretching the page.
       */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 xl:col-start-2 xl:row-start-1">
          <Panel
            title={`Alert feed${unseen ? ` — ${unseen} new` : ""}`}
            flush
            aside={
              <div className="flex items-center gap-1.5">
                <Button
                  tone="ghost"
                  size="sm"
                  onClick={() => setTheater(true)}
                  className="px-2"
                  aria-label="Expand alert feed"
                  aria-haspopup="dialog"
                  title="Theater view"
                >
                  <Maximize2 className="h-3 w-3" />
                </Button>
                {unseen > 0 ? (
                  <Button tone="ghost" size="sm" onClick={markAllSeen}>
                    Mark read
                  </Button>
                ) : null}
                {alerts.length > 0 ? (
                  <Button tone="ghost" size="sm" onClick={clearAlerts}>
                    Clear
                  </Button>
                ) : null}
              </div>
            }
          >
            {/* Manual refresh — forces every cached input to be re-fetched now. */}
            <div className="flex items-center gap-2 border-b border-line-soft px-2.5 py-2">
              <Button
                tone="outline"
                size="sm"
                onClick={refreshNow}
                disabled={refreshing}
                className="shrink-0"
                title="Re-fetch prices and candles now, ignoring the cache"
              >
                <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
                {refreshing ? "Refreshing" : "Refresh"}
              </Button>
              <span className="num min-w-0 truncate text-[10px] leading-[1.4] text-muted-foreground">
                {refreshing
                  ? "Fetching the latest prints…"
                  : refreshedAt
                    ? `Manual refresh ${timeAgo(refreshedAt)} · auto ${scannedAt ? fmtClock(scannedAt) : "—"}`
                    : `Auto-scanning every ${Math.round(rules.refreshMs / 1000)}s`}
              </span>
            </div>

            {alerts.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">No signals yet</p>
                <p className="mx-auto mt-1.5 max-w-[360px] text-[11px] leading-[1.5] text-muted-foreground/70">
                  A contract has to pin its 24h high, spike and cool its volume, print a rejected higher high, and run
                  out of upside liquidity — all at once. Signals land here the moment that happens.
                </p>
              </div>
            ) : (
              <ul className="max-h-[560px] overflow-auto">
                {alerts.map((alert) => (
                  <AlertRow
                    key={alert.id}
                    alert={alert}
                    onSelect={onSelect}
                    onDismiss={dismiss}
                    job={chainById.get(alert.id)}
                    now={chainNow}
                    onRescan={chainRescan}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-3 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          {/* contract selector */}
          <section className="panel flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="relative w-[164px] shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-[12px] w-[12px] -translate-y-1/2 text-muted-foreground/50" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && candidates[0]) onSelect(candidates[0].symbol);
                }}
                placeholder="Find contract"
                className="h-7 pl-7 text-[11.5px]"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-px">
              {candidates.length === 0 ? (
                <span className="num py-1 text-[10.5px] text-muted-foreground/60">No contract matches.</span>
              ) : (
                candidates.map((read) => (
                  <CandidateChip
                    key={read.symbol}
                    read={read}
                    active={read.symbol === prefs.selected}
                    radar={radarReads.get(read.symbol)}
                    onSelect={onSelect}
                  />
                ))
              )}
            </div>
          </section>

          {/* micro layer: every armed contract at a glance */}
          <ConfluenceMatrix
            rows={radarArmed}
            selected={prefs.selected}
            status={radarStatus}
            streams={radarStreams.length}
            now={radarNow}
            enabled={radarEnabled}
            onSelect={onSelect}
          />

          {/* micro layer: the focused contract in full */}
          <RadarPanel
            symbol={prefs.selected}
            read={radarFocus}
            macro={focus}
            chart={radarChart}
            interval={radarInterval}
            onInterval={setRadarInterval}
            held={radarHolds.includes(prefs.selected)}
            onToggleHold={onToggleRadarHold}
            enabled={radarEnabled}
            paused={prefs.paused}
            status={radarStatus}
            now={radarNow}
          />

          <FocusPanel
            read={focus}
            symbol={prefs.selected}
            pinned={prefs.pinned.includes(prefs.selected)}
            onTogglePin={onTogglePin}
            blocked={blocked}
            paused={prefs.paused}
            onChain={focusJob}
            now={chainNow}
            onScanNow={onScanNow}
            onRescan={chainRescan}
          />
        </div>

        <div className="min-w-0 space-y-3 xl:col-start-2 xl:row-start-2">
          {/* ---------------- BTCUSDT failed-breakout log ---------------- */}
          <BtcTrapPanel />

          {/* ---------------- TradingView indicators ---------------- */}
          <Panel title="TradingView indicators" bodyClassName="space-y-4">
            <div className="space-y-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[11.5px] font-medium text-foreground">Exhaustion Trap</h3>
                <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{PINE_VERSION}</span>
              </div>
              <p className="text-[11px] leading-[1.55] text-muted-foreground">
                The same four gates as this engine, in Pine Script v6. Paste it into the Pine Editor and add it to any
                chart.
              </p>
              <a href={PINE_URL} download={PINE_FILENAME} className="block">
                <Button tone="solid" size="sm" className="w-full">
                  <Download className="h-3 w-3" />
                  Download Pine Script
                </Button>
              </a>
              <a href={INDICATOR_MANUAL_URL} download target="_blank" rel="noreferrer" className="block">
                <Button tone="outline" size="sm" className="w-full">
                  <FileText className="h-3 w-3" />
                  Indicator manual · {INDICATOR_MANUAL_PAGES}pp
                </Button>
              </a>
              <p className="num text-[10px] leading-[1.5] text-muted-foreground">
                Install steps, a gate-by-gate breakdown of the logic, and how to trade the signals.{" "}
                {INDICATOR_MANUAL_FIGURES} annotated chart figures.
              </p>
            </div>

            <div className="space-y-2.5 border-t border-border/60 pt-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[11.5px] font-medium text-foreground">VWAP Distance Filter Pro</h3>
                <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  {VWAP_PINE_VERSION}
                </span>
              </div>
              <p className="text-[11px] leading-[1.55] text-muted-foreground">
                Measures how far price is stretched from VWAP in percent, sigma or ATR, with adaptive percentile bands
                and mean-reversion signals. Works both directions.
              </p>
              <a href={VWAP_PINE_URL} download={VWAP_PINE_FILENAME} className="block">
                <Button tone="outline" size="sm" className="w-full">
                  <Download className="h-3 w-3" />
                  Download Pine Script
                </Button>
              </a>
            </div>

            <div className="space-y-2.5 border-t border-border/60 pt-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[11.5px] font-medium text-foreground">Monthly Trap</h3>
                <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  {MONTHLY_PINE_VERSION}
                </span>
              </div>
              <p className="text-[11px] leading-[1.55] text-muted-foreground">
                Daily-chart traps at monthly levels, taken only while Bitcoin sits below its rising 200-day average
                and only when the trap day&apos;s intrabars prove the rejection. The day&apos;s volume profile is read
                from the same intrabars: POC and high-volume clusters drawn beside the last candle, and a signal whose
                wick holds the POC beyond the level is flagged ★ high confluence.
              </p>
              <a href={MONTHLY_PINE_URL} download={MONTHLY_PINE_FILENAME} className="block">
                <Button tone="outline" size="sm" className="w-full">
                  <Download className="h-3 w-3" />
                  Download Pine Script
                </Button>
              </a>
              <a href={MONTHLY_MANUAL_URL} download target="_blank" rel="noreferrer" className="block">
                <Button tone="outline" size="sm" className="w-full">
                  <FileText className="h-3 w-3" />
                  Manuali në shqip · {MONTHLY_MANUAL_PAGES}pp
                </Button>
              </a>
              <p className="num text-[10px] leading-[1.5] text-muted-foreground">
                Tested on 50 Binance pairs, 2017–2026: longs averaged +0.92R over 71 signals (76% positive, v1.0 was
                +0.25R over 279), the 40 ★ signals +0.99R; confirmed shorts +0.66R over 19. Fees not included. The
                Albanian manual covers install, every gate and the profile, with {MONTHLY_MANUAL_FIGURES} real-history
                chart figures.
              </p>
            </div>
          </Panel>

          {/* ---------------- Engine audit ---------------- */}
          <Panel title="Engine audit" bodyClassName="space-y-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11.5px] font-medium text-foreground">Mathematical &amp; logical audit</h3>
              <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{ENGINE_AUDIT_VERSION}</span>
            </div>
            <p className="text-[11px] leading-[1.55] text-muted-foreground">
              Every formula behind the four gates, the verdict and alert state machine, and the squeeze radar&apos;s
              depth, wall, squeeze, liquidation-cluster and open-interest reads, transcribed from the shipped code
              with the file and function each one lives in.
            </p>
            <a href={ENGINE_AUDIT_URL} download target="_blank" rel="noreferrer" className="block">
              <Button tone="outline" size="sm" className="w-full">
                <FileText className="h-3 w-3" />
                Audit report · {ENGINE_AUDIT_PAGES}pp
              </Button>
            </a>
            <p className="num text-[10px] leading-[1.5] text-muted-foreground">
              Worked examples are computed by the engine itself when the report is built, and every quoted constant is
              pinned to the source, so the document cannot drift from the code. Includes the edge-case guards and a
              findings list.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
