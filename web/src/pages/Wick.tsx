import {
  Activity,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Download,
  FileText,
  Pause,
  Pin,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  ShieldCheck,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { BtcTrapPanel } from "@/components/BtcTrapPanel";
import { Button, Metric, Panel, Segmented, Tag } from "@/components/kit";
import { OnChainBadge, OnChainDetail } from "@/components/OnChainBadge";
import { ConfluenceMatrix } from "@/components/radar/ConfluenceMatrix";
import { MiniImbalance, MiniSqueeze } from "@/components/radar/gauges";
import { RadarPanel } from "@/components/radar/RadarPanel";
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
import { routeSummary } from "@/lib/radar/stream";
import type { RadarRead } from "@/lib/radar/types";
import type { ExhaustionRead } from "@/lib/wick/exhaustion";
import { HORIZON_OPTIONS, REFRESH_OPTIONS } from "@/lib/wick/rules";
import type { GateRead, SocketState, TrapSide, WickAlert } from "@/lib/wick/types";
import { PRICE_BAND_LABEL, UNIVERSE_LABEL } from "@/lib/wick/universe";
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
    patchRules,
    resetRules,
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
    lastDelivery,
    testAlert,
    requestPermission,
    permission,
  } = useWick();

  const {
    enabled: chainEnabled,
    setEnabled: setChainEnabled,
    jobs: chainJobs,
    byId: chainById,
    forSymbol: chainForSymbol,
    scanNow: chainScanNow,
    rescan: chainRescan,
    clear: clearChain,
    busy: chainBusy,
    clock: chainNow,
    status: chainStatus,
    statusAt: chainStatusAt,
    statusFailed: chainStatusFailed,
    verify: verifyChain,
    verifying: chainVerifying,
    verifyResult: chainVerify,
  } = useOnChain();

  const {
    enabled: radarEnabled,
    setEnabled: setRadarEnabled,
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

  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");

  const blocked = status.market === "blocked";
  const onToggleRadarHold = useCallback(() => toggleRadarHold(prefs.selected), [toggleRadarHold, prefs.selected]);

  const focusJob = useMemo(() => chainForSymbol(prefs.selected), [chainForSymbol, prefs.selected]);
  const onScanNow = useCallback(() => chainScanNow(prefs.selected), [chainScanNow, prefs.selected]);

  const chainBackend = useMemo<{ text: string; tone: "muted" | "pos" | "warn" | "brand" } | null>(() => {
    if (!chainEnabled) return { text: "off", tone: "muted" };
    if (chainStatusAt === 0) return null;
    if (chainStatusFailed || !chainStatus) return { text: "offline", tone: "warn" };
    if (!chainStatus.configured) return { text: "no key", tone: "warn" };
    if (chainBusy) return { text: "scanning", tone: "brand" };
    return { text: "ready", tone: "pos" };
  }, [chainEnabled, chainStatusAt, chainStatusFailed, chainStatus, chainBusy]);

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

            <Segmented
              value={String(rules.refreshMs)}
              options={REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => patchRules({ refreshMs: Number(v) })}
              className="w-[132px]"
            />
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
            >
              {prefs.sound ? <Volume2 className="h-[13px] w-[13px]" /> : <VolumeX className="h-[13px] w-[13px]" />}
            </Button>
            <Button tone="ghost" size="sm" onClick={() => setShowConfig((v) => !v)}>
              Config
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

      {/* ---------------- config ---------------- */}
      {showConfig ? (
        <Panel
          title="Gate thresholds"
          aside={
            <Button tone="ghost" size="sm" onClick={resetRules}>
              <RotateCcw className="h-[11px] w-[11px]" />
              Defaults
            </Button>
          }
        >
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="lbl mb-1">Pin distance</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.5}
                  max={50}
                  step={0.5}
                  value={rules.pinBps}
                  onChange={(e) => patchRules({ pinBps: Number(e.target.value) })}
                  className="h-1 flex-1 accent-primary"
                  aria-label="Pin distance from the 24h high, in basis points"
                />
                <span className="num w-14 text-right text-[12.5px] font-semibold text-primary">{rules.pinBps} bps</span>
              </div>
            </div>
            <div>
              <div className="lbl mb-1">Volume climax</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={150}
                  max={1000}
                  step={10}
                  value={rules.rvolClimax}
                  onChange={(e) => patchRules({ rvolClimax: Number(e.target.value) })}
                  className="h-1 flex-1 accent-primary"
                  aria-label="Relative volume climax threshold"
                />
                <span className="num w-11 text-right text-[12.5px] font-semibold">{rules.rvolClimax}%</span>
              </div>
            </div>
            <div>
              <div className="lbl mb-1">Rejection wick</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={45}
                  max={95}
                  step={1}
                  value={rules.wickPct}
                  onChange={(e) => patchRules({ wickPct: Number(e.target.value) })}
                  className="h-1 flex-1 accent-primary"
                  aria-label="Rejection wick as a share of the candle range"
                />
                <span className="num w-11 text-right text-[12.5px] font-semibold">{rules.wickPct}%</span>
              </div>
            </div>
            <div>
              <div className="lbl mb-1">Depletion band</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.1}
                  value={rules.depletionPct}
                  onChange={(e) => patchRules({ depletionPct: Number(e.target.value) })}
                  className="h-1 flex-1 accent-primary"
                  aria-label="Distance to the long-horizon high that counts as swept"
                />
                <span className="num w-11 text-right text-[12.5px] font-semibold">
                  {rules.depletionPct.toFixed(1)}%
                </span>
              </div>
            </div>
            <div>
              <div className="lbl mb-1">Liquidity horizon</div>
              <Segmented
                value={String(rules.horizonDays)}
                options={HORIZON_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                onChange={(v) => patchRules({ horizonDays: Number(v) })}
              />
            </div>
            <div>
              <div className="lbl mb-1">History slots</div>
              <Segmented
                value={String(rules.deepWatch)}
                options={[
                  { value: "6", label: "6" },
                  { value: "12", label: "12" },
                  { value: "18", label: "18" },
                  { value: "24", label: "24" },
                ]}
                onChange={(v) => patchRules({ deepWatch: Number(v) })}
              />
            </div>
            <div>
              <div className="lbl mb-1">Min 24h turnover</div>
              <Segmented
                value={String(rules.minVolume)}
                options={[
                  { value: "0", label: "Any" },
                  { value: "1000000", label: "$1M" },
                  { value: "5000000", label: "$5M" },
                  { value: "25000000", label: "$25M" },
                ]}
                onChange={(v) => patchRules({ minVolume: Number(v) })}
              />
            </div>
            <div>
              <div className="lbl mb-1">Cooldown</div>
              <Segmented
                value={String(rules.cooldownMins)}
                options={[
                  { value: "5", label: "5m" },
                  { value: "15", label: "15m" },
                  { value: "30", label: "30m" },
                  { value: "120", label: "2h" },
                ]}
                onChange={(v) => patchRules({ cooldownMins: Number(v) })}
              />
            </div>
          </div>

          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <span className="lbl">Universe</span>
              <Tag tone="brand">{UNIVERSE_LABEL}</Tag>
            </div>
            <p className="num text-[10px] leading-[1.5] text-muted-foreground">
              Bitcoin always, plus any altcoin whose live price sits strictly inside {PRICE_BAND_LABEL}. The test runs
              on every pass: a contract that crosses out of the band leaves the scanner on the next tick and returns
              only once its price is back inside. Right now {tracked} of {status.universe || tracked + excluded}{" "}
              perpetuals qualify and {excluded} sit outside the band. Multiplied contracts (1000PEPE, 1000SHIB…) are
              judged on the price they trade at.
            </p>
          </div>

          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="lbl">Alert channels</span>
              <Button tone="outline" size="sm" onClick={testAlert}>
                <Send className="h-[11px] w-[11px]" />
                Send test
              </Button>
            </div>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
              <div>
                <div className="lbl mb-1">Telegram bot token</div>
                <Input
                  value={prefs.telegramToken}
                  onChange={(e) => patchPrefs({ telegramToken: e.target.value })}
                  placeholder="123456:ABC-DEF…"
                  className="h-8 text-[12px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <div className="lbl mb-1">Telegram chat id</div>
                <Input
                  value={prefs.telegramChatId}
                  onChange={(e) => patchPrefs({ telegramChatId: e.target.value })}
                  placeholder="-1001234567890"
                  className="h-8 text-[12px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <div className="lbl mb-1">Discord webhook</div>
                <Input
                  value={prefs.discordWebhook}
                  onChange={(e) => patchPrefs({ discordWebhook: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/…"
                  className="h-8 text-[12px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <p className="num mt-2 text-[10px] leading-[1.5] text-muted-foreground">
              Sent straight from this browser — no relay server. Credentials stay in this browser&apos;s local storage.
              {lastDelivery.length
                ? ` Last dispatch: ${lastDelivery
                    .map((d) => `${d.channel} ${d.ok ? "ok" : `failed (${d.error ?? "error"})`}`)
                    .join(", ")}.`
                : ""}
            </p>
          </div>

          {/* ---- squeeze radar (micro layer) ---- */}
          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <span className="lbl">Squeeze radar · micro layer</span>
              <div className="flex items-center gap-1.5">
                <Tag
                  tone={radarEnabled ? (radarStatus.state === "open" ? "pos" : "warn") : "muted"}
                  title={radarEnabled ? routeSummary(radarStatus, radarNow) : undefined}
                >
                  public {radarEnabled ? radarStatus.routes.public.state : "off"}
                </Tag>
                <Tag
                  tone={radarEnabled ? (radarStatus.routes.market.state === "open" ? "pos" : "warn") : "muted"}
                  title={radarEnabled ? routeSummary(radarStatus, radarNow) : undefined}
                >
                  market {radarEnabled ? radarStatus.routes.market.state : "off"}
                </Tag>
                <Button tone={radarEnabled ? "outline" : "solid"} size="sm" onClick={() => setRadarEnabled(!radarEnabled)}>
                  {radarEnabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5">
              <Metric label="Attached" value={String(radarReads.size)} size="sm" tone={radarReads.size ? "brand" : "muted"} />
              <Metric label="Armed" value={String(radarArmed.length)} size="sm" tone={radarArmed.length ? "warn" : "muted"} />
              <Metric label="Streams" value={String(radarStreams.length)} size="sm" />
              <Metric label="Held" value={String(radarHolds.length)} size="sm" />
              <Metric label="Frames" value={radarStatus.messages.toLocaleString("en-US")} size="sm" />
              <Metric label="Reconnects" value={String(radarStatus.retries)} size="sm" tone={radarStatus.retries ? "warn" : "muted"} />
            </div>
            <p className="num mt-2 text-[10px] leading-[1.5] text-muted-foreground">
              Two routed Binance Futures sockets — the public one carries order-book depth, the market one carries
              aggressive trades, mark price, the chart&apos;s klines and liquidations. When a contract reaches {RADAR_ARM_AT} of 4
              gates its depth (20 levels, 100ms), aggressive trades and mark price are subscribed live; the venue-wide
              liquidation stream is shared by every armed contract. Streams unsubscribe two minutes after a contract falls below the line, unless it is
              in focus or held. The radar reads the gates&apos; verdict and never feeds back into it.
              {radarStatus.lastError ? ` Last socket note: ${radarStatus.lastError}.` : ""}
            </p>
          </div>

          {/* ---- on-chain add-on ---- */}
          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <span className="lbl">On-chain intelligence · Arkham</span>
              <div className="flex items-center gap-1.5">
                {chainJobs.length ? (
                  <Button tone="ghost" size="sm" onClick={clearChain}>
                    Clear scans
                  </Button>
                ) : null}
                <Button tone="ghost" size="sm" onClick={verifyChain} disabled={chainVerifying}>
                  <ShieldCheck className="h-[11px] w-[11px]" />
                  {chainVerifying ? "Checking…" : "Verify key"}
                </Button>
                <Button tone={chainEnabled ? "outline" : "solid"} size="sm" onClick={() => setChainEnabled(!chainEnabled)}>
                  {chainEnabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5">
              <Metric
                label="Backend"
                value={chainBackend ? chainBackend.text : "checking"}
                size="sm"
                tone={chainBackend ? chainBackend.tone : "muted"}
              />
              <Metric
                label="Credits today"
                value={
                  chainStatus
                    ? `${chainStatus.today.credits.toLocaleString("en-US")} / ${chainStatus.creditCap.toLocaleString("en-US")}`
                    : "—"
                }
                size="sm"
                tone={chainStatus && chainStatus.today.credits >= chainStatus.creditCap ? "warn" : "default"}
              />
              <Metric label="Scans today" value={chainStatus ? String(chainStatus.today.scans) : "—"} size="sm" />
              <Metric
                label="Failures"
                value={chainStatus ? String(chainStatus.today.failures) : "—"}
                size="sm"
                tone={chainStatus && chainStatus.today.failures > 0 ? "warn" : "muted"}
              />
              <Metric
                label="Queue"
                value={chainStatus ? String(chainStatus.queue + (chainStatus.inFlight ? 1 : 0)) : "—"}
                size="sm"
              />
              <Metric label="Tracked signals" value={String(chainJobs.length)} size="sm" />
            </div>
            <p className="num mt-2 text-[10px] leading-[1.5] text-muted-foreground">
              Every signal is checked for $100k–$500k exchange flows in the 15 minutes before and 2 minutes after it.
              The scan runs on the backend with the Arkham key kept server-side: an early read at once, the final
              read 5 minutes later. The engine never waits on it.
              {chainVerify ? ` Key check: ${chainVerify.message}.` : ""}
              {chainStatus?.lastError ? ` Last backend error: ${chainStatus.lastError}.` : ""}
            </p>
          </div>
        </Panel>
      ) : null}

      {/* ---------------- focus + feed ---------------- */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-3">
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

        <div className="space-y-3">
          <Panel
            title={`Alert feed${unseen ? ` — ${unseen} new` : ""}`}
            flush
            aside={
              <div className="flex items-center gap-1.5">
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
              <span className="num truncate text-[10px] leading-[1.4] text-muted-foreground">
                {refreshing
                  ? "Fetching the latest prints…"
                  : refreshedAt
                    ? `Manual refresh ${timeAgo(refreshedAt)} · auto ${scannedAt ? fmtClock(scannedAt) : "—"}`
                    : `Auto-scanning every ${Math.round(rules.refreshMs / 1000)}s`}
              </span>
            </div>

            {alerts.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">No signals yet</p>
                <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-foreground/70">
                  A contract has to pin its 24h high, spike and cool its volume, print a rejected higher high, and run
                  out of upside liquidity — all at once.
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
