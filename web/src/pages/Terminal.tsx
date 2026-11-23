/**
 * Terminal — the V2 dashboard. Two instruments, always on.
 *
 * Layout (every boundary draggable, panels remember nothing between reloads
 * except their default proportions):
 *
 *   ┌ instrument selector + statuses────────────────────────────┐
 *   │ LEFT        │ CENTER              │ RIGHT                  │
 *   │ overview    │ chart (fullscreen)  │ wick signal monitor    │
 *   │ order book  │ OI & funding        │ alert center           │
 *   │ walls       │ squeeze + liqs      │ exhaustion engine      │
 *   │ whale tape  │                     │ confluence             │
 *   ├ bottom tabs: squeeze history · data quality · settings ·    │
 *   │  BTC trap log · pine & docs ─────────────────────────────── │
 *
 * Data comes from the untouched four-gate engine (WickProvider) and the
 * always-on InstrumentsProvider layer; neither receives anything from here.
 */

import { Panel as RPPanel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { BtcTrapPanel } from "@/components/BtcTrapPanel";
import { Button, Metric, Tag } from "@/components/kit";
import { DepthTable, LiquidationsPane, TradeTape } from "@/components/radar/RadarPanel";
import { routeSummary } from "@/lib/radar/stream";
import { fmtCompactUsd, fmtPrice, priceDecimals, timeAgo } from "@/lib/format";
import { TRACKED_SYMBOLS, UNIVERSE_LABEL } from "@/lib/wick/universe";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { useAlertCenter } from "@/store/AlertCenterProvider";
import { useInstruments } from "@/store/InstrumentsProvider";
import { useRadar } from "@/store/RadarProvider";
import { useWick } from "@/store/WickProvider";

import { useOnChain } from "@/store/OnChainProvider";

import { AlertFeedPanel } from "@/components/terminal/AlertFeedPanel";
import { ConfluencePanel } from "@/components/terminal/ConfluencePanel";
import { DataQualityPanel } from "@/components/terminal/DataQualityPanel";
import { DocsPanel } from "@/components/terminal/DocsPanel";
import { EngineConfigPanel } from "@/components/terminal/EngineConfigPanel";
import { ExhaustionPanel } from "@/components/terminal/ExhaustionPanel";
import { MarketOverviewPanel } from "@/components/terminal/MarketOverviewPanel";
import { OiFundingPanel } from "@/components/terminal/OiFundingPanel";
import { SqueezeHistoryPanel } from "@/components/terminal/SqueezeHistoryPanel";
import { TradingChart, buildChartLines } from "@/components/terminal/TradingChart";
import { WallsPanel } from "@/components/terminal/WallsPanel";
import { WickSignalPanel } from "@/components/terminal/WickSignalPanel";

const SOCKET_TONE = {
  open: "pos",
  connecting: "warn",
  retrying: "warn",
  blocked: "neg",
  idle: "muted",
} as const;

function Handle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-line-soft transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary",
        className,
      )}
    >
      <span className="h-[18px] w-[3px] rounded-full bg-muted-foreground/25 group-hover:bg-background" />
    </PanelResizeHandle>
  );
}

/** Current squeeze read for the focused instrument, beside its liquidation tape. */
function SqueezeLive({
  symbol,
  read,
  now,
}: {
  symbol: string;
  read: import("@/store/InstrumentsProvider").InstrumentRead | undefined;
  now: number;
}) {
  const s = read?.squeeze;
  return (
    <RPPanel className="min-h-0">
      <section className="panel flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary/40 px-2.5 py-1.5">
          <h2 className="lbl">Squeeze · {symbol.replace("USDT", "")}</h2>
          {s ? (
            <Tag tone={s.level === "hot" ? "neg" : s.level === "warm" ? "warn" : "pos"}>{s.level.toUpperCase()}</Tag>
          ) : (
            <Tag tone="muted">NOT AVAILABLE</Tag>
          )}
        </header>
        {s && read ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="grid grid-cols-4 gap-2 px-2.5 py-2">
              <Metric label="Forced 1h" value={fmtCompactUsd(s.volume)} size="sm" tone={s.level === "cold" ? "muted" : "neg"} />
              <Metric label="Shorts liq" value={fmtCompactUsd(s.shortLiq)} size="sm" tone="pos" />
              <Metric label="Longs liq" value={fmtCompactUsd(s.longLiq)} size="sm" tone="neg" />
              <Metric label="Events" value={String(s.count)} size="sm" />
            </div>
            <p className="num border-t border-line-soft px-2.5 py-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              direction {s.direction.replace("-", " ")} · thresholds {fmtCompactUsd(s.medAt)} / {fmtCompactUsd(s.highAt)}
              {s.lastAt ? ` · last ${timeAgo(s.lastAt, now)}` : ""}
            </p>
            <LiquidationsPane read={read} decimals={priceDecimals(read.depth.mid ?? 1)} />
          </div>
        ) : (
          <p className="num px-3 py-6 text-center text-[11px] text-muted-foreground/70">
            Liquidation stream connecting — forced orders land here within seconds.
          </p>
        )}
      </section>
    </RPPanel>
  );
}

