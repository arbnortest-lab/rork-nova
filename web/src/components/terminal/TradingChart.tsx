/**
 * TradingChart — the terminal's advanced chart.
 *
 * lightweight-charts v5, theme-aware (light institutional by default, the
 * original terminal palette in dark), with:
 *
 *   • all seven intervals (1m → 1D) chosen by the caller
 *   • volume histogram under the candles
 *   • price overlay lines: 24h high/low (dashed), whale walls (dotted),
 *     liquidation clusters (solid amber), live mark (dotted brand)
 *   • wick-signal markers pinned to the candle where the 1H close confirmed
 *   • a real fullscreen mode via the Fullscreen API on the chart's frame
 *
 * The chart is display-only: nothing selected here reaches any engine.
 */

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Maximize2, Minimize2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Button, Segmented } from "@/components/kit";
import { fmtCompactUsd } from "@/lib/format";
import { CHART_INTERVALS, type ChartBar, type ChartInterval } from "@/lib/radar/types";
import type { WickSignal } from "@/lib/signals/wickSignal";
import { cn } from "@/lib/utils";

const DARK = {
  up: "#35b57c",
  down: "#e2475a",
  upSoft: "rgba(53,181,124,0.35)",
  downSoft: "rgba(226,71,90,0.35)",
  amber: "#f7a21b",
  text: "#7a8191",
  line: "#1f232c",
  grid: "rgba(210,216,228,0.045)",
} as const;

const LIGHT = {
  up: "#1d7a4f",
  down: "#c72e42",
  upSoft: "rgba(29,122,79,0.30)",
  downSoft: "rgba(199,46,66,0.30)",
  amber: "#b37509",
  text: "#5b6472",
  line: "#c9cfda",
  grid: "rgba(40,48,66,0.07)",
} as const;

