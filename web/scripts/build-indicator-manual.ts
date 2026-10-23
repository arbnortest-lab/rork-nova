/**
 * Builds `public/nova-exhaustion-manual.pdf` — the operator manual for the
 * Nova Exhaustion Trap TradingView indicator.
 *
 * Gate thresholds are imported from the live engine so the document cannot
 * drift away from the software it describes.
 *
 *   bun run scripts/build-indicator-manual.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rgb } from "pdf-lib";

import { DEFAULT_WICK_RULES, RVOL_LOOKBACK, TRAP_LOOKBACK, TRAP_SCAN } from "../src/lib/wick/rules";
import { GATE_LABEL, GATE_ORDER } from "../src/lib/wick/types";
import { C, chart, drift, figureCount, nextFigure, series, volumes, type OHLC } from "./chart-kit";
import {
  AMBER,
  CONTENT_W,
  DARK,
  Doc,
  GREEN,
  MARGIN,
  MUTED,
  PAGE,
  PAPER,
  RED,
  sanitize,
} from "./pdf-kit";

const VERSION = "v1.2";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(ROOT, "../public/nova-exhaustion-manual.pdf");
const PINE = path.resolve(ROOT, "../public/nova-exhaustion-trap.pine");

const R = DEFAULT_WICK_RULES;

const doc = await Doc.create();

/** Sub-heading that refuses to be orphaned above a figure that will not fit. */
function figSub(title: string, need = 330): void {
  doc.need(need);
  doc.sub(title);
}

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

{
  const page = doc.current;
  page.drawRectangle({ x: 0, y: PAGE.h - 250, width: PAGE.w, height: 250, color: DARK });
  page.drawRectangle({ x: MARGIN.x, y: PAGE.h - 250, width: 3, height: 250, color: AMBER });

  page.drawText("NOVA", { x: MARGIN.x + 22, y: PAGE.h - 108, size: 40, font: doc.fonts.sansBold, color: PAPER });
  page.drawText("EXHAUSTION TRAP", {
    x: MARGIN.x + 22,
    y: PAGE.h - 146,
    size: 22,
    font: doc.fonts.sansBold,
    color: AMBER,
  });
  page.drawText("TRADINGVIEW INDICATOR - OPERATOR MANUAL", {
    x: MARGIN.x + 22,
    y: PAGE.h - 176,
    size: 9,
    font: doc.fonts.mono,
    color: rgb(0.62, 0.66, 0.72),
  });
  page.drawText(`PINE SCRIPT v6  -  ${VERSION.toUpperCase()}`, {
    x: MARGIN.x + 22,
    y: PAGE.h - 206,
    size: 8,
    font: doc.fonts.monoBold,
    color: rgb(0.62, 0.66, 0.72),
  });

  doc.space(268);
  doc.body(
    "One model, four gates, no partial credit, one direction. This indicator marks a chart only when an " +
      "asset has run completely out of fuel at its rolling 24-hour HIGH: price reaches that high, volume " +
      "climaxes and then cools, the bar posts a higher high and is immediately rejected by an upper wick " +
      `worth at least ${R.wickPct}% of its range, and the liquidity pool above is swept.`,
  );
  doc.body(
    "All four conditions must hold on the same bar. Three of four is not a signal, and the indicator will " +
      "not draw one. That restraint is the entire product: the marks are rare on purpose.",
  );

  doc.space(6);
  doc.callout(
    "Shorts only - this is a bull trap detector",
    [
      "The indicator finds failed breakouts at the 24-hour high and marks them as shorts. Bear traps, " +
        "capitulation lows and long entries are out of scope by design: nothing in the script measures the " +
        "24-hour low, and there is no long branch to switch on.",
      "If you want the mirror trade, this is not the tool. That is a deliberate limit, not an omission.",
    ],
    AMBER,
  );

  doc.space(6);
  doc.callout("What this document covers", [
    "Section 1-2  installing the script and reading the chart it draws.",
    "Section 3-7  what each of the four gates measures, and why.",
    "Section 8-10 trading the signal: entry, invalidation, targets, and the trades to skip.",
    "Every threshold quoted here is the shipped default and is adjustable in the settings dialog.",
  ]);

  doc.space(4);
  doc.sub("Contents");
  doc.rule();
}

const tocPage = doc.current;
const tocY = doc.cursor - 4;

// Reserve the rest of the cover for the contents list, which is replayed at the
// very end once every heading has been emitted. `heading()` only breaks pages
// once past page 1, so without this the first section prints over the TOC.
doc.newPage();

/* ------------------------------------------------------------------ */
/* 1 — Installation                                                    */
/* ------------------------------------------------------------------ */

doc.heading("Installing the indicator", { newPage: false });

doc.body(
  "The indicator ships as a single Pine Script v6 source file. TradingView has no installer — a script is " +
    "pasted into the Pine Editor and saved to your account, after which it behaves like any other indicator.",
);

