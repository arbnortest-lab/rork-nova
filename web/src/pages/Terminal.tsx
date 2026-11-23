/**
 * Terminal — the NOVAEXHAUSTION trading surface. Two instruments, always on.
 *
 * Layout (columns drag-resize; sections collapse; the chart goes fullscreen):
 *
 *   ┌ pair · big price · engine stats · stream status ────────────┐
 *   │ LEFT 17%      │ CENTER 58%                │ RIGHT 25%        │
 *   │ market        │ CHART (dominant,          │ wick signals     │
 *   │ intelligence  │  fullscreen, zoom)        │  (primary)       │
 *   │ · overview    │ lower tabs:               │ exhaustion       │
 *   │ · order book  │  OI & funding             │ alerts           │
 *   │ · walls       │  squeeze radar            │ confluence       │
 *   │ · whales      │  liquidations             │                  │
 *   │ · liquidations│                           │                  │
 *   ├ bottom workspace: wick · squeeze · liquidation · BTC · USDC ·  │
 *   │  engine history · data quality · configuration ────────────────│
 *
 * Data comes from the untouched four-gate engine (WickProvider) and the
 * always-on InstrumentsProvider layer; neither receives anything from here.
 * This file is presentation only.
 */

import { Panel as RPPanel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { BtcTrapPanel } from "@/components/BtcTrapPanel";
import { Button, CollapsibleSection, Metric, Tag } from "@/components/kit";
import { DepthTable, LiquidationsPane, TradeTape } from "@/components/radar/RadarPanel";
import { routeSummary } from "@/lib/radar/stream";
import { fmtCompactUsd, fmtPrice, fmtSignedPct, priceDecimals, timeAgo } from "@/lib/format";
import { TRACKED_SYMBOLS } from "@/lib/wick/universe";
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
        "group relative flex shrink-0 items-center justify-center bg-background transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary",
        className,
      )}
    >
      <span className="h-[18px] w-[3px] rounded-full bg-muted-foreground/25 group-hover:bg-background" />
    </PanelResizeHandle>
  );
}

/** A squeezed-instrument read without its liquidation tape — the lower "Squeeze radar" tab. */
function SqueezeRadar({ symbol, read, now }: { symbol: string; read: import("@/store/InstrumentsProvider").InstrumentRead | undefined; now: number }) {
  const s = read?.squeeze;
  return (
    <div className="p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Forced 1h"
          value={s ? fmtCompactUsd(s.volume) : "n/a"}
          tone={s?.level === "cold" ? "muted" : s ? "neg" : "muted"}
        />
        <Metric label="Shorts liquidated" value={s ? fmtCompactUsd(s.shortLiq) : "n/a"} tone={s ? "pos" : "muted"} />
        <Metric label="Longs liquidated" value={s ? fmtCompactUsd(s.longLiq) : "n/a"} tone={s ? "neg" : "muted"} />
        <Metric label="Events" value={s ? String(s.count) : "n/a"} />
      </div>
      <p className="num mt-3 border-t border-line-soft pt-2 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
        {s ? (
          <>
            level <span className={cn("font-semibold", s.level === "hot" ? "text-neg" : s.level === "warm" ? "text-warn" : "text-pos")}>{s.level}</span>
            {" · "}direction {s.direction.replace("-", " ")}
            {" · "}thresholds {fmtCompactUsd(s.medAt)} / {fmtCompactUsd(s.highAt)}
            {s.lastAt ? ` · last event ${timeAgo(s.lastAt, now)}` : ""}
          </>
        ) : (
          "Liquidation stream connecting — the squeeze read for " + symbol + " lands here within seconds."
        )}
      </p>
    </div>
  );
}

