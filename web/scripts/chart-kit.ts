/**
 * Annotated candlestick panels for the PDF manuals.
 *
 * `pdf-kit` typesets prose; this draws the evidence. Every figure is a vector
 * chart built from OHLC data at true scale — candles, wicks, volume, session
 * VWAP, volume profile and the annotation layer (rings, arrows, measuring
 * brackets) that points at the thing being explained.
 *
 * Drawn rather than screenshotted for three reasons: it stays sharp at any zoom,
 * the annotations land on exact prices instead of approximate pixels, and the
 * geometry that carries the lesson — wick-to-body ratio, volume relationship,
 * distance from the mean — is preserved instead of being incidental.
 */
import { rgb, type PDFPage, type RGB } from "pdf-lib";

import { CONTENT_W, Doc, MARGIN, MUTED, sanitize } from "./pdf-kit";

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/** Terminal palette, matched to the app's dark chart surface. */
export const C = {
  panel: rgb(0.043, 0.051, 0.067),
  panelEdge: rgb(0.15, 0.17, 0.21),
  header: rgb(0.075, 0.085, 0.106),
  grid: rgb(0.129, 0.145, 0.176),
  axis: rgb(0.5, 0.54, 0.6),
  ink: rgb(0.93, 0.945, 0.96),
  up: rgb(0.153, 0.804, 0.545),
  down: rgb(0.976, 0.353, 0.42),
  amber: rgb(0.98, 0.68, 0.16),
  cyan: rgb(0.36, 0.76, 0.95),
  violet: rgb(0.64, 0.56, 0.98),
  neutral: rgb(0.42, 0.47, 0.55),
  wash: rgb(0.85, 0.88, 0.94),
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

/** `[open, high, low, close]`. */
export type OHLC = readonly [number, number, number, number];

export interface ChartLine {
  price: number;
  label: string;
  color?: RGB;
  dash?: boolean;
  thickness?: number;
  /** Suppress the price chip in the right gutter. */
  bare?: boolean;
  /** Candle index to centre the label chip on; default is the left edge. Candles draw over chips, so pick a clear spot. */
  labelAt?: number;
}

/** Horizontal price band — supply/demand shelf, value area, wick zone. */
export interface ChartZone {
  from: number;
  to: number;
  label?: string;
  color?: RGB;
  opacity?: number;
}

/** Vertical highlight behind a candle or a run of candles. */
export interface ChartBand {
  i: number;
  j?: number;
  label?: string;
  color?: RGB;
  opacity?: number;
}

export interface ChartNote {
  /** Candle index the arrow points at. */
  i: number;
  /** Price the arrow points at. */
  price: number;
  text: string;
  /** Label offset from the anchor, in points. Sign drives the box alignment. */
  dx?: number;
  dy?: number;
  /** Draws an ellipse around the anchor. Radii in points. */
  ring?: number | { rx: number; ry: number };
  color?: RGB;
  maxWidth?: number;
  /** Hide the connector when the label sits directly on the subject. */
  bare?: boolean;
}

/** Vertical measuring bracket, e.g. the length of a wick. */
export interface ChartSpan {
  i: number;
  from: number;
  to: number;
  text: string;
  /** Horizontal offset from the candle centre, in points. */
  dx?: number;
  color?: RGB;
}

export interface ChartProfile {
  /** `[price, volume]` rows, any order. */
  bins: readonly (readonly [number, number])[];
  poc?: number;
  width?: number;
  /** Bins holding at least this fraction of the heaviest bin are drawn as high-volume nodes. */
  hvn?: number;
}

/** A series drawn as a polyline over the candles, e.g. a moving average. */
export interface ChartCurve {
  /** One value per candle; `null` leaves a gap. */
  values: readonly (number | null)[];
  label: string;
  color?: RGB;
  thickness?: number;
}

export interface ChartLegend {
  label: string;
  color: RGB;
}

export interface ChartSpec {
  /** Instrument strip, e.g. `SOLUSDT PERP - 5m - UTC`. */
  tag: string;
  headline: string;
  candles: readonly OHLC[];
  volumes?: readonly number[];
  /** Plot height in points. Default 168. */
  height?: number;
  lines?: readonly ChartLine[];
  zones?: readonly ChartZone[];
  bands?: readonly ChartBand[];
  notes?: readonly ChartNote[];
  spans?: readonly ChartSpan[];
  profile?: ChartProfile;
  curves?: readonly ChartCurve[];
  legend?: readonly ChartLegend[];
  caption?: string;
  decimals?: number;
  scale?: { min?: number; max?: number };
  /** Index of an unclosed candle: drawn hollow, because it is not a fact yet. */
  live?: number;
  /** Candle indices drawn at reduced opacity — context, not subject. */
  faded?: readonly number[];
  /** Overrides the automatic candle width cap. */
  candleWidth?: number;
  axis?: readonly { i: number; label: string }[];
  /** Empty candle slots kept free on the right, e.g. under a volume profile. */
  padRight?: number;
}

/* ------------------------------------------------------------------ */
/* Figure numbering                                                   */
/* ------------------------------------------------------------------ */

let figureSeq = 0;

/** Next figure number, zero-padded. Shared by charts and image plates. */
export function nextFigure(): { n: number; id: string } {
  figureSeq += 1;
  return { n: figureSeq, id: `FIG ${String(figureSeq).padStart(2, "0")}` };
}

export function figureCount(): number {
  return figureSeq;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

const HEADER_H = 19;
const AXIS_H = 12;
const PRICE_GUTTER = 46;
const PAD_L = 9;

function fmtPrice(n: number, dp: number): string {
  return n.toFixed(dp);
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

function arrow(page: PDFPage, from: { x: number; y: number }, to: { x: number; y: number }, color: RGB): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;

  page.drawLine({ start: from, end: to, thickness: 0.75, color, opacity: 0.9 });

  const head = 4.6;
  const spread = 0.42;
  for (const sign of [1, -1]) {
    const angle = Math.atan2(uy, ux) + Math.PI + sign * spread;
    page.drawLine({
      start: to,
      end: { x: to.x + Math.cos(angle) * head, y: to.y + Math.sin(angle) * head },
      thickness: 0.75,
      color,
      opacity: 0.9,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Renderer                                                           */
/* ------------------------------------------------------------------ */

/**
 * Draws one annotated candlestick panel at the document cursor, breaking to a
 * new page first when it will not fit.
 *
 * @returns the figure id, so prose can reference it.
 */
export function chart(doc: Doc, spec: ChartSpec): string {
  const { sans, sansBold, mono, monoBold } = doc.fonts;
  const dp = spec.decimals ?? 2;
  const candles = spec.candles;
  const n = candles.length;
  if (n === 0) throw new Error(`chart "${spec.headline}" has no candles`);

  const plotH = spec.height ?? 168;
  const volH = spec.volumes && spec.volumes.length > 0 ? 26 : 0;
  const panelH = HEADER_H + 6 + plotH + volH + AXIS_H + 6;

  const captionLines = spec.caption ? doc.wrap(spec.caption, sans, 7.8, CONTENT_W - 30) : [];
  const legendH = spec.legend && spec.legend.length > 0 ? 12 : 0;
  const total = panelH + legendH + captionLines.length * 10.4 + (captionLines.length > 0 ? 8 : 0) + 12;

  doc.need(total);
  const page = doc.current;
  const top = doc.cursor + 4;
  const fig = nextFigure();

  /* ---- shell ---- */
  page.drawRectangle({
    x: MARGIN.x,
    y: top - panelH,
    width: CONTENT_W,
    height: panelH,
    color: C.panel,
    borderColor: C.panelEdge,
    borderWidth: 0.6,
  });
  page.drawRectangle({ x: MARGIN.x, y: top - HEADER_H, width: CONTENT_W, height: HEADER_H, color: C.header });
  page.drawRectangle({ x: MARGIN.x, y: top - HEADER_H, width: 2.2, height: HEADER_H, color: C.amber });

  page.drawText(sanitize(fig.id), { x: MARGIN.x + 9, y: top - 13, size: 6.6, font: monoBold, color: C.amber });
  page.drawText(sanitize(spec.headline), {
    x: MARGIN.x + 42,
    y: top - 13.2,
    size: 8.2,
    font: sansBold,
    color: C.ink,
  });
  const tag = sanitize(spec.tag.toUpperCase());
  page.drawText(tag, {
    x: MARGIN.x + CONTENT_W - 9 - mono.widthOfTextAtSize(tag, 6.4),
    y: top - 12.8,
    size: 6.4,
    font: mono,
    color: C.axis,
  });

  /* ---- plot frame ---- */
  const plotX = MARGIN.x + PAD_L;
  const plotW = CONTENT_W - PAD_L - PRICE_GUTTER;
  const plotTop = top - HEADER_H - 6;
  const plotBottom = plotTop - plotH;
  const volTop = plotBottom - 4;

  /* ---- price scale ---- */
  let lo = Infinity;
  let hi = -Infinity;
  const consider = (v: number): void => {
    if (!Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (const [, h, l] of candles) {
    consider(h);
    consider(l);
  }
  for (const line of spec.lines ?? []) consider(line.price);
  for (const zone of spec.zones ?? []) {
    consider(zone.from);
    consider(zone.to);
  }
  for (const span of spec.spans ?? []) {
    consider(span.from);
    consider(span.to);
  }
  for (const bin of spec.profile?.bins ?? []) consider(bin[0]);
  for (const curve of spec.curves ?? []) {
    for (const v of curve.values) if (v !== null) consider(v);
  }

  const rawRange = hi - lo || Math.max(hi * 0.01, 1);
  lo = spec.scale?.min ?? lo - rawRange * 0.09;
  hi = spec.scale?.max ?? hi + rawRange * 0.09;
  const range = hi - lo;

  const y = (price: number): number => plotBottom + ((price - lo) / range) * plotH;
  const step = plotW / (n + (spec.padRight ?? 0));
  const cw = spec.candleWidth ?? Math.min(11, Math.max(2.6, step * 0.6));
  const x = (i: number): number => plotX + step * (i + 0.5);

  /* ---- grid + price axis ---- */
  // Reference lines carry their own price chip, so a grid label at the same
  // height would print twice on top of itself.
  const chipYs = (spec.lines ?? []).filter((l) => !l.bare).map((l) => y(l.price));
  const gridStep = niceStep(range, 5);
  const first = Math.ceil(lo / gridStep) * gridStep;
  for (let p = first; p <= hi; p += gridStep) {
    const gy = y(p);
    page.drawLine({
      start: { x: plotX, y: gy },
      end: { x: plotX + plotW, y: gy },
      thickness: 0.4,
      color: C.grid,
    });
    if (chipYs.every((cy) => Math.abs(cy - gy) > 7)) {
      page.drawText(fmtPrice(p, dp), {
        x: plotX + plotW + 6,
        y: gy - 2.2,
        size: 6.2,
        font: mono,
        color: C.axis,
      });
    }
  }
  page.drawLine({
    start: { x: plotX + plotW + 1.5, y: plotBottom },
    end: { x: plotX + plotW + 1.5, y: plotTop },
    thickness: 0.4,
    color: C.grid,
  });

  /* ---- zones ---- */
  for (const zone of spec.zones ?? []) {
    const zTop = y(Math.max(zone.from, zone.to));
    const zBottom = y(Math.min(zone.from, zone.to));
    const color = zone.color ?? C.amber;
    page.drawRectangle({
      x: plotX,
      y: zBottom,
      width: plotW,
      height: Math.max(1, zTop - zBottom),
      color,
      opacity: zone.opacity ?? 0.13,
    });
    page.drawLine({ start: { x: plotX, y: zTop }, end: { x: plotX + plotW, y: zTop }, thickness: 0.4, color, opacity: 0.5 });
    page.drawLine({
      start: { x: plotX, y: zBottom },
      end: { x: plotX + plotW, y: zBottom },
      thickness: 0.4,
      color,
      opacity: 0.5,
    });
    if (zone.label) {
      page.drawText(sanitize(zone.label.toUpperCase()), {
        x: plotX + 4,
        y: zTop - 8,
        size: 5.9,
        font: monoBold,
        color,
        opacity: 0.95,
      });
    }
  }

  /* ---- vertical bands ---- */
  for (const band of spec.bands ?? []) {
    const j = band.j ?? band.i;
    const bx = x(band.i) - step / 2;
    const bw = x(j) + step / 2 - bx;
    const color = band.color ?? C.amber;
    page.drawRectangle({ x: bx, y: plotBottom, width: bw, height: plotH, color, opacity: band.opacity ?? 0.09 });
    if (band.label) {
      const label = sanitize(band.label.toUpperCase());
      page.drawText(label, {
        x: bx + bw / 2 - monoBold.widthOfTextAtSize(label, 5.9) / 2,
        y: plotTop - 9,
        size: 5.9,
        font: monoBold,
        color,
      });
    }
  }

  /* ---- volume profile ---- */
  if (spec.profile) {
    const bins = spec.profile.bins;
    const maxVol = Math.max(...bins.map((b) => b[1]), 1);
    const maxW = spec.profile.width ?? 74;
    const binH = bins.length > 1 ? Math.abs(y(bins[1][0]) - y(bins[0][0])) : 8;
    const hvnFloor = spec.profile.hvn !== undefined ? spec.profile.hvn * maxVol : Infinity;
    for (const [price, vol] of bins) {
      const w = (vol / maxVol) * maxW;
      const isPoc = spec.profile.poc !== undefined && Math.abs(price - spec.profile.poc) < 1e-9;
      const isHvn = !isPoc && vol >= hvnFloor;
      page.drawRectangle({
        x: plotX + plotW - w,
        y: y(price) - binH * 0.4,
        width: w,
        height: Math.max(1.4, binH * 0.8),
        color: isPoc ? C.amber : isHvn ? C.cyan : C.neutral,
        opacity: isPoc ? 0.55 : isHvn ? 0.42 : 0.26,
      });
    }
  }

  /* ---- curves ---- */
  for (const curve of spec.curves ?? []) {
    const color = curve.color ?? C.violet;
    const vals = curve.values;
    let lastIdx = -1;
    for (let i = 1; i < Math.min(vals.length, n); i += 1) {
      const a = vals[i - 1];
      const b = vals[i];
      if (a === null || b === null || a === undefined || b === undefined) continue;
      page.drawLine({
        start: { x: x(i - 1), y: y(a) },
        end: { x: x(i), y: y(b) },
        thickness: curve.thickness ?? 1.1,
        color,
        opacity: 0.95,
      });
      lastIdx = i;
    }
    if (lastIdx >= 0) {
      const v = vals[lastIdx];
      if (v !== null && v !== undefined) {
        const label = sanitize(curve.label.toUpperCase());
        const lw = monoBold.widthOfTextAtSize(label, 5.9);
        const lx = Math.min(x(lastIdx) + 4, plotX + plotW - lw - 8);
        page.drawRectangle({ x: lx - 2, y: y(v) + 3, width: lw + 5, height: 8.4, color: C.panel, opacity: 0.86 });
        page.drawText(label, { x: lx, y: y(v) + 5.2, size: 5.9, font: monoBold, color });
      }
    }
  }

  /* ---- price lines ---- */
  for (const line of spec.lines ?? []) {
    const ly = y(line.price);
    const color = line.color ?? C.cyan;
    page.drawLine({
      start: { x: plotX, y: ly },
      end: { x: plotX + plotW, y: ly },
      thickness: line.thickness ?? 0.7,
      color,
      opacity: 0.92,
      dashArray: line.dash === false ? undefined : [3, 2.2],
    });
    const label = sanitize(line.label.toUpperCase());
    const lw = monoBold.widthOfTextAtSize(label, 5.9);
    const chipX =
      line.labelAt !== undefined
        ? Math.min(Math.max(x(line.labelAt) - lw / 2 - 3, plotX + 3), plotX + plotW - lw - 9)
        : plotX + 3;
    page.drawRectangle({ x: chipX, y: ly + 2.2, width: lw + 6, height: 8.4, color: C.panel, opacity: 0.86 });
    page.drawText(label, { x: chipX + 3, y: ly + 4.4, size: 5.9, font: monoBold, color });

    if (!line.bare) {
      const price = fmtPrice(line.price, dp);
      page.drawRectangle({
        x: plotX + plotW + 4,
        y: ly - 4,
        width: mono.widthOfTextAtSize(price, 6.2) + 5,
        height: 8.4,
        color: C.panel,
      });
      page.drawText(price, { x: plotX + plotW + 6, y: ly - 2.2, size: 6.2, font: monoBold, color });
    }
  }

  /* ---- candles ---- */
  const faded = new Set(spec.faded ?? []);
  candles.forEach((candle, i) => {
    const [o, h, l, c] = candle;
    const bull = c >= o;
    const color = bull ? C.up : C.down;
    const isLive = spec.live === i;
    const opacity = faded.has(i) ? 0.32 : 1;
    const cx = x(i);

    page.drawLine({
      start: { x: cx, y: y(l) },
      end: { x: cx, y: y(h) },
      thickness: Math.min(1.1, Math.max(0.6, cw * 0.11)),
      color,
      opacity,
      dashArray: isLive ? [1.6, 1.4] : undefined,
    });

    const bodyTop = y(Math.max(o, c));
    const bodyBottom = y(Math.min(o, c));
    const bodyH = Math.max(0.8, bodyTop - bodyBottom);
    if (isLive) {
      page.drawRectangle({
        x: cx - cw / 2,
        y: bodyBottom,
        width: cw,
        height: bodyH,
        borderColor: color,
        borderWidth: 0.7,
        borderOpacity: 0.95,
      });
    } else {
      page.drawRectangle({ x: cx - cw / 2, y: bodyBottom, width: cw, height: bodyH, color, opacity });
    }
  });

  /* ---- volume ---- */
  if (volH > 0 && spec.volumes) {
    const vols = spec.volumes;
    const maxV = Math.max(...vols, 1);
    page.drawLine({
      start: { x: plotX, y: volTop + 2 },
      end: { x: plotX + plotW, y: volTop + 2 },
      thickness: 0.4,
      color: C.grid,
    });
    const base = volTop - volH + 4;
    vols.forEach((v, i) => {
      const candle = candles[i];
      if (!candle) return;
      const bull = candle[3] >= candle[0];
      page.drawRectangle({
        x: x(i) - cw / 2,
        y: base,
        width: cw,
        height: Math.max(0.6, (v / maxV) * (volH - 6)),
        color: bull ? C.up : C.down,
        opacity: faded.has(i) ? 0.22 : 0.5,
      });
    });
    page.drawText("VOL", { x: plotX + plotW + 6, y: base + 1, size: 5.6, font: mono, color: C.axis });
  }

  /* ---- time axis ---- */
  for (const mark of spec.axis ?? []) {
    const label = sanitize(mark.label);
    page.drawText(label, {
      x: x(mark.i) - mono.widthOfTextAtSize(label, 5.8) / 2,
      y: top - panelH + 4,
      size: 5.8,
      font: mono,
      color: C.axis,
    });
  }

  /* ---- measuring brackets ---- */
  for (const span of spec.spans ?? []) {
    const color = span.color ?? C.amber;
    const sx = x(span.i) + (span.dx ?? 14);
    const y1 = y(span.from);
    const y2 = y(span.to);
    page.drawLine({ start: { x: sx, y: y1 }, end: { x: sx, y: y2 }, thickness: 0.6, color, opacity: 0.9 });
    for (const cy of [y1, y2]) {
      page.drawLine({ start: { x: sx - 3, y: cy }, end: { x: sx + 3, y: cy }, thickness: 0.6, color, opacity: 0.9 });
    }
    const label = sanitize(span.text);
    const labelW = monoBold.widthOfTextAtSize(label, 6.2);
    // Flip the label to the inside of the bracket when it would run into the
    // price gutter.
    const labelX = sx + 5 + labelW > plotX + plotW ? sx - 5 - labelW : sx + 5;
    page.drawText(label, {
      x: labelX,
      y: (y1 + y2) / 2 - 2,
      size: 6.2,
      font: monoBold,
      color,
    });
  }

  /* ---- notes ---- */
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const hits = (a: { x: number; y: number; w: number; h: number }): boolean =>
    placed.some(
      (b) => a.x < b.x + b.w + 3 && a.x + a.w + 3 > b.x && a.y < b.y + b.h + 3 && a.y + a.h + 3 > b.y,
    );

  for (const note of spec.notes ?? []) {
    const color = note.color ?? C.amber;
    const ax = x(note.i);
    const ay = y(note.price);

    let rx = 0;
    let ry = 0;
    if (note.ring !== undefined) {
      const r = typeof note.ring === "number" ? { rx: note.ring, ry: note.ring } : note.ring;
      rx = r.rx;
      ry = r.ry;
      page.drawEllipse({
        x: ax,
        y: ay,
        xScale: rx,
        yScale: ry,
        borderColor: color,
        borderWidth: 0.8,
        borderOpacity: 0.95,
      });
    }

    const maxWidth = note.maxWidth ?? 108;
    const lines = doc.wrap(note.text, sans, 6.6, maxWidth - 12);
    const boxW = Math.min(
      maxWidth,
      Math.max(...lines.map((l) => sans.widthOfTextAtSize(l, 6.6))) + 13,
    );
    const boxH = lines.length * 8.2 + 6;
    const dx = note.dx ?? 0;
    const dy = note.dy ?? 0;

    // Keep the label inside the plot: never over the price gutter, never in the
    // header, and never on top of a label that is already down.
    const minX = plotX;
    const maxX = Math.max(minX, plotX + plotW - boxW);
    const minY = plotBottom + 2;
    const maxY = Math.max(minY, plotTop - boxH - 12);
    const boxX = Math.min(Math.max(dx < 0 ? ax + dx - boxW : ax + dx, minX), maxX);

    let boxY = Math.min(Math.max(ay + dy - boxH / 2, minY), maxY);
    for (const nudge of [0, 13, -13, 26, -26, 39, -39, 52, -52, 65, -65]) {
      const candidate = Math.min(Math.max(boxY + nudge, minY), maxY);
      if (!hits({ x: boxX, y: candidate, w: boxW, h: boxH })) {
        boxY = candidate;
        break;
      }
    }
    placed.push({ x: boxX, y: boxY, w: boxW, h: boxH });
    const boxCY = boxY + boxH / 2;

    page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, color: C.header, opacity: 0.94 });
    page.drawRectangle({ x: boxX, y: boxY, width: 1.6, height: boxH, color });
    lines.forEach((line, i) => {
      page.drawText(sanitize(line), {
        x: boxX + 6,
        y: boxY + boxH - 8 - i * 8.2,
        size: 6.6,
        font: sans,
        color: C.ink,
      });
    });

    const inside = ax > boxX - 2 && ax < boxX + boxW + 2 && ay > boxY - 2 && ay < boxY + boxH + 2;
    if (!note.bare && !inside) {
      // Start the connector on the box edge that faces the anchor.
      const fromX = ax > boxX + boxW ? boxX + boxW : ax < boxX ? boxX : boxX + boxW / 2;
      const fromY = Math.abs(boxCY - ay) < boxH / 2 ? boxCY : boxCY > ay ? boxY : boxY + boxH;
      const vx = ax - fromX;
      const vy = ay - fromY;
      const len = Math.hypot(vx, vy) || 1;
      const gapX = (rx + 3) * (vx / len);
      const gapY = (ry + 3) * (vy / len);
      arrow(page, { x: fromX, y: fromY }, { x: ax - gapX, y: ay - gapY }, color);
    }
  }

  doc.space(panelH + 4);

  /* ---- legend ---- */
  if (spec.legend && spec.legend.length > 0) {
    let lx = MARGIN.x;
    const ly = doc.cursor;
    for (const item of spec.legend) {
      page.drawRectangle({ x: lx, y: ly + 0.4, width: 5, height: 5, color: item.color });
      const label = sanitize(item.label);
      page.drawText(label, { x: lx + 8, y: ly, size: 6.4, font: mono, color: MUTED });
      lx += 8 + mono.widthOfTextAtSize(label, 6.4) + 14;
    }
    doc.space(12);
  }

  /* ---- caption ---- */
  if (captionLines.length > 0) {
    doc.space(4);
    const cy = doc.cursor;
    page.drawRectangle({ x: MARGIN.x, y: cy - captionLines.length * 10.4 + 6, width: 1.4, height: captionLines.length * 10.4 - 2, color: C.amber, opacity: 0.55 });
    page.drawText(sanitize(fig.id), { x: MARGIN.x + 8, y: cy, size: 6.6, font: monoBold, color: rgb(0.55, 0.42, 0.1) });
    captionLines.forEach((line, i) => {
      page.drawText(sanitize(line), {
        x: MARGIN.x + 8 + (i === 0 ? mono.widthOfTextAtSize("FIG 00", 6.6) + 6 : 0),
        y: cy - i * 10.4,
        size: 7.8,
        font: doc.fonts.sans,
        color: MUTED,
      });
    });
    doc.space(captionLines.length * 10.4 + 4);
  }

  doc.space(6);
  return fig.id;
}

/* ------------------------------------------------------------------ */
/* Synthesis helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Builds a candle series from a compact spec, so the figures stay readable in
 * source: each entry is `[open, high, low, close]`.
 */
export function series(rows: readonly OHLC[]): OHLC[] {
  return rows.map(([o, h, l, c]) => [o, h, l, c] as OHLC);
}

/**
 * Deterministic drift used to fill the context bars either side of a setup.
 * A fixed seed keeps every rebuild of the manual byte-identical in shape.
 */
export function drift(
  start: number,
  count: number,
  opts: { step?: number; wick?: number; bias?: number; seed?: number } = {},
): OHLC[] {
  const stepPct = opts.step ?? 0.0022;
  const wickPct = opts.wick ?? 0.0016;
  const bias = opts.bias ?? 0;
  let seed = opts.seed ?? 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const out: OHLC[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const move = (rand() - 0.5 + bias) * 2 * stepPct * open;
    const close = open + move;
    const high = Math.max(open, close) + rand() * wickPct * open;
    const low = Math.min(open, close) - rand() * wickPct * open;
    out.push([open, high, low, close]);
    price = close;
  }
  return out;
}

/** Volume series shaped to a profile of multipliers against a base. */
export function volumes(base: number, shape: readonly number[]): number[] {
  return shape.map((m) => base * m);
}

/** Symmetric-ish volume profile bins around a point of control. */
export function profileBins(
  from: number,
  to: number,
  count: number,
  poc: number,
  spread: number,
): { bins: [number, number][]; poc: number } {
  const bins: [number, number][] = [];
  const stepSize = (to - from) / (count - 1);
  let pocPrice = from;
  let best = Infinity;
  for (let i = 0; i < count; i += 1) {
    const price = from + stepSize * i;
    const z = (price - poc) / spread;
    const vol = Math.exp(-0.5 * z * z) + 0.08;
    bins.push([price, vol]);
    const gap = Math.abs(price - poc);
    if (gap < best) {
      best = gap;
      pocPrice = price;
    }
  }
  return { bins, poc: pocPrice };
}