export interface ChartLine {
  id: string;
  price: number;
  color: string;
  title: string;
  style?: "solid" | "dashed" | "dotted";
  width?: 1 | 2;
}

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export const TradingChart = memo(function TradingChart({
  bars,
  seriesKey,
  price,
  dark,
  lines,
  markers,
  interval,
  onInterval,
}: {
  bars: ChartBar[];
  /** Changes when symbol or interval changes, resetting the series. */
  seriesKey: string;
  price: number;
  dark: boolean;
  lines: ChartLine[];
  /** Closed-1H wick signals for THIS symbol, newest first. */
  markers: WickSignal[];
  interval: ChartInterval;
  onInterval: (i: ChartInterval) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const loadedKeyRef = useRef<string>("");
  const loadedCountRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [full, setFull] = useState<boolean>(false);

  const c = dark ? DARK : LIGHT;
  const decimals = price >= 1000 ? 2 : price >= 1 ? 4 : 6;

  const linesKey = useMemo(
    () => lines.map((l) => `${l.id}:${l.price}:${l.color}:${l.title}:${l.style ?? "solid"}`).join("|"),
    [lines],
  );
  const markersKey = useMemo(() => markers.map((m) => m.id).join("|"), [markers]);

  /* fullscreen plumbing */
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFull = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.requestFullscreen();
  };

  /* chart lifecycle */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: c.text,
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.line, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false, rightOffset: 5 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    markersRef.current = createSeriesMarkers(candles, []);

    chartRef.current = chart;
    candlesRef.current = candles;
    volumeRef.current = volume;
    loadedKeyRef.current = "";
    loadedCountRef.current = 0;
    lastTimeRef.current = 0;
    priceLinesRef.current = [];

    return () => {
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
    // Theme colours are read once per creation; the effect below re-creates on flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  useEffect(() => {
    candlesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: decimals, minMove: 10 ** -decimals },
    });
  }, [decimals]);

  /* series data */
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume) return;

    const last = bars[bars.length - 1];
    const reset = loadedKeyRef.current !== seriesKey || bars.length < loadedCountRef.current || !last;
    const reload = !reset && bars.length > loadedCountRef.current + 1;

    if (reset || reload) {
      loadedKeyRef.current = seriesKey;
      candles.setData(
        bars.map((b) => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
      );
      volume.setData(
        bars.map((b) => ({
          time: toTime(b.time),
          value: b.volume,
          color: b.close >= b.open ? c.upSoft : c.downSoft,
        })),
      );
      loadedCountRef.current = bars.length;
      lastTimeRef.current = last ? last.time : 0;
      if ((reset || reload) && bars.length) {
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 130), to: bars.length + 5 });
      }
      return;
    }

    if (last.time < lastTimeRef.current) return;
    candles.update({ time: toTime(last.time), open: last.open, high: last.high, low: last.low, close: last.close });
    volume.update({
      time: toTime(last.time),
      value: last.volume,
      color: last.close >= last.open ? c.upSoft : c.downSoft,
    });
    loadedCountRef.current = bars.length;
    lastTimeRef.current = last.time;
  }, [bars, seriesKey, c.upSoft, c.downSoft]);

  /* overlay lines */
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    for (const line of priceLinesRef.current) candles.removePriceLine(line);
    priceLinesRef.current = lines
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        candles.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: l.width ?? 1,
          lineStyle: LINE_STYLE[l.style ?? "solid"],
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  /* wick-signal markers */
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const pins: SeriesMarker<Time>[] = markers.map((m) => ({
      time: toTime(m.openTime),
      position: m.type === "upper" ? "aboveBar" : "belowBar",
      color: m.type === "upper" ? c.down : c.up,
      shape: m.type === "upper" ? "arrowDown" : "arrowUp",
      text: `W ${m.wickPct.toFixed(0)}%`,
    }));
    plugin.setMarkers(pins);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markersKey, c.up, c.down]);

  return (
    <div
      ref={frameRef}
      className={cn("panel flex min-h-0 flex-col", full && "rounded-none border-0")}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-2.5 py-1.5">
        <Segmented
          value={interval}
          options={CHART_INTERVALS.map((i) => ({ value: i.value, label: i.label }))}
          onChange={onInterval}
          className="h-7 w-[196px]"
        />
        <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          W = closed-1H wick signal
        </span>
        <Button tone="ghost" size="sm" onClick={toggleFull} className="ml-auto" title="Fullscreen">
          {full ? <Minimize2 className="h-[12px] w-[12px]" /> : <Maximize2 className="h-[12px] w-[12px]" />}
          {full ? "Exit" : "Fullscreen"}
        </Button>
      </header>
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
      <div className="num flex shrink-0 flex-wrap gap-x-4 gap-y-0.5 border-t border-line-soft px-2.5 py-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: c.down }} />
          24h high/low · dashed
        </span>
        <span>
          walls · <span style={{ color: c.amber }}>amber</span> = liq clusters
        </span>
        <span>volume in base units</span>
      </div>
    </div>
  );
});

/** Overlay lines for one instrument's chart, from live reads. */
export function buildChartLines(args: {
  high24h?: number;
  low24h?: number;
  bidWalls: { price: number; notional: number }[];
  askWalls: { price: number; notional: number }[];
  clusters: { price: number; notional: number }[];
  mark?: number;
  dark: boolean;
}): ChartLine[] {
  const c = args.dark ? DARK : LIGHT;
  const out: ChartLine[] = [];
  if (args.high24h) out.push({ id: "h24h", price: args.high24h, color: c.down, title: "24H HIGH", style: "dashed" });
  if (args.low24h) out.push({ id: "h24l", price: args.low24h, color: c.up, title: "24H LOW", style: "dashed" });
  for (const w of args.askWalls.slice(0, 3)) {
    out.push({ id: `aw${w.price}`, price: w.price, color: c.down, title: `WALL ${fmtCompactUsd(w.notional)}`, style: "dotted" });
  }
  for (const w of args.bidWalls.slice(0, 3)) {
    out.push({ id: `bw${w.price}`, price: w.price, color: c.up, title: `WALL ${fmtCompactUsd(w.notional)}`, style: "dotted" });
  }
  for (const cl of args.clusters.slice(0, 3)) {
    out.push({ id: `lq${cl.price}`, price: cl.price, color: c.amber, title: `LIQ ${fmtCompactUsd(cl.notional)}` });
  }
  return out;
}
