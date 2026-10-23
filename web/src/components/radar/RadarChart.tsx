import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { memo, useEffect, useMemo, useRef } from "react";

import type { ChartBar } from "@/lib/radar/types";

/** Colours mirror the terminal's semantic tokens (`--pos`, `--neg`, `--primary`). */
export const CHART_COLORS = {
  up: "#35b57c",
  down: "#e2475a",
  upSoft: "rgba(53,181,124,0.35)",
  downSoft: "rgba(226,71,90,0.35)",
  amber: "#f7a21b",
  text: "#7a8191",
  line: "#1f232c",
  grid: "rgba(210,216,228,0.045)",
} as const;

export interface PriceLineSpec {
  id: string;
  price: number;
  color: string;
  title: string;
  style?: "solid" | "dashed" | "dotted";
  width?: 1 | 2;
}

const LINE_STYLE = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
} as const;

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/**
 * Candles plus volume for the focused contract, with price lines for the
 * levels the radar finds: the 24h high, whale walls and liquidation clusters.
 *
 * History arrives as one array; live bars update the last element. The chart
 * is created once per mount and fed incrementally, so a 4 Hz snapshot clock
 * never rebuilds it.
 */
export const RadarChart = memo(function RadarChart({
  bars,
  seriesKey,
  decimals,
  lines,
  height = 320,
}: {
  bars: ChartBar[];
  /** Changes when the symbol or interval changes, which resets the series. */
  seriesKey: string;
  decimals: number;
  lines: PriceLineSpec[];
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const loadedKeyRef = useRef<string>("");
  const loadedCountRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const linesKey = useMemo(
    () => lines.map((l) => `${l.id}:${l.price}:${l.color}:${l.title}:${l.style ?? "solid"}:${l.width ?? 1}`).join("|"),
    [lines],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: CHART_COLORS.text,
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderColor: CHART_COLORS.line, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: CHART_COLORS.line, timeVisible: true, secondsVisible: false, rightOffset: 5 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      borderVisible: false,
      wickUpColor: CHART_COLORS.up,
      wickDownColor: CHART_COLORS.down,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

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
      priceLinesRef.current = [];
    };
  }, []);

  // Price precision follows the contract; sub-cent alts need up to 8 decimals.
  useEffect(() => {
    candlesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: decimals, minMove: 10 ** -decimals },
    });
  }, [decimals]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume) return;

    const last = bars[bars.length - 1];
    const reset = loadedKeyRef.current !== seriesKey || bars.length < loadedCountRef.current || !last;
    // More than one new bar since the last paint (a throttled background tab):
    // reload the series so no bar is skipped, but leave the viewport alone.
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
          color: b.close >= b.open ? CHART_COLORS.upSoft : CHART_COLORS.downSoft,
        })),
      );
      loadedCountRef.current = bars.length;
      lastTimeRef.current = last ? last.time : 0;
      if (reset && bars.length) {
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 110), to: bars.length + 5 });
      }
      return;
    }

    // Incremental: the newest bar either replaces the last one or appends.
    if (last.time < lastTimeRef.current) return;
    candles.update({ time: toTime(last.time), open: last.open, high: last.high, low: last.low, close: last.close });
    volume.update({
      time: toTime(last.time),
      value: last.volume,
      color: last.close >= last.open ? CHART_COLORS.upSoft : CHART_COLORS.downSoft,
    });
    loadedCountRef.current = bars.length;
    lastTimeRef.current = last.time;
  }, [bars, seriesKey]);

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
    // `linesKey` is the stable identity of `lines`; the array itself is rebuilt on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  return <div ref={hostRef} style={{ height }} className="w-full" />;
});