/** One instrument's full analysis for the bottom workspace, from existing modules only. */
function SymbolAnalysis({
  symbol,
  reads,
  macros,
  vwaps,
  selected,
  onSelect,
  now,
  macro,
  vwap,
  signals,
  squeezeHistory,
}: {
  symbol: string;
  reads: Map<string, import("@/store/InstrumentsProvider").InstrumentRead>;
  macros: Map<string, import("@/lib/wick/exhaustion").ExhaustionRead | undefined>;
  vwaps: Map<string, import("@/lib/wick/types").VwapRead | undefined>;
  selected: string;
  onSelect: (symbol: string) => void;
  now: number;
  macro: import("@/lib/wick/exhaustion").ExhaustionRead | undefined;
  vwap: import("@/lib/wick/types").VwapRead | undefined;
  signals: import("@/lib/signals/wickSignal").WickSignal[];
  squeezeHistory: import("@/store/InstrumentsProvider").SqueezeSample[];
}) {
  return (
    <div className="grid gap-2 p-2 xl:grid-cols-2">
      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="lbl">Market overview · {symbol}</h2>
          <Tag tone="muted">{symbol === selected ? "focused" : "click card to focus"}</Tag>
        </header>
        <MarketOverviewPanel
          symbols={[symbol]}
          reads={reads}
          macros={macros}
          vwaps={vwaps}
          selected={selected}
          onSelect={onSelect}
          now={now}
        />
      </section>
      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="lbl">Open interest & funding · {symbol}</h2>
        </header>
        <OiFundingPanel reads={reads} order={[symbol]} now={now} />
      </section>
      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="lbl">Confluence · {symbol.replace("USDT", "")}</h2>
          <Tag tone="muted">additional score</Tag>
        </header>
        <ConfluencePanel symbol={symbol} macro={macro} read={reads.get(symbol)} vwap={vwap} signals={signals} now={now} />
      </section>
      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="lbl">Squeeze history · {symbol}</h2>
        </header>
        <SqueezeHistoryPanel symbol={symbol} history={squeezeHistory} now={now} />
      </section>
    </div>
  );
}

const LOWER_TABS = [
  { id: "oi", label: "OI & funding" },
  { id: "squeeze", label: "Squeeze radar" },
  { id: "liq", label: "Liquidations" },
] as const;

type LowerTab = (typeof LOWER_TABS)[number]["id"];