doc.steps([
  {
    title: "Download the script from the dashboard",
    text:
      "Open the Wick module and use Download Pine Script in the TradingView indicator panel. The file is " +
      "nova-exhaustion-trap.pine. It is plain text; any editor will open it.",
  },
  {
    title: "Open the Pine Editor on TradingView",
    text:
      "On any chart, open the Pine Editor tab at the bottom of the screen. If it is not visible, use the " +
      "menu at the very bottom of the chart window to show it.",
  },
  {
    title: "Start a blank script",
    text: "Choose Open -> New blank indicator. Select every line of the placeholder that appears and delete it.",
  },
  {
    title: "Paste the whole file",
    text:
      "Paste the entire contents of the .pine file, including the comment header and the //@version=6 line. " +
      "The version line is not decoration: without it TradingView compiles the script as an older dialect " +
      "and it will fail.",
  },
  {
    title: "Save under a name you will recognise",
    text: 'Press Save and name it "Nova Exhaustion Trap". This stores it in your account under Indicators -> My scripts.',
  },
  {
    title: "Add it to the chart",
    text:
      "Press Add to chart. The 24h high rail, the long-horizon high and the gate panel appear immediately. " +
      "Signals appear only where all four gates were open, so a clean chart is the normal result.",
  },
]);

doc.callout(
  "Choose an intraday timeframe",
  [
    "The 24-hour window is counted in bars, so the chart timeframe must divide into a day. Any chart from " +
      "1 minute to 12 hours works. On a daily chart or higher there is no rolling 24h to measure, and the " +
      "indicator suppresses every signal and says so in the panel footer.",
    "5m and 15m are the working defaults: fast enough to catch the rejection while it is tradeable, slow " +
      "enough that the wick means something.",
  ],
  AMBER,
);

figSub("What a signal looks like", 300);

{
  const lead = drift(101.2, 11, { step: 0.0016, wick: 0.0012, bias: 0.06, seed: 21 });
  const push: OHLC[] = series([
    [102.1, 103.4, 102.0, 103.2],
    [103.2, 104.6, 103.1, 104.4],
    [104.4, 106.9, 104.3, 104.9],
  ]);
  const after: OHLC[] = series([
    [104.9, 105.0, 103.4, 103.6],
    [103.6, 103.8, 102.1, 102.3],
    [102.3, 102.5, 101.2, 101.5],
  ]);
  const candles = [...lead, ...push, ...after];
  const trap = lead.length + 2;

  chart(doc, {
    tag: "BTCUSDT PERP - 5m",
    headline: "The complete setup: all four gates open on one bar",
    candles,
    volumes: volumes(1, [
      ...lead.map(() => 0.5),
      0.9,
      1.5,
      3.4,
      1.2,
      1.0,
      0.8,
    ]),
    height: 186,
    decimals: 2,
    lines: [
      { price: 106.7, label: "24h high", color: C.down },
      { price: 106.95, label: "1y high", color: C.violet },
    ],
    bands: [{ i: trap, label: "signal bar", color: C.down, opacity: 0.12 }],
    spans: [{ i: trap, from: 104.9, to: 106.9, text: "wick 74% of range", dx: 15, color: C.amber }],
    notes: [
      {
        i: trap,
        price: 106.9,
        text: "Gate 1+4: swept the 24h high and the 1-year high together. Nothing resting above.",
        dx: -14,
        dy: 26,
        ring: { rx: 5, ry: 4 },
        color: C.down,
        maxWidth: 132,
      },
      {
        i: trap,
        price: 104.95,
        text: "Gate 3: rejected straight back into the range and closed at the low.",
        dx: 16,
        dy: -26,
        color: C.amber,
        maxWidth: 122,
      },
    ],
    legend: [
      { label: "24h high", color: C.down },
      { label: "1-year high", color: C.violet },
      { label: "measurement", color: C.amber },
    ],
    caption:
      "The bar takes out the 24h high on more than three times normal volume, fails, and closes back inside " +
      "the range. Every buyer filled in that wick is offside the moment it closes. That is the trade.",
  });
}

/* ------------------------------------------------------------------ */
/* 2 — Reading the chart                                               */
/* ------------------------------------------------------------------ */

doc.heading("Reading the chart");

doc.body(
  "The indicator draws four things: two reference rails, the signal marks themselves, near-miss triangles, " +
    "and a gate panel in the corner. Nothing else is plotted, because nothing else is used. Everything sits " +
    "above price, because every measurement this model makes is an upside one.",
);

doc.defs(
  [
    ["24h HIGH RAIL", "Thin line at the rolling 24-hour high. Gate 1 measures against this."],
    ["HORIZON RAIL", "Heavier faded line at the long-horizon high. Gate 4 measures against this."],
    ["SHORT LABEL", "All four gates passed on that bar. The bar is also recoloured."],
    ["SMALL TRIANGLE", "Three of four gates. Context only — deliberately not a trade."],
    ["GATE PANEL", "Live state of each gate on the most recent bar, with the measured number beside it."],
  ],
  120,
);