const BOTTOM_TABS = [
  { id: "squeeze", label: "Squeeze history" },
  { id: "quality", label: "Data quality" },
  { id: "config", label: "Engine settings" },
  { id: "trap", label: "BTC trap log" },
  { id: "docs", label: "Pine & docs" },
] as const;

type BottomTab = (typeof BOTTOM_TABS)[number]["id"];

export default function Terminal() {
  const { theme } = useTheme();
  const dark = theme === "dark";

  const {
    prefs,
    select,
    bySymbol,
    focus,
    togglePin,
    armedCount,
    status,
    scannedAt,
    refreshNow,
    refreshing,
  } = useWick();

  const { chart, interval, setInterval, now: radarNow, status: radarStatus, streams: radarStreams } = useRadar();
  const { reads, signals, vwap, status: instStatus, now: instNow } = useInstruments();
  const { unseen: alertUnseen } = useAlertCenter();

  // On-chain state is read here for the status strip and the exhaustion
  // module's on-chain add-on; configuration lives in the config panel, which
  // talks to the provider itself.
  const {
    enabled: chainEnabled,
    forSymbol: chainForSymbol,
    scanNow: chainScanNow,
    rescan: chainRescan,
    busy: chainBusy,
    clock: chainNow,
    status: chainStatus,
    statusAt: chainStatusAt,
    statusFailed: chainStatusFailed,
  } = useOnChain();

  const [tab, setTab] = useState<BottomTab>("squeeze");

  const selected = prefs.selected;
  const read = reads.get(selected);
  const macro = focus;
  const now = instNow;

  const chainBackend = useMemo<{ text: string; tone: "muted" | "pos" | "warn" | "brand" } | null>(() => {
    if (!chainEnabled) return { text: "off", tone: "muted" };
    if (chainStatusAt === 0) return null;
    if (chainStatusFailed || !chainStatus) return { text: "offline", tone: "warn" };
    if (!chainStatus.configured) return { text: "no key", tone: "warn" };
    if (chainBusy) return { text: "scanning", tone: "brand" };
    return { text: "ready", tone: "pos" };
  }, [chainEnabled, chainStatusAt, chainStatusFailed, chainStatus, chainBusy]);
  const focusJob = useMemo(() => chainForSymbol(selected), [chainForSymbol, selected]);
  const onScanNow = useCallback(() => chainScanNow(selected), [chainScanNow, selected]);
  const onTogglePin = useCallback(() => togglePin(selected), [togglePin, selected]);

  const price = read?.depth.mid ?? macro?.price ?? 0;
  const decimals = priceDecimals(price || 1);

  // Wick markers only pin to bars the chart actually shows.
  const markers = useMemo(() => {
    const times = new Set(chart.bars.map((b) => b.time));
    return signals.filter((s) => s.symbol === selected && times.has(s.openTime));
  }, [signals, selected, chart.bars]);

  const lines = useMemo(
    () =>
      buildChartLines({
        high24h: macro?.high24h,
        low24h: macro?.low24h,
        bidWalls: read?.bidWalls ?? [],
        askWalls: read?.askWalls ?? [],
        clusters: read?.clusters ?? [],
        dark,
      }),
    [macro?.high24h, macro?.low24h, read?.bidWalls, read?.askWalls, read?.clusters, dark],
  );

  const macroMap = useMemo(() => {
    const m = new Map<string, import("@/lib/wick/exhaustion").ExhaustionRead | undefined>();
    for (const s of TRACKED_SYMBOLS) m.set(s, bySymbol.get(s));
    return m;
  }, [bySymbol]);

  const vwapMap = useMemo(() => {
    const m = new Map<string, import("@/lib/wick/types").VwapRead | undefined>();
    for (const s of TRACKED_SYMBOLS) m.set(s, vwap.get(s));
    return m;
  }, [vwap]);

  return (
    <div className="flex h-[calc(100vh-3.7rem)] min-h-[560px] flex-col gap-2">
      {/* ---------- instrument selector + statuses ---------- */}
      <section className="panel flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5">
        <div className="flex items-center gap-1">
          {TRACKED_SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              onClick={() => select(symbol)}
              className={cn(
                "num rounded-[3px] border px-2.5 py-1 text-[11.5px] font-semibold tracking-[0.04em] transition-colors",
                selected === symbol
                  ? "border-primary/50 bg-primary/12 text-primary"
                  : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {symbol.replace("USDT", "")}
              <span className="ml-1.5 text-[9.5px] font-normal opacity-70">
                {(() => {
                const p = reads.get(symbol)?.depth.mid;
                return p ? fmtPrice(p, priceDecimals(p)) : "n/a";
              })()}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Metric label="Armed" value={String(armedCount)} size="sm" tone={armedCount > 0 ? "neg" : "muted"} />
          <Metric label="Wick signals" value={String(signals.length)} size="sm" tone="brand" />
          <Metric label="Alerts new" value={String(alertUnseen)} size="sm" tone={alertUnseen > 0 ? "warn" : "muted"} />
          <Metric label="Scanned" value={scannedAt ? timeAgo(scannedAt, now) : "—"} size="sm" />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Tag tone={SOCKET_TONE[status.market]}>ENGINE MKT {status.market}</Tag>
          {!status.restOk ? <Tag tone="warn">REST blocked</Tag> : null}
          {chainBackend ? <Tag tone={chainBackend.tone}>ON-CHAIN {chainBackend.text}</Tag> : null}
          <Tag tone={SOCKET_TONE[instStatus.routes.public.state]} title={routeSummary(instStatus, now)}>
            INSTRUMENTS {instStatus.routes.public.state}/{instStatus.routes.market.state}
          </Tag>
          <Tag tone={radarStatus.state === "open" ? "pos" : radarStatus.state === "idle" ? "muted" : "warn"} title={routeSummary(radarStatus, radarNow)}>
            RADAR {radarStatus.state} · {radarStreams.length}s
          </Tag>
          <Button tone="outline" size="sm" onClick={refreshNow} disabled={refreshing} title="Re-fetch prices and candles now">
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </section>

      {/* ---------- three columns + bottom ---------- */}
      <PanelGroup direction="vertical" className="min-h-0 flex-1 gap-0">
        <RPPanel defaultSize={72} minSize={40}>
          <PanelGroup direction="horizontal" className="min-h-0">
            {/* LEFT */}
            <RPPanel defaultSize={23} minSize={14}>
              <PanelGroup direction="vertical" className="min-h-0">
                <RPPanel defaultSize={26} minSize={12}>
                  <section className="panel h-full overflow-auto">
                    <header className="panel-head">
                      <h2 className="lbl">Market overview</h2>
                      <Tag tone="muted">{UNIVERSE_LABEL}</Tag>
                    </header>
                    <MarketOverviewPanel
                      symbols={TRACKED_SYMBOLS}
                      reads={reads}
                      macros={macroMap}
                      vwaps={vwapMap}
                      selected={selected}
                      onSelect={select}
                      now={now}
                    />
                  </section>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={40} minSize={16}>
                  <section className="panel h-full overflow-hidden">
                    <header className="panel-head">
                      <h2 className="lbl">Order book · {selected.replace("USDT", "")}</h2>
                      <Tag tone="muted">20 levels · 100ms</Tag>
                    </header>
                    <div className="h-[calc(100%-29px)] overflow-auto">
                      {read ? (
                        <DepthTable read={read} decimals={decimals} />
                      ) : (
                        <p className="num px-3 py-6 text-center text-[11px] text-muted-foreground/70">
                          Depth stream connecting…
                        </p>
                      )}
                    </div>
                  </section>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={34} minSize={14}>
                  <PanelGroup direction="vertical" className="min-h-0">
                    <RPPanel defaultSize={50} minSize={12}>
                      <section className="panel h-full overflow-auto">
                        <header className="panel-head">
                          <h2 className="lbl">Liquidity walls</h2>
                          <Activity className="h-[11px] w-[11px] text-muted-foreground/50" />
                        </header>
                        <WallsPanel read={reads.get(selected)} price={price} />
                      </section>
                    </RPPanel>
                    <Handle className="h-[5px] w-full cursor-row-resize" />
                    <RPPanel defaultSize={50} minSize={12}>
                      <section className="panel h-full overflow-hidden">
                        <header className="panel-head">
                          <h2 className="lbl">Whale tape · {selected.replace("USDT", "")}</h2>
                          <Tag tone="muted">{read ? `${read.whales.length} prints` : "n/a"}</Tag>
                        </header>
                        <div className="h-[calc(100%-29px)] overflow-auto">
                          {read ? <TradeTape read={read} decimals={decimals} /> : null}
                        </div>
                      </section>
                    </RPPanel>
                  </PanelGroup>
                </RPPanel>
              </PanelGroup>
            </RPPanel>

            <Handle className="w-[5px] cursor-col-resize" />

            {/* CENTER */}
            <RPPanel defaultSize={52} minSize={28}>
              <PanelGroup direction="vertical" className="min-h-0">
                <RPPanel defaultSize={62} minSize={25}>
                  <div className="h-full min-h-0">
                    <TradingChart
                      bars={chart.bars}
                      seriesKey={`${selected}:${interval}`}
                      price={price}
                      dark={dark}
                      lines={lines}
                      markers={markers}
                      interval={interval}
                      onInterval={setInterval}
                    />
                  </div>
                </RPPanel>
                <Handle className="h-[5px] cursor-row-resize" />
                <RPPanel defaultSize={20} minSize={10}>
                  <section className="panel h-full overflow-auto">
                    <header className="panel-head">
                      <h2 className="lbl">Open interest & funding</h2>
                    </header>
                    <OiFundingPanel reads={reads} order={TRACKED_SYMBOLS} now={now} />
                  </section>
                </RPPanel>
                <Handle className="h-[5px] cursor-row-resize" />
                <SqueezeLive symbol={selected} read={read} now={now} />
              </PanelGroup>
            </RPPanel>

            <Handle className="w-[5px] cursor-col-resize" />

            {/* RIGHT */}
            <RPPanel defaultSize={25} minSize={16}>
              <PanelGroup direction="vertical" className="min-h-0">
                <RPPanel defaultSize={34} minSize={14}>
                  <section className="panel flex h-full min-h-0 flex-col">
                    <header className="panel-head">
                      <h2 className="lbl">Wick signal monitor · 1H</h2>
                      <Tag tone="brand">{signals.filter((s) => s.symbol === selected).length}</Tag>
                    </header>
                    <WickSignalPanel signals={signals} className="min-h-0 flex-1" />
                  </section>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={24} minSize={12}>
                  <section className="panel flex h-full min-h-0 flex-col">
                    <header className="panel-head">
                      <h2 className="lbl">Alert center</h2>
                      {alertUnseen > 0 ? <Tag tone="warn">{alertUnseen} new</Tag> : null}
                    </header>
                    <AlertFeedPanel onSelect={select} />
                  </section>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={24} minSize={12}>
                  <div className="h-full min-h-0 overflow-auto">
                    <ExhaustionPanel
                      read={macro}
                      symbol={selected}
                      pinned={prefs.pinned.includes(selected)}
                      onTogglePin={onTogglePin}
                      blocked={status.market === "blocked"}
                      paused={prefs.paused}
                      onChain={focusJob}
                      now={chainNow}
                      onScanNow={onScanNow}
                      onRescan={chainRescan}
                    />
                  </div>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={18} minSize={10}>
                  <section className="panel flex h-full min-h-0 flex-col">
                    <header className="panel-head">
                      <h2 className="lbl">Confluence · {selected.replace("USDT", "")}</h2>
                      <Tag tone="muted">additional score</Tag>
                    </header>
                    <ConfluencePanel
                      symbol={selected}
                      macro={macro}
                      read={read}
                      vwap={vwap.get(selected)}
                      signals={signals}
                      now={now}
                    />
                  </section>
                </RPPanel>
              </PanelGroup>
            </RPPanel>
          </PanelGroup>
        </RPPanel>

        <Handle className="h-[5px] w-full cursor-row-resize" />

        {/* BOTTOM */}
        <RPPanel defaultSize={28} minSize={10}>
          <section className="panel flex h-full min-h-0 flex-col">
            <header className="flex shrink-0 items-center gap-1 border-b border-border bg-secondary/40 px-2 py-1">
              {BOTTOM_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "num rounded-[3px] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors",
                    tab === t.id
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              {tab === "squeeze" ? (
                <div className="grid gap-px bg-line-soft xl:grid-cols-2">
                  {TRACKED_SYMBOLS.map((symbol) => (
                    <SqueezeHistoryPanel
                      key={symbol}
                      symbol={symbol}
                      history={reads.get(symbol)?.squeezeHistory ?? []}
                      now={now}
                    />
                  ))}
                </div>
              ) : tab === "quality" ? (
                <DataQualityPanel reads={reads} order={TRACKED_SYMBOLS} now={now} />
              ) : tab === "config" ? (
                <div className="p-2">
                  <EngineConfigPanel />
                </div>
              ) : tab === "trap" ? (
                <div className="p-2">
                  <BtcTrapPanel />
                </div>
              ) : (
                <DocsPanel />
              )}
            </div>
          </section>
        </RPPanel>
      </PanelGroup>
    </div>
  );
}