const BOTTOM_TABS = [
  { id: "wick", label: "Wick history" },
  { id: "sqh", label: "Squeeze history" },
  { id: "liqh", label: "Liquidation history" },
  { id: "btc", label: "BTCUSDT analysis" },
  { id: "usdc", label: "USDCUSDT analysis" },
  { id: "engine", label: "Engine history" },
  { id: "quality", label: "Data quality" },
  { id: "config", label: "Engine configuration" },
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

  const [tab, setTab] = useState<BottomTab>("wick");
  const [lower, setLower] = useState<LowerTab>("oi");

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
  const change = macro?.changePct;

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

  const selectedSignals = useMemo(() => signals.filter((s) => s.symbol === selected).length, [signals, selected]);

  return (
    <div className="flex h-[calc(100vh-3.7rem)] min-h-[600px] flex-col gap-2">
      {/* ---------- pair · price · engine stats · status ---------- */}
      <section className="panel flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          {TRACKED_SYMBOLS.map((symbol) => {
            const p = reads.get(symbol)?.depth.mid;
            const dec = p ? priceDecimals(p) : 2;
            const chg = bySymbol.get(symbol)?.changePct;
            const active = selected === symbol;
            return (
              <button
                key={symbol}
                type="button"
                onClick={() => select(symbol)}
                className={cn(
                  "num rounded-[4px] border px-3 py-1 text-left transition-colors",
                  active
                    ? "border-primary/50 bg-primary/[0.08]"
                    : "border-border bg-secondary/40 hover:border-muted-foreground/40",
                )}
              >
                <span className={cn("block text-[10px] font-semibold uppercase tracking-[0.1em]", active ? "text-primary" : "text-muted-foreground")}>
                  {symbol.replace("USDT", "")}
                  <span className="text-[8.5px] font-normal opacity-60">/USDT</span>
                </span>
                <span className={cn("block text-[15px] font-semibold leading-tight", active ? "text-foreground" : "text-foreground/80")}>
                  {p ? fmtPrice(p, dec) : "n/a"}
                  <span className={cn("ml-1.5 text-[10.5px]", chg === undefined ? "text-muted-foreground/50" : chg >= 0 ? "text-pos" : "text-neg")}>
                    {chg === undefined ? "" : fmtSignedPct(chg, 2)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Metric label="Armed gates" value={String(armedCount)} size="sm" tone={armedCount > 0 ? "neg" : "muted"} />
          <Metric label="Wick signals" value={String(signals.length)} size="sm" tone="brand" />
          <Metric label="Alerts new" value={String(alertUnseen)} size="sm" tone={alertUnseen > 0 ? "warn" : "muted"} />
          <Metric label="Engine scan" value={scannedAt ? timeAgo(scannedAt, now) : "—"} size="sm" />
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

      {/* ---------- three columns + bottom workspace ---------- */}
      <PanelGroup direction="vertical" className="min-h-0 flex-1 gap-0">
        <RPPanel defaultSize={72} minSize={42}>
          <PanelGroup direction="horizontal" className="min-h-0">
            {/* ============ LEFT — MARKET INTELLIGENCE ============ */}
            <RPPanel defaultSize={17} minSize={13}>
              <div className="h-full min-h-0 space-y-2 overflow-y-auto pb-1 pr-0.5">
                <CollapsibleSection id="left-overview" title="Market overview" bodyClassName="p-0">
                  <MarketOverviewPanel
                    symbols={TRACKED_SYMBOLS}
                    reads={reads}
                    macros={macroMap}
                    vwaps={vwapMap}
                    selected={selected}
                    onSelect={select}
                    now={now}
                  />
                </CollapsibleSection>

                <CollapsibleSection
                  id="left-book"
                  title={`Order book · ${selected.replace("USDT", "")}`}
                  aside={<Tag tone="muted">20 levels</Tag>}
                  bodyClassName="p-0"
                >
                  <div className="h-[320px] overflow-auto">
                    {read ? (
                      <DepthTable read={read} decimals={decimals} />
                    ) : (
                      <p className="num px-3 py-8 text-center text-[12px] text-muted-foreground/70">Depth stream connecting…</p>
                    )}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="left-walls" title="Liquidity walls" bodyClassName="p-0">
                  <div className="max-h-[280px] overflow-auto">
                    <WallsPanel read={reads.get(selected)} price={price} />
                  </div>
                </CollapsibleSection>

                <CollapsibleSection
                  id="left-whales"
                  title={`Whale activity · ${selected.replace("USDT", "")}`}
                  aside={<Tag tone="muted">{read ? `${read.whales.length} prints` : "n/a"}</Tag>}
                  bodyClassName="p-0"
                >
                  <div className="h-[260px] overflow-auto">
                    {read ? <TradeTape read={read} decimals={decimals} /> : null}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection
                  id="left-liqs"
                  title="Liquidation feed"
                  defaultOpen={false}
                  bodyClassName="p-0"
                >
                  <div className="h-[240px] overflow-auto">
                    {read ? (
                      <LiquidationsPane read={read} decimals={decimals} />
                    ) : (
                      <p className="num px-3 py-8 text-center text-[12px] text-muted-foreground/70">Forced-order stream connecting…</p>
                    )}
                  </div>
                </CollapsibleSection>
              </div>
            </RPPanel>

            <Handle className="w-[5px] cursor-col-resize" />

            {/* ============ CENTER — MAIN TERMINAL ============ */}
            <RPPanel defaultSize={58} minSize={30}>
              <PanelGroup direction="vertical" className="min-h-0">
                <RPPanel defaultSize={70} minSize={30}>
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
                <RPPanel defaultSize={30} minSize={12}>
                  <section className="panel flex h-full min-h-0 flex-col">
                    <header className="flex shrink-0 items-center gap-1 border-b border-border bg-secondary/40 px-2 py-1">
                      {LOWER_TABS.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setLower(t.id)}
                          className={cn(
                            "num rounded-[3px] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.09em] transition-colors",
                            lower === t.id
                              ? "bg-primary/12 text-primary"
                              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                          )}
                        >
                          {t.label}
                        </button>
                      ))}
                      <span className="num ml-auto pr-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        {selected}
                      </span>
                    </header>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {lower === "oi" ? (
                        <OiFundingPanel reads={reads} order={TRACKED_SYMBOLS} now={now} />
                      ) : lower === "squeeze" ? (
                        <SqueezeRadar symbol={selected} read={read} now={now} />
                      ) : (
                        <div className="h-full min-h-0 overflow-auto">
                          {read ? (
                            <LiquidationsPane read={read} decimals={decimals} />
                          ) : (
                            <p className="num px-3 py-8 text-center text-[12px] text-muted-foreground/70">
                              Forced-order stream connecting…
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                </RPPanel>
              </PanelGroup>
            </RPPanel>

            <Handle className="w-[5px] cursor-col-resize" />

            {/* ============ RIGHT — SIGNAL CENTER ============ */}
            <RPPanel defaultSize={25} minSize={17}>
              <PanelGroup direction="vertical" className="min-h-0">
                {/* Primary module — the wick signal monitor, kept spacious */}
                <RPPanel defaultSize={52} minSize={22}>
                  <section className="panel flex h-full min-h-0 flex-col">
                    <header className="panel-head">
                      <h2 className="lbl">Wick signal monitor · 1H</h2>
                      <Tag tone="brand">{selectedSignals} · {selected.replace("USDT", "")}</Tag>
                    </header>
                    <WickSignalPanel signals={signals} className="min-h-0 flex-1" />
                  </section>
                </RPPanel>
                <Handle className="h-[5px] w-full cursor-row-resize" />
                <RPPanel defaultSize={48} minSize={16}>
                  <div className="h-full min-h-0 space-y-2 overflow-y-auto pb-1 pr-0.5">
                    <CollapsibleSection id="right-exhaustion" title={`Exhaustion signals · ${selected.replace("USDT", "")}`} bodyClassName="p-0">
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
                    </CollapsibleSection>

                    <CollapsibleSection
                      id="right-alerts"
                      title="Squeeze & liquidity alerts"
                      aside={alertUnseen > 0 ? <Tag tone="warn">{alertUnseen} new</Tag> : undefined}
                      defaultOpen={false}
                      bodyClassName="p-0"
                    >
                      <div className="h-[300px] overflow-auto">
                        <AlertFeedPanel onSelect={select} />
                      </div>
                    </CollapsibleSection>

                    <CollapsibleSection
                      id="right-confluence"
                      title={`Confluence · ${selected.replace("USDT", "")}`}
                      aside={<Tag tone="muted">additional score</Tag>}
                      bodyClassName="p-0"
                    >
                      <div className="max-h-[340px] overflow-auto">
                        <ConfluencePanel
                          symbol={selected}
                          macro={macro}
                          read={read}
                          vwap={vwap.get(selected)}
                          signals={signals}
                          now={now}
                        />
                      </div>
                    </CollapsibleSection>
                  </div>
                </RPPanel>
              </PanelGroup>
            </RPPanel>
          </PanelGroup>
        </RPPanel>

        <Handle className="h-[5px] w-full cursor-row-resize" />

        {/* ============ BOTTOM — HISTORICAL ANALYTICS ============ */}
        <RPPanel defaultSize={28} minSize={10}>
          <section className="panel flex h-full min-h-0 flex-col">
            <header className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-secondary/40 px-2 py-1">
              {BOTTOM_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "num shrink-0 rounded-[3px] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.09em] transition-colors",
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
              {tab === "wick" ? (
                <div className="h-full min-h-[320px]">
                  <WickSignalPanel signals={signals} className="h-full" />
                </div>
              ) : tab === "sqh" ? (
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
              ) : tab === "liqh" ? (
                <div className="grid gap-px bg-line-soft xl:grid-cols-2">
                  {TRACKED_SYMBOLS.map((symbol) => {
                    const r = reads.get(symbol);
                    return (
                      <section key={symbol} className="bg-card">
                        <header className="panel-head">
                          <h2 className="lbl">Liquidations · {symbol}</h2>
                          <Tag tone="muted">trailing window</Tag>
                        </header>
                        <div className="h-[300px] overflow-auto">
                          {r ? (
                            <LiquidationsPane read={r} decimals={priceDecimals(r.depth.mid ?? 1)} />
                          ) : (
                            <p className="num px-3 py-8 text-center text-[12px] text-muted-foreground/70">n/a</p>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : tab === "btc" ? (
                <SymbolAnalysis
                  symbol="BTCUSDT"
                  reads={reads}
                  macros={macroMap}
                  vwaps={vwapMap}
                  selected={selected}
                  onSelect={select}
                  now={now}
                  macro={bySymbol.get("BTCUSDT")}
                  vwap={vwap.get("BTCUSDT")}
                  signals={signals}
                  squeezeHistory={reads.get("BTCUSDT")?.squeezeHistory ?? []}
                />
              ) : tab === "usdc" ? (
                <SymbolAnalysis
                  symbol="USDCUSDT"
                  reads={reads}
                  macros={macroMap}
                  vwaps={vwapMap}
                  selected={selected}
                  onSelect={select}
                  now={now}
                  macro={bySymbol.get("USDCUSDT")}
                  vwap={vwap.get("USDCUSDT")}
                  signals={signals}
                  squeezeHistory={reads.get("USDCUSDT")?.squeezeHistory ?? []}
                />
              ) : tab === "engine" ? (
                <div className="p-2">
                  <BtcTrapPanel />
                </div>
              ) : tab === "quality" ? (
                <DataQualityPanel reads={reads} order={TRACKED_SYMBOLS} now={now} />
              ) : (
                <div className="space-y-2 p-2">
                  <EngineConfigPanel />
                  <DocsPanel />
                </div>
              )}
            </div>
          </section>
        </RPPanel>
      </PanelGroup>
    </div>
  );
}