doc.sub("The gate panel");
doc.body(
  "The panel is the part worth learning. Each row names a gate, shows what it currently measures, and marks " +
    "PASS or a dash. A row marked n/a means the data is not available on this chart — an unmeasurable gate " +
    "never counts as passed, which is why a signal cannot appear while anything reads n/a.",
);

doc.table(
  [
    { header: "Row", width: 128 },
    { header: "Shows", width: 150, mono: true },
    { header: "Passes when", width: CONTENT_W - 278 },
  ],
  [
    ["1 · Reach 24h high", "distance in bps", `at or within ${R.pinBps} bps of the 24h high`],
    ["2 · Climax & cooling", "RVOL % and direction", `>= ${R.rvolClimax}% and falling (v)`],
    ["3 · Failed breakout", "upper wick as % of range", `higher high, wick >= ${R.wickPct}%`],
    ["4 · Upside depletion", "distance in %", `within ${R.depletionPct}% of the horizon high, either side`],
  ],
);

doc.callout(
  "The arrow beside RVOL matters",
  [
    "A v means relative volume is falling from the previous bar — the surge is spent. A ^ means it is still " +
      "rising, and gate 2 will not pass however large the number is.",
    "This catches the most common mistake in exhaustion trading: shorting into a volume spike that is still " +
      "building. A climax is only a climax once it is over.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 3 — The model                                                       */
/* ------------------------------------------------------------------ */

doc.heading("The model");

doc.body(
  "The premise is narrow. A market that has just made a 24-hour high, on enormous volume that has started " +
    "to fade, with a long upper wick rejecting the level, and with no further liquidity above it, has run " +
    "out of the thing that moves price higher: willing buyers at worse prices.",
);

doc.body(
  "Each gate on its own is a well-known and largely useless observation. New highs happen constantly. Volume " +
    "spikes happen constantly. Long wicks happen constantly. The model's only claim is that the intersection " +
    "is rare and asymmetric.",
);

doc.code([
  "SIGNAL  =  PIN  and  CLIMAX  and  TRAP  and  DEPLETION      (short)",
  "",
  "PIN        bar's HIGH within " + R.pinBps + " bps of the prior 24h high",
  "CLIMAX     RVOL >= " + R.rvolClimax + "%   AND   RVOL <= previous bar's RVOL",
  "TRAP       new " + TRAP_LOOKBACK + "-bar HIGH   AND   upper wick >= " + R.wickPct + "% of range",
  "DEPLETION  bar's HIGH within " + R.depletionPct + "% of the " + R.horizonDays + "-day high",
]);

doc.sub("Why all four, and never three");
doc.body(
  "Because each gate rules out a specific way of being wrong, and dropping any one of them re-admits exactly " +
    "the failure mode it existed to exclude.",
);

doc.table(
  [
    { header: "Drop this gate", width: 118 },
    { header: "and you start taking", width: CONTENT_W - 118 },
  ],
  [
    ["Pin", "Reversals in mid-range, where there is no trapped positioning to squeeze out."],
    ["Climax", "Quiet drifts to a high that nobody was forced into — nothing to unwind."],
    ["Trap", "Genuine breakouts. A new high that closes strong is continuation, not exhaustion."],
    ["Depletion", "Highs with a year of resting orders above them, which price expands into."],
  ],
);

doc.sub("Measured on the wick, not the close");
doc.body(
  "Gates 1 and 4 measure the bar's own high, never its close. This is deliberate and it matters: a " +
    "rejection wick closes far below the level it swept, by definition. Measuring the close would mean " +
    "gate 3 and gate 1 could never pass on the same bar, and the model would never fire at all.",
);

doc.sub("One direction: bull traps only");
doc.body(
  "This indicator is short-only. It looks exclusively for failed breakouts at the 24-hour high. The mirror " +
    "trade - a capitulation low that gets bought - is a real pattern and is explicitly not covered here. " +
    "Nothing in the script reads the 24-hour low, so a bear trap cannot produce a mark however clean it is.",
);

doc.body(
  "The asymmetry is the point. Breakout buyers at a 24-hour high are leveraged, late and stacked behind a " +
    "visible level, and when that level fails they are forced to sell into a market with no bid above. Lows " +
    "are made differently: capitulation is the position being closed, not opened, so the fuel is already " +
    "spent by the time the wick prints. The two are not symmetric trades, and this tool takes a position on " +
    "which one it wants.",
);

figSub("What the indicator now ignores", 300);

{
  const lead = drift(0.0472, 10, { step: 0.0026, wick: 0.0019, bias: -0.06, seed: 52 });
  const body: OHLC[] = series([
    [0.0441, 0.0443, 0.0428, 0.043],
    [0.043, 0.0432, 0.0398, 0.0427],
    [0.0427, 0.0448, 0.0425, 0.0446],
    [0.0446, 0.0462, 0.0444, 0.046],
  ]);
  const candles = [...lead, ...body];
  const trapIdx = lead.length + 1;

  chart(doc, {
    tag: "BEAR TRAP - DELIBERATELY NOT A SIGNAL",
    headline: "A textbook capitulation low. No mark is drawn.",
    candles,
    volumes: volumes(1, [...lead.map(() => 0.5), 1.3, 3.6, 1.4, 1.0]),
    height: 176,
    decimals: 4,
    lines: [
      { price: 0.0402, label: "24h low", color: C.up },
      { price: 0.0399, label: "1y low", color: C.violet },
    ],
    bands: [{ i: trapIdx, label: "ignored", color: C.neutral, opacity: 0.1 }],
    spans: [{ i: trapIdx, from: 0.0398, to: 0.0427, text: "lower wick 85%", dx: 15, color: C.neutral }],
    notes: [
      {
        i: trapIdx,
        price: 0.0398,
        text: "Swept the 24h low and the 1-year low on fading volume - and the indicator says nothing.",
        dx: 16,
        dy: -14,
        ring: { rx: 5, ry: 4 },
        color: C.neutral,
        maxWidth: 128,
      },
    ],
    legend: [
      { label: "24h low (unread)", color: C.up },
      { label: "1-year low (unread)", color: C.violet },
      { label: "ignored", color: C.neutral },
    ],
    caption:
      "Every gate has an obvious mirror here, and the indicator measures none of them. Gate 1 reads the " +
      "distance UP to the 24-hour high, which on this bar is enormous, so the setup fails at the first gate " +
      "and never reaches the others. This is the intended behaviour, not a gap.",
  });
}

/* ------------------------------------------------------------------ */
/* 4 — Gate 1                                                          */
/* ------------------------------------------------------------------ */

doc.heading(`Gate 1 — ${GATE_LABEL[GATE_ORDER[0]]}`);

doc.body(
  `The bar's high must reach, sweep or pin the rolling 24-hour high — within ${R.pinBps} basis points of it, ` +
    "which is five hundredths of one percent. Trading clean through the level scores zero distance: a sweep " +
    "is the most complete way of reaching a level, not a miss.",
);

doc.body(
  "The window is the previous 24 hours, offset by one bar so the current bar is not compared against a range " +
    "that already contains it. Without that offset every new high would trivially score zero and the gate " +
    "would be meaningless.",
);

doc.callout(
  "What this gate is really asking",
  [
    "Is there a dense shelf of stop orders immediately here? A 24-hour high is the most-watched short-term " +
      "level on any chart. Breakout buyers rest orders above it; anyone short from below rests protective " +
      "stops there too.",
    "That is what makes the level worth sweeping — and what makes the sweep violent enough to be visible.",
  ],
  AMBER,
);

figSub("Reaching the level, and missing it", 300);

{
  const lead = drift(99.6, 10, { step: 0.0018, wick: 0.0014, bias: 0.05, seed: 44 });
  const body: OHLC[] = series([
    [100.8, 101.4, 100.7, 101.3],
    [101.3, 102.0, 101.2, 101.4],
    [101.4, 103.9, 101.3, 102.0],
    [102.0, 102.4, 101.1, 101.3],
  ]);
  const candles = [...lead, ...body];
  const missIdx = lead.length + 1;
  const hitIdx = lead.length + 2;

  chart(doc, {
    tag: "GATE 1 - THE 24H RAIL",
    headline: "Two bars at the same high: one reached it, one did not",
    candles,
    height: 172,
    decimals: 2,
    lines: [{ price: 103.8, label: "24h high", color: C.down }],
    notes: [
      {
        i: missIdx,
        price: 102.0,
        text: "17 bps short. Close to the level is not at the level — gate 1 fails.",
        dx: -14,
        dy: -18,
        ring: { rx: 4.5, ry: 4 },
        color: C.neutral,
        maxWidth: 124,
      },
      {
        i: hitIdx,
        price: 103.9,
        text: "Traded through it. Distance floors at zero — gate 1 passes.",
        dx: 14,
        dy: 12,
        ring: { rx: 4.5, ry: 4 },
        color: C.down,
        maxWidth: 118,
      },
    ],
    caption:
      "Only the bar whose high actually touches the rail can arm. The gap on the earlier bar looks small on " +
      "a chart, but the stop cluster sits above the rail, not near it — unreached, nothing is triggered.",
  });
}

/* ------------------------------------------------------------------ */
/* 5 — Gate 2                                                          */
/* ------------------------------------------------------------------ */

doc.heading(`Gate 2 — ${GATE_LABEL[GATE_ORDER[1]]}`);

doc.body(
  `Relative volume must spike to at least ${R.rvolClimax}% of its recent average — three times normal — and ` +
    "must be lower than the previous bar's reading. Both halves are required, and the second half is the one " +
    "that does the work.",
);

doc.defs(
  [
    ["RVOL", `this bar's volume / average of the last ${RVOL_LOOKBACK} bars, as a percentage`],
    ["CLIMAX", `RVOL >= ${R.rvolClimax}%`],
    ["COOLING", "RVOL at or below the previous bar's RVOL"],
  ],
  96,
);

doc.body(
  "A rising volume spike means participants are still arriving. Price has fuel, and fading it is standing in " +
    "front of the move. A falling spike immediately after a peak means the opposite: the flow that drove the " +
    "push has been absorbed and there is nobody left to pay higher prices.",
);

figSub("The same spike, one bar apart", 300);

{
  const lead = drift(50.2, 9, { step: 0.0022, wick: 0.0016, bias: 0.05, seed: 9 });
  const body: OHLC[] = series([
    [51.0, 51.9, 50.9, 51.8],
    [51.8, 53.4, 51.7, 53.2],
    [53.2, 54.6, 53.1, 53.3],
    [53.3, 53.5, 52.2, 52.4],
  ]);
  const candles = [...lead, ...body];
  const buildIdx = lead.length + 1;
  const peakIdx = lead.length + 2;

  chart(doc, {
    tag: "GATE 2 - RVOL AND DIRECTION",
    headline: "Accelerating is not exhausted",
    candles,
    volumes: volumes(1, [...lead.map(() => 0.45), 1.4, 3.1, 3.9, 1.1]),
    height: 168,
    decimals: 2,
    notes: [
      {
        i: buildIdx,
        price: 53.2,
        text: "RVOL 310% but rising. Gate 2 fails — the move still has fuel.",
        dx: -14,
        dy: 14,
        color: C.neutral,
        maxWidth: 124,
      },
      {
        i: peakIdx,
        price: 54.6,
        text: "RVOL 390% and now falling against the prior bar. Gate 2 passes.",
        dx: 14,
        dy: 22,
        ring: { rx: 4.5, ry: 4 },
        color: C.amber,
        maxWidth: 126,
      },
    ],
    caption:
      "Both bars clear the 300% bar comfortably. Only the second is cooling, and only the second can arm the " +
      "gate. Shorting the first is the single most common way to be right about a top and still lose.",
  });
}

/* ------------------------------------------------------------------ */
/* 6 — Gate 3                                                          */
/* ------------------------------------------------------------------ */

doc.heading(`Gate 3 — ${GATE_LABEL[GATE_ORDER[2]]}`);

doc.body(
  `The bar must post a higher high than the previous ${TRAP_LOOKBACK} bars and be rejected from it, with the ` +
    `UPPER wick taking at least ${R.wickPct}% of the bar's total high-to-low range. Both halves, on the same ` +
    "bar. This is the failed breakout itself - the gate the whole model is named after.",
);

doc.code([
  "range      =  high - low",
  "upper wick =  high - max(open, close)",
  "wick %     =  upper wick / range x 100",
  "",
  `pass       =  new ${TRAP_LOOKBACK}-bar high  AND  wick % >= ${R.wickPct}`,
]);

doc.body(
  "The ratio is measured against the bar's range rather than its body so it reads the same on a volatile " +
    `contract and a quiet one. At ${R.wickPct}% the rejection has taken back the clear majority of the bar's ` +
    "own extension — the market went there and refused to stay.",
);

figSub("Three bars at a new high", 320);

{
  const lead = drift(1.482, 9, { step: 0.0024, wick: 0.0018, bias: 0.04, seed: 63 });
  const body: OHLC[] = series([
    [1.498, 1.545, 1.496, 1.542],
    [1.542, 1.556, 1.520, 1.524],
    [1.524, 1.566, 1.522, 1.529],
  ]);
  const candles = [...lead, ...body];
  const strongIdx = lead.length;
  const midIdx = lead.length + 1;
  const trapIdx = lead.length + 2;

  chart(doc, {
    tag: "GATE 3 - WICK RATIO",
    headline: `The ${R.wickPct}% floor, and what falls short of it`,
    candles,
    height: 176,
    decimals: 3,
    spans: [
      { i: trapIdx, from: 1.529, to: 1.566, text: "78%", dx: 14, color: C.amber },
      { i: midIdx, from: 1.524, to: 1.556, text: "39%", dx: -20, color: C.neutral },
    ],
    notes: [
      {
        i: strongIdx,
        price: 1.545,
        text: "New high, closed on its high. Continuation — no wick, no trap.",
        dx: -12,
        dy: -34,
        color: C.up,
        maxWidth: 118,
      },
      {
        i: trapIdx,
        price: 1.566,
        text: "New high, 78% of the bar given straight back. Gate 3 passes.",
        dx: -16,
        dy: 20,
        ring: { rx: 4, ry: 3.6 },
        color: C.amber,
        maxWidth: 122,
      },
    ],
    caption:
      "All three bars made a new high. The first closed strong, the second gave back 39% and misses the " +
      `${R.wickPct}% floor, and only the third is a rejection. A new high alone tells you nothing about ` +
      "direction; what the bar does with it tells you everything.",
  });
}

doc.callout(
  "The floor is a floor",
  [
    `${R.wickPct}% is the specification minimum and the settings dialog will not accept a lower value. ` +
      "Raising it produces fewer and more violent signals; there is no way to loosen it.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 7 — Gate 4                                                          */
/* ------------------------------------------------------------------ */

doc.heading(`Gate 4 — ${GATE_LABEL[GATE_ORDER[3]]}`);

doc.body(
  `The bar's high must also come within ${R.depletionPct}% of the ${R.horizonDays}-day high. This is ` +
    "the gate that separates a local high from the edge of the map.",
);

doc.body(
  "A 24-hour high with a year of price action above it has resting liquidity overhead: old orders, unfilled " +
    "interest, levels people remember. Price can expand into that. A 24-hour high that is also a yearly high " +
    "has nothing above it at all. There is no reference price, no resting depth, and no natural buyer — the " +
    "only bid left is the one chasing.",
);

doc.body(
  `This is a band, and both sides of it fail. Too far below the horizon high and there is still liquidity ` +
    `to expand into. But price that has run well ABOVE that high also fails, and deliberately so: the level ` +
    `was swept long ago, and the contract is in open-sky price discovery with nothing resting overhead left ` +
    `to exhaust. That is the opposite of a spent move, however violent it looks on the chart. The gate tests ` +
    `the distance to the level, not the direction — so only price sitting ON the horizon high can pass.`,
);

doc.body(
  `The horizon high is built from completed daily bars only. If today's own bar could set the level it is ` +
    `measured against, every fresh breakout would sit exactly at its own yearly high and pass a gate that is ` +
    `supposed to mean "there is nothing left above" — the gate would confirm hardest precisely when its ` +
    `premise was most false.`,
);

doc.callout(
  "Why this gate is the one that makes the model rare",
  [
    "Gates 1 to 3 can all align several times a week on an active contract. Gate 4 usually cannot, because " +
      "an instrument spends most of its life somewhere in the middle of its yearly range.",
    "That is intentional. The gate is what turns a common intraday pattern into an uncommon one, and the " +
      "uncommon version is the one with an edge.",
  ],
  GREEN,
);

figSub("Same pattern, different place on the map", 300);

{
  const lead = drift(70.4, 10, { step: 0.002, wick: 0.0015, bias: 0.05, seed: 88 });
  const body: OHLC[] = series([
    [72.0, 73.2, 71.9, 73.0],
    [73.0, 75.8, 72.9, 73.4],
    [73.4, 73.6, 72.0, 72.2],
  ]);
  const candles = [...lead, ...body];
  const trapIdx = lead.length + 1;

  chart(doc, {
    tag: "GATE 4 - THE HORIZON",
    headline: "A textbook rejection that the model refuses",
    candles,
    height: 176,
    decimals: 2,
    scale: { max: 83 },
    lines: [
      { price: 75.7, label: "24h high", color: C.down },
      { price: 81.5, label: "1y high", color: C.violet },
    ],
    zones: [{ from: 75.7, to: 81.5, label: "resting liquidity above", color: C.violet, opacity: 0.1 }],
    notes: [
      {
        i: trapIdx,
        price: 75.8,
        text: "Gates 1, 2 and 3 all pass on this bar.",
        dx: -14,
        dy: 14,
        ring: { rx: 4.5, ry: 4 },
        color: C.amber,
        maxWidth: 108,
      },
      {
        i: Math.floor(candles.length * 0.36),
        price: 79.2,
        text: "7.6% of room to the yearly high. Gate 4 fails — no signal.",
        dx: 4,
        dy: 0,
        bare: true,
        color: C.violet,
        maxWidth: 126,
      },
    ],
    legend: [
      { label: "24h high", color: C.down },
      { label: "1-year high", color: C.violet },
    ],
    caption:
      "Three of four gates, and the indicator draws only a small triangle. The shaded band is the reason: " +
      "there is a year of resting liquidity overhead for price to expand into, so the sweep has somewhere " +
      "to go and the short has no floor under it.",
  });
}

/* ------------------------------------------------------------------ */
/* 8 — Trading the signal                                              */
/* ------------------------------------------------------------------ */

doc.heading("Trading the signal");

doc.body(
  "The signal marks a bar, not a price. What follows is the procedure the model is built around. It is a " +
    "starting framework, not advice, and every number in it should be tested against your own results.",
);

doc.steps([
  {
    title: "Wait for the signal bar to close",
    text:
      "With Confirm on bar close enabled — the default — the mark only appears on a closed bar and can never " +
      "be repainted away. A wick that exists mid-bar frequently fills back in before the close.",
  },
  {
    title: "Enter on the close, or on a retest of the body",
    text:
      "Entering at the close is simpler and catches more moves. Waiting for a retrace into the signal bar's " +
      "body gives a better price and misses the fastest ones. Neither is strictly better.",
  },
  {
    title: "Place the stop above the wick",
    text:
      "Above the signal bar's high, plus a small buffer for noise. That high is the whole premise: if price " +
      "trades back through it, the sweep was real demand and the setup is void.",
  },
  {
    title: "Take the first target inside the range",
    text:
      "The low of the signal bar, or the 24h midpoint, whichever comes first. Exhaustion trades revert " +
      "toward the middle of the range they were ejected from.",
  },
  {
    title: "Trail the remainder, or leave",
    text:
      "If the move extends past the first target, a trailing stop above each subsequent bar's high keeps " +
      "you in the occasional large reversal without giving back the whole move.",
  },
]);

doc.callout(
  "Position size before direction",
  [
    "The stop on this setup sits beyond a deliberately long wick, so it is wider than it looks. Size the " +
      "position from the stop distance, never from conviction.",
    "A setup with every gate open and a stop too far away to size properly is not a better trade. It is a " +
      "trade you cannot take.",
  ],
  RED,
);

figSub("The trade, laid out", 300);

{
  const lead = drift(2412, 9, { step: 0.0018, wick: 0.0013, bias: 0.05, seed: 31 });
  const body: OHLC[] = series([
    [2455, 2470, 2452, 2468],
    [2468, 2524, 2466, 2474],
    [2474, 2478, 2448, 2452],
    [2452, 2456, 2428, 2432],
    [2432, 2438, 2414, 2418],
  ]);
  const candles = [...lead, ...body];
  const trapIdx = lead.length + 1;

  chart(doc, {
    tag: "TRADE STRUCTURE",
    headline: "Entry, invalidation and first target",
    candles,
    height: 186,
    decimals: 0,
    lines: [
      { price: 2530, label: "stop", color: C.down },
      { price: 2474, label: "entry (close)", color: C.amber },
      { price: 2424, label: "target - 24h midpoint", color: C.up },
    ],
    bands: [{ i: trapIdx, color: C.amber, opacity: 0.1 }],
    spans: [
      { i: trapIdx + 1, from: 2474, to: 2530, text: "risk", dx: 16, color: C.down },
      { i: trapIdx + 2, from: 2474, to: 2424, text: "first target", dx: 16, color: C.up },
    ],
    notes: [
      {
        i: trapIdx,
        price: 2524,
        text: "Signal bar. Stop sits just beyond its high — above it, the sweep was real.",
        dx: -14,
        dy: 16,
        color: C.down,
        maxWidth: 128,
      },
    ],
    caption:
      "Risk is defined by the bar itself, not by a fixed percentage. The first target is the 24h midpoint, " +
      "where exhaustion moves most often stall.",
  });
}

/* ------------------------------------------------------------------ */
/* 9 — Alerts                                                          */
/* ------------------------------------------------------------------ */

doc.heading("Alerts");

doc.body(
  "The script exposes one alert condition and one dynamic message. Use the alert condition for phone " +
    "notifications and the dynamic message for webhooks, where the numbers matter. There is a single " +
    "condition because there is a single direction.",
);

doc.defs(
  [
    ["Exhaustion SHORT", "Fires when all four gates pass at the 24h high. The only condition the script exposes."],
  ],
  132,
);

doc.steps([
  {
    title: "Open the alert dialog",
    text: "Right-click the chart and choose Add alert, or press the alarm clock icon in the toolbar.",
  },
  {
    title: "Set the condition to the indicator",
    text: 'In Condition, choose "Nova Exhaustion Trap", then pick Exhaustion SHORT.',
  },
  {
    title: "Set the trigger to Once Per Bar Close",
    text:
      "This matters. Any other setting can fire on an intrabar wick that later fills in, producing an alert " +
      "for a signal the chart does not show.",
  },
  {
    title: "Add a webhook if you want the measurements",
    text:
      "The script also fires a dynamic message carrying the symbol, price, the swept 24h high, the RVOL " +
      "reading and the wick percentage, so a receiving system gets the numbers rather than just a name.",
  },
]);

doc.callout(
  "One alert per event, not per bar",
  [
    "A cooldown of 20 bars applies by default. Without it a genuine exhaustion event can satisfy the gates " +
      "on several consecutive bars and alert on each one.",
    "Raise it if you trade a fast timeframe and want one notification per event; lower it if you want to see " +
      "every qualifying bar.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 10 — Settings and limits                                            */
/* ------------------------------------------------------------------ */

doc.heading("Settings, limits and honest caveats");

doc.sub("Every setting, and what moving it does");

doc.table(
  [
    { header: "Setting", width: 150 },
    { header: "Default", width: 62, mono: true, align: "right" },
    { header: "Effect of raising it", width: CONTENT_W - 212 },
  ],
  [
    ["Reach (bps)", String(R.pinBps), "Accepts bars further below the 24h high. More signals, weaker premise."],
    ["Volume climax (%)", String(R.rvolClimax), "Demands a larger spike. Fewer, more violent signals."],
    ["Rejection wick (%)", String(R.wickPct), "Demands a deeper rejection. Cannot go below 45."],
    ["Depletion band (%)", String(R.depletionPct), "Widens the band on both sides of the horizon high."],
    ["Liquidity horizon (d)", String(R.horizonDays), "Longer memory. A 1-year high is rarer than a 90-day one."],
    ["RVOL baseline (bars)", String(RVOL_LOOKBACK), "Slower volume average. Less reactive to a changing regime."],
    ["Trap lookback (bars)", String(TRAP_LOOKBACK), "Requires a larger extension to count as a higher high."],
    ["Cooldown (bars)", "20", "Longer silence after a signal."],
  ],
);

doc.sub("Limits worth knowing before you rely on it");

doc.bullets([
  "The 24-hour window is counted in bars, so it assumes a continuously traded instrument. On an instrument " +
    "with session gaps the window covers 24 hours of trading, not 24 hours of wall-clock time.",
  "Volume must be available and meaningful. On instruments where the feed reports tick count rather than " +
    "true traded size, gate 2 measures something subtly different.",
  `The long-horizon high comes from completed daily bars, so today's own high cannot define the ${R.horizonDays}-day ` +
    "high. This is what stops the gate looking into the future on historical bars.",
  "Signals are evaluated on closed bars. With Confirm on bar close disabled, a mark can appear and then " +
    "disappear as the forming bar changes — a real property of intrabar evaluation, not a defect.",
  "Backtested behaviour on historical bars is not a forecast. The gates are descriptive, and the sample of " +
    "four-gate events on any single instrument is small by design.",
]);

doc.callout(
  "What this indicator does not do",
  [
    "It does not size positions, manage risk, or know your account. It marks a bar where four conditions " +
      "were true at once.",
    "It has no opinion on trend, no opinion on macro, and no memory of whether the last signal worked. Every " +
      "bar is judged on its own evidence.",
    "It does not find long entries. It is a bull trap detector and marks shorts only, by design.",
  ],
  RED,
);

doc.sub(`Gate reference — ${GATE_ORDER.length} gates, in order`);
doc.table(
  [
    { header: "#", width: 24, mono: true },
    { header: "Gate", width: 150 },
    { header: "Passes when", width: CONTENT_W - 174 },
  ],
  [
    ["1", GATE_LABEL[GATE_ORDER[0]], `bar's HIGH within ${R.pinBps} bps of the prior 24h high`],
    ["2", GATE_LABEL[GATE_ORDER[1]], `RVOL >= ${R.rvolClimax}% and at or below the previous bar`],
    ["3", GATE_LABEL[GATE_ORDER[2]], `new ${TRAP_LOOKBACK}-bar HIGH with an upper wick >= ${R.wickPct}% of range`],
    ["4", GATE_LABEL[GATE_ORDER[3]], `bar's HIGH within ${R.depletionPct}% of the ${R.horizonDays}-day high, above or below`],
  ],
);

doc.body(
  `The dashboard engine applies the same four gates to every tracked Binance USD-M perpetual at once — Bitcoin, ` +
    `plus altcoins priced strictly between $0.001 and $7.00 — scanning the ` +
    `newest ${TRAP_SCAN} bars for the rejection. The indicator applies them to the one chart in front of you. ` +
    "The thresholds are shared, so a contract armed in the dashboard will show the same gate states here.",
);

/* ------------------------------------------------------------------ */
/* Finish                                                              */
/* ------------------------------------------------------------------ */

doc.renderToc(tocPage, tocY);
doc.finish(`NOVA EXHAUSTION TRAP - PINE SCRIPT v6 - ${VERSION}`);

const bytes = await doc.save();
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, bytes);

// Prove the Pine source the manual documents is actually shipped beside it.
const pine = await readFile(PINE, "utf8");
const pineLines = pine.split("\n").length;

console.log(
  `${path.relative(process.cwd(), OUT)}  ${doc.pageNumber} pages  ${figureCount()} figures  ` +
    `${bytes.length.toLocaleString("en-US")} bytes`,
);
console.log(`${path.relative(process.cwd(), PINE)}  ${pineLines} lines  v6: ${pine.includes("//@version=6")}`);
console.log(`sanity: ${sanitize("-> >= x")}`);
