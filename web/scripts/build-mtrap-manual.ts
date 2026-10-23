/**
 * Builds `public/nova-mtrap-manual-sq.pdf` — the Albanian-language user manual
 * for the Nova Monthly Trap TradingView indicator (v1.2).
 *
 * Every chart figure is drawn from real Binance history: the trades behind the
 * numbers quoted in the Pine header, exported by the research harness into
 * `scripts/data/mtrap-figures.json`. Nothing in the figures is synthetic.
 *
 *   bun run scripts/build-mtrap-manual.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rgb, type RGB } from "pdf-lib";

import { C, chart, figureCount, type ChartBand, type ChartZone, type OHLC } from "./chart-kit";
import { AMBER, CONTENT_W, DARK, Doc, GREEN, MARGIN, PAGE, PAPER, RED, sanitize } from "./pdf-kit";

const VERSION = "v1.2";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(ROOT, "../public/nova-mtrap-manual-sq.pdf");
const PINE = path.resolve(ROOT, "../public/nova-monthly-trap.pine");
const DATA = path.resolve(ROOT, "./data/mtrap-figures.json");

/* ------------------------------------------------------------------ */
/* Figure data (real history)                                          */
/* ------------------------------------------------------------------ */

interface FigTrade {
  entry: number;
  stop: number;
  target: number;
  R: number;
  how: string;
  lvl: number;
  lvlType: string;
  wick: number;
  rv: number;
  tier: number;
  pocPx: number;
  pocShare: number;
  pocBuy: number;
  nz: number;
  prev: boolean;
}

interface FigProfile {
  lo: number;
  step: number;
  vol: number[];
  buy?: number[];
  poc: number;
  poc_px?: number;
  /** `[low, high, volume, bought]` per cluster. */
  zones: number[][];
}

interface FigWindow {
  sym: string;
  trapDate: string;
  trapIdx: number;
  dates: string[];
  /** `[open, high, low, close]` */
  candles: number[][];
  volumes: number[];
  pmHigh: number;
  pmLow: number;
  monthStartIdx: number[];
  supply: number[][];
  demand: number[][];
  atr: number;
  prior12Low: number;
  prior12High: number;
  volBase: number;
  trade: FigTrade;
  exit: { idx: number; px: number; how: string };
  proof?: { beyond: number; recov: number };
  /** `[open, high, low, close, volume]` per intrabar of the trap day. */
  h1?: number[][];
  h1prev?: number[][];
  profile?: FigProfile;
  profilePrev?: FigProfile | null;
  zoneBorn?: string;
  zone?: number[];
  confirmIdx?: number;
  entryIdx?: number;
}

interface RegimeWindow {
  dates: string[];
  candles: number[][];
  sma200: (number | null)[];
  rising: boolean[];
  below: boolean[];
}

interface FigData {
  "XLMUSDT_2024-07-05": FigWindow;
  "XRPUSDT_2024-07-05": FigWindow;
  "ETHUSDT_2025-04-07": FigWindow;
  "BTCUSDT_2024-08-05": FigWindow;
  "XTZUSDT_2025-04-07": FigWindow;
  "DOTUSDT_2022-02-24": FigWindow;
  "DASHUSDT_2022-01-07": FigWindow;
  SHORT: FigWindow;
  BTC_regime: RegimeWindow;
  btcDist: Record<string, { close: number; sma: number; pct: number; rising: boolean }>;
}

const data = JSON.parse(await readFile(DATA, "utf8")) as FigData;

const MONTHS_SQ = ["Jan", "Shk", "Mar", "Pri", "Maj", "Qer", "Kor", "Gush", "Sht", "Tet", "Nën", "Dhj"];

/** `2024-07-05` -> `5 Kor`. */
function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS_SQ[Number(m) - 1] ?? m}`;
}

/** `2024-07-05` -> `5 korrik 2024`. */
function dateLong(iso: string): string {
  const names = [
    "janar",
    "shkurt",
    "mars",
    "prill",
    "maj",
    "qershor",
    "korrik",
    "gusht",
    "shtator",
    "tetor",
    "nëntor",
    "dhjetor",
  ];
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${names[Number(m) - 1] ?? m} ${y}`;
}

function ohlc(rows: number[][]): OHLC[] {
  return rows.map(([o, h, l, c]) => [o, h, l, c] as OHLC);
}

/** Slices a daily window to `[trap - before, trap + after]` and returns re-based indices. */
function slice(w: FigWindow, before: number, after: number) {
  const from = Math.max(0, w.trapIdx - before);
  const to = Math.min(w.candles.length, w.trapIdx + after + 1);
  return {
    candles: ohlc(w.candles.slice(from, to)),
    volumes: w.volumes.slice(from, to),
    dates: w.dates.slice(from, to),
    trap: w.trapIdx - from,
    rebase: (i: number): number => i - from,
  };
}

function axisEvery(dates: string[], every: number, offset = 0): { i: number; label: string }[] {
  const out: { i: number; label: string }[] = [];
  for (let i = offset; i < dates.length; i += every) out.push({ i, label: dayLabel(dates[i]) });
  return out;
}

function fmt(n: number, dp: number): string {
  return n.toFixed(dp);
}

function pct(n: number, dp = 0): string {
  return `${n.toFixed(dp)}%`;
}

function rr(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

/** Bins for the chart kit from a stored profile: `[bin centre, volume]`. */
function profileBins(p: FigProfile): { bins: [number, number][]; poc: number } {
  const bins: [number, number][] = p.vol.map((v, k) => [p.lo + (k + 0.5) * p.step, v]);
  return { bins, poc: p.lo + (p.poc + 0.5) * p.step };
}

function clusterColor(z: number[]): RGB {
  const buy = z[2] > 0 ? (z[3] / z[2]) * 100 : 50;
  return buy >= 55 ? C.up : buy <= 45 ? C.down : C.neutral;
}

/**
 * Cluster bands for a stored profile. Only one band carries a label, and it is
 * the first cluster that does not hold the POC, so the label never sits on top
 * of the POC line's own chip.
 */
function clusterZones(p: FigProfile, dayVol: number, labelFirst: string): ChartZone[] {
  const pocPx = p.lo + (p.poc + 0.5) * p.step;
  const free = p.zones.findIndex((z) => !(z[0] <= pocPx && pocPx <= z[1]));
  const labelled = free >= 0 ? free : 0;
  return p.zones.map((z, k) => ({
    from: z[0],
    to: z[1],
    color: clusterColor(z),
    opacity: 0.2,
    label: k === labelled ? `${labelFirst} · ${pct((z[2] / dayVol) * 100)} e ditës` : undefined,
  }));
}

function runs(flags: boolean[]): { i: number; j: number }[] {
  const out: { i: number; j: number }[] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) {
      out.push({ i: start, j: i - 1 });
      start = -1;
    }
  });
  if (start >= 0) out.push({ i: start, j: flags.length - 1 });
  return out;
}

const doc = await Doc.create();

/** Sub-heading that refuses to be orphaned above a figure that will not fit. */
function figSub(title: string, need = 330): void {
  doc.need(need);
  doc.sub(title);
}

/* ------------------------------------------------------------------ */
/* Kopertina                                                           */
/* ------------------------------------------------------------------ */

{
  const page = doc.current;
  page.drawRectangle({ x: 0, y: PAGE.h - 250, width: PAGE.w, height: 250, color: DARK });
  page.drawRectangle({ x: MARGIN.x, y: PAGE.h - 250, width: 3, height: 250, color: AMBER });

  page.drawText("NOVA", { x: MARGIN.x + 22, y: PAGE.h - 108, size: 40, font: doc.fonts.sansBold, color: PAPER });
  page.drawText("MONTHLY TRAP", { x: MARGIN.x + 22, y: PAGE.h - 146, size: 22, font: doc.fonts.sansBold, color: AMBER });
  page.drawText(sanitize("INDIKATOR PËR TRADINGVIEW  -  MANUALI I PËRDORUESIT"), {
    x: MARGIN.x + 22,
    y: PAGE.h - 176,
    size: 9,
    font: doc.fonts.mono,
    color: rgb(0.62, 0.66, 0.72),
  });
  page.drawText(sanitize(`PINE SCRIPT v6  -  ${VERSION.toUpperCase()}  -  NË GJUHËN SHQIPE`), {
    x: MARGIN.x + 22,
    y: PAGE.h - 206,
    size: 8,
    font: doc.fonts.monoBold,
    color: rgb(0.62, 0.66, 0.72),
  });

  doc.space(268);
  doc.body(
    "Ky indikator kërkon një gjë të vetme në grafikun ditor: kurthin te një nivel mujor. Çmimi thyen minimumin " +
      "e muajit të kaluar ose hyn në një zonë mujore kërkese, merr stopet që prehen poshtë saj dhe, në fund të ditës, " +
      "mbyllet përsëri sipër nivelit, me volum shumë mbi normalen. Kush shiti në atë fitil ka mbetur jashtë loje. " +
      "Kjo është tregtia. Për short, e njëjta gjë në pasqyrë, te maksimumi mujor.",
  );
  doc.body(
    "Një sinjal kërkon që të gjitha portat të jenë të hapura në të njëjtin qiri ditor: regjimi i tregut, niveli, " +
      "fshirja e stopeve, fitili i refuzimit, kulmi i volumit dhe prova nga qirinjtë e brendshëm të ditës. Katër " +
      "nga pesë nuk është sinjal, dhe indikatori nuk e vizaton. Versioni 1.2 shton profilin e volumit brenda ditës: " +
      "ku u grumbullua volumi i ditës dhe nëse fitili i kurthit e preku pikërisht atë grumbull.",
  );

  doc.space(6);
  doc.callout(
    "Shkurt",
    [
      "Long dhe short, vetëm në grafikun ditor (1D). Çdo sinjal vjen me stop, objektiv 2R dhe një regjistër të " +
        "rezultateve të tij në vetë grafikun.",
      "Çdo numër në këtë manual vjen nga i njëjti testim: 50 çifte USDT në Binance, qirinj ditorë 2017-2026 " +
        "(354 vite-monedhë), dalje te stopi, te objektivi ose pas 30 ditësh, pa komisione. E kaluara nuk është premtim.",
    ],
    AMBER,
  );

  doc.space(6);
  doc.callout("Çfarë përmban ky dokument", [
    "Seksionet 1-2   instalimi dhe ideja e kurthit mujor në një faqe.",
    "Seksionet 3-7   dera e regjimit, nivelet mujore dhe gjashtë portat, njëra pas tjetrës, me shifrat e testimit.",
    "Seksionet 8-9   sinjalet, plani i tregtimit, tabela e portave dhe alarmet.",
    "Seksionet 10-12 çfarë tregoi testimi, referenca e cilësimeve dhe kufizimet.",
    "Çdo vlerë e cituar është vlera e paracaktuar e skriptit dhe ndryshohet nga dritarja e cilësimeve.",
  ]);

  doc.space(4);
  doc.sub("Përmbajtja");
  doc.rule();
}

const tocPage = doc.current;
const tocY = doc.cursor - 4;
doc.newPage();

/* ------------------------------------------------------------------ */
/* 1 — Instalimi                                                       */
/* ------------------------------------------------------------------ */

doc.heading("Instalimi i indikatorit", { newPage: false });

doc.body(
  "Indikatori vjen si një skedar i vetëm Pine Script v6. TradingView nuk ka instalues: skripti ngjitet në Pine " +
    "Editor dhe ruhet në llogarinë tuaj, pas kësaj sillet si çdo indikator tjetër. Emri i skedarit është " +
    "nova-monthly-trap.pine; mund ta hapni me çdo editor teksti.",
);

doc.steps([
  {
    title: "Shkarkoni skriptin nga paneli Nova",
    text:
      "Hapni modulin Wick, kartën “TradingView indicators”, dhe te “Monthly Trap” shtypni “Download Pine Script”. " +
      "Versioni shkruhet pranë emrit; ky manual përshkruan v1.2.",
  },
  {
    title: "Hapni Pine Editor në TradingView",
    text: "Në çdo grafik, shtypni “Pine Editor” në shiritin e poshtëm të ekranit. Fshini tekstin shembull që shfaqet aty.",
  },
  {
    title: "Ngjitni gjithë tekstin e skedarit dhe ruajeni",
    text:
      "Kopjoni skedarin nga rreshti i parë deri te i fundit dhe ngjiteni në editor. Shtypni “Save” dhe jepini një " +
      "emër, p.sh. “Nova Monthly Trap”. Nëse editori raporton gabim, teksti nuk është ngjitur i plotë: përsëriteni.",
  },
  {
    title: "Shtojeni në grafik dhe kaloni në 1D",
    text:
      "Shtypni “Add to chart”. Indikatori është ndërtuar dhe testuar vetëm për qirinjtë ditorë; në çdo kohë " +
      "tjetër tabela e tij shfaq “Switch to the 1D chart” dhe nuk vizaton asgjë.",
  },
  {
    title: "Lërini cilësimet e paracaktuara",
    text:
      "Dritarja e cilësimeve hapet nga ingranazhi pranë emrit të indikatorit. Vlerat e paracaktuara janë pikërisht " +
      "ato që u testuan. Ndryshoni vetëm kur e dini çfarë ndryshoni; seksioni 11 shpjegon çdo cilësim.",
  },
]);

doc.callout(
  "Buxheti i qirinjve të brendshëm",
  [
    "Prova e fitilit dhe profili i volumit lexojnë qirinjtë 1-orësh brenda çdo qiriri ditor. TradingView lejon " +
      "një numër të caktuar qirinjsh të tillë për grafik: 100.000 në shumicën e planeve, 125.000 në planin Expert, " +
      "200.000 në Ultimate. Me qirinj 1-orësh kjo mbulon rreth 4.000 ditë, pra gjithë historinë e shumicës së " +
      "çifteve kripto.",
    "Qirinjtë më të vjetër se buxheti nuk kanë provë dhe, me cilësimet e paracaktuara, nuk japin sinjal. Tabela " +
      "tregon “Intrabars available since ...” që nga cila datë ka prova. Me 2h ose 4h mbulohet dyfishi ose " +
      "katërfishi i historisë, me të njëjtin rezultat në testim.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 2 — Ideja                                                           */
/* ------------------------------------------------------------------ */

doc.heading("Kurthi mujor në një faqe");

doc.body(
  "Çdo muaj lë pas dy nivele që i sheh gjithë tregu: maksimumin dhe minimumin e tij. Poshtë minimumit mujor prehen " +
    "stopet e atyre që blenë gjatë muajit; sipër maksimumit, stopet e atyre që shitën. Kur çmimi i thyen këto nivele " +
    "për pak orë, i merr ato stope dhe pastaj kthehet brenda, lëvizja ishte kurth: likuiditeti u mor, blerësit e " +
    "vërtetë hynë në fitil dhe ata që u ndalën nuk kanë më pozicion për ta mbrojtur.",
);
doc.body(
  "Indikatori nuk parashikon asgjë. Ai numëron. Në të njëjtin qiri ditor duhet të jenë të vërteta njëkohësisht: " +
    "Bitcoin në regjimin e duhur (dera), fitili arrin një nivel mujor dhe qiriri mbyllet përsëri në anën e kurthit " +
    "(porta 1), fitili thyen edhe minimumin e 12 ditëve të mëparshme (porta 2), fitili i refuzimit është të paktën " +
    "45% e gjithë lëvizjes së ditës (porta 3), volumi është të paktën 2.5 herë mesatarja (porta 4) dhe qirinjtë " +
    "1-orësh provojnë se volumi u tregtua përtej nivelit dhe se kthimi pati pjesëmarrje (porta 5). Profili i volumit " +
    "(porta 6) e etiketon sinjalin dhe, po të doni, bëhet edhe ai portë.",
);

{
  const w = data["XLMUSDT_2024-07-05"];
  const s = slice(w, 18, 12);
  const t = w.trade;
  const exitI = s.trap + w.exit.idx;
  chart(doc, {
    tag: `${w.sym} - 1D - UTC`,
    headline: `Kurthi i plotë: ${w.sym}, ${dateLong(w.trapDate)}`,
    candles: s.candles,
    volumes: s.volumes,
    height: 166,
    decimals: 4,
    lines: [
      { price: w.pmLow, label: "Min. i muajit të kaluar", color: C.up },
      { price: t.stop, label: "Stop", color: C.down },
      { price: t.target, label: "Objektivi 2R", color: C.cyan },
    ],
    bands: [
      { i: s.trap, label: "qiriri i kurthit", color: C.up, opacity: 0.12 },
      { i: exitI, label: "objektivi", color: C.cyan, opacity: 0.1 },
    ],
    spans: [{ i: s.trap, from: s.candles[s.trap][2], to: Math.min(s.candles[s.trap][0], s.candles[s.trap][3]), text: `fitili ${pct(t.wick)} e gamës`, dx: 15, color: C.amber }],
    notes: [
      {
        i: s.trap,
        price: s.candles[s.trap][2],
        text: `Fitili thyen minimumin e qershorit (${fmt(w.pmLow, 4)}) dhe minimumin e 12 ditëve, me ${(t.rv / 100).toFixed(1)}x volumin normal. Mbyllja ${fmt(t.entry, 4)}: përsëri sipër nivelit.`,
        dx: -16,
        dy: -4,
        ring: { rx: 5, ry: 6 },
        color: C.up,
        maxWidth: 150,
      },
      {
        i: exitI,
        price: t.target,
        text: `Objektivi 2R (${fmt(t.target, 4)}) arrihet pas ${w.exit.idx} ditësh.`,
        dx: -14,
        dy: 22,
        color: C.cyan,
        maxWidth: 110,
      },
    ],
    axis: axisEvery(s.dates, 7, 3),
    legend: [
      { label: "nivel mujor", color: C.up },
      { label: "stop", color: C.down },
      { label: "objektiv", color: C.cyan },
    ],
    caption:
      `Hapja ${fmt(s.candles[s.trap][0], 4)}, minimumi ${fmt(s.candles[s.trap][2], 4)} poshtë minimumit të qershorit (${fmt(w.pmLow, 4)}), ` +
      `mbyllja ${fmt(t.entry, 4)} sipër nivelit. Fitili ${pct(t.wick)} e gamës, volumi ${(t.rv / 100).toFixed(1)}x mesatarja 20-ditore. ` +
      `Stopi ${fmt(t.stop, 4)}, objektivi ${fmt(t.target, 4)} pas ${w.exit.idx} ditësh. Bitcoin atë ditë ${data.btcDist[w.trapDate].pct.toFixed(1)}% ` +
      "nën mesataren e tij 200-ditore në rritje: dera e hapur.",
  });
}

doc.sub("Fjalori i shkurtër");
doc.defs(
  [
    ["KURTH (TRAP)", "Thyerje e një niveli që dështon brenda të njëjtit qiri: çmimi kalon nivelin dhe mbyllet përsëri në anën e mëparshme."],
    ["FITIL (WICK)", "Hija e qiririt: pjesa e lëvizjes së ditës jashtë trupit hapje-mbyllje. Fitili i refuzimit është ai në anën e kurthit."],
    ["FSHIRJE (SWEEP)", "Marrja e stopeve: minimumi i ditës bie nën minimumin e 12 ditëve të mëparshme (ose maksimumi mbi maksimumin)."],
    ["ATR", "Average True Range, lëvizja mesatare ditore e 14 ditëve. Njësia me të cilën maten toleranca e nivelit, thellësia e zonave dhe stopi."],
    ["R", "Njësia e rrezikut: distanca nga hyrja te stopi. Një tregti që fiton dyfishin e asaj distance ka bërë +2R; stopi është -1R."],
    ["POC", "Point of Control, pika e kontrollit: çmimi ku u tregtua volumi më i madh i ditës."],
    ["GRUMBULL (HVN)", "High Volume Node: shirita çmimi ngjitur me volum të lartë, afër atij të POC-it. Aty u bë tregtimi i vërtetë i ditës."],
    ["REGJIM", "Gjendja e tregut referencë (Bitcoin) kundrejt mesatares së tij 200-ditore. Dera para portave."],
    ["KONFLUENCË", "Përputhja e disa fakteve të pavarura në të njëjtin çmim: niveli mujor, fitili i kurthit dhe POC-i i ditës."],
  ],
  118,
);

/* ------------------------------------------------------------------ */
/* 3 — Regjimi                                                         */
/* ------------------------------------------------------------------ */

doc.heading("Porta 0: regjimi i tregut");

doc.body(
  "I njëjti kurth nuk vlen njësoj në çdo treg. Versioni 1.1 vendosi një derë para portave: gjendja e Bitcoin-it në " +
    "grafikun ditor. Sinjalet long merren vetëm kur Bitcoin tregtohet POSHTË mesatares së tij të thjeshtë 200-ditore " +
    "dhe ajo mesatare është NË RRITJE (më e lartë se 20 ditë më parë). Me fjalë të tjera: një korrigjim brenda një " +
    "trendi rritës, pikërisht momenti kur shitjet e detyruara marrin stopet poshtë mbështetjeve mujore. Sinjalet " +
    "short merren vetëm kur Bitcoin është poshtë mesatares, me çfarëdo pjerrësie.",
);
doc.body(
  "Pse Bitcoin dhe jo vetë grafiku? Sepse gjithë tregu kripto korrigjon kur korrigjon Bitcoin, dhe në testim trendi " +
    "i Bitcoin-it dha +0.74R për tregti, kundrejt +0.28R për të njëjtin rregull mbi trendin e vetë çiftit. Rregulli " +
    "klasik, “bli vetëm sipër mesatares”, u testua gjithashtu: humbi para (-0.02R kundrejt Bitcoin-it, -0.16R kundrejt " +
    "mesatares së vetë grafikut). Kurthet mujore funksionojnë në korrigjime, jo në trende të pastra.",
);

{
  const r = data.BTC_regime;
  const from = r.dates.indexOf("2024-06-10");
  const to = r.dates.indexOf("2024-09-06") + 1;
  const dates = r.dates.slice(from, to);
  const candles = ohlc(r.candles.slice(from, to));
  const sma = r.sma200.slice(from, to);
  const open = r.below.slice(from, to).map((b, i) => b && r.rising[from + i]);
  const bands: ChartBand[] = runs(open).map((run, k) => ({
    i: run.i,
    j: run.j,
    color: C.up,
    opacity: 0.08,
    label: k === 0 ? "dera e hapur për long" : undefined,
  }));
  const i0705 = dates.indexOf("2024-07-05");
  const i0805 = dates.indexOf("2024-08-05");
  const axis = dates
    .map((d, i) => ({ i, d }))
    .filter(({ d }) => d.endsWith("-01") || d.endsWith("-15"))
    .map(({ i, d }) => ({ i, label: dayLabel(d) }));
  chart(doc, {
    tag: "BTCUSDT - 1D - mesatarja 200-ditore",
    headline: "Dera: Bitcoin poshtë mesatares së tij 200-ditore në rritje, verë 2024",
    candles,
    height: 180,
    decimals: 0,
    curves: [{ values: sma, label: "SMA 200", color: C.violet, thickness: 1.2 }],
    bands,
    notes: [
      {
        i: i0705,
        price: candles[i0705][2],
        text: `5 korrik: ${data.btcDist["2024-07-05"].pct.toFixed(1)}% nën mesataren, që rritet. 19 çifte japin kurth mujor të njëjtën ditë.`,
        dx: -14,
        dy: -18,
        ring: { rx: 5, ry: 7 },
        color: C.up,
        maxWidth: 128,
      },
      {
        i: i0805,
        price: candles[i0805][2],
        text: `5 gusht: ${data.btcDist["2024-08-05"].pct.toFixed(1)}% nën mesataren. Dita me më shumë sinjale në gjithë testimin: 22.`,
        dx: 14,
        dy: -10,
        ring: { rx: 5, ry: 9 },
        color: C.up,
        maxWidth: 124,
      },
    ],
    axis,
    legend: [
      { label: "mesatarja 200-ditore", color: C.violet },
      { label: "dera e hapur (poshtë mesatares në rritje)", color: C.up },
    ],
    caption:
      "Mesatarja 200-ditore e Bitcoin-it rritet gjithë verën e 2024-s ndërsa çmimi bie nën të dy herë: në korrik dhe në " +
      "gusht. Të dyja rëniet janë ditë kapitullimi në gjithë tregun, dhe pikërisht aty altcoin-et thyejnë minimumet e " +
      "tyre mujore dhe kthehen. Jashtë këtyre dritareve, kur Bitcoin është sipër mesatares, i njëjti kurth nuk dha para.",
  });
}

doc.sub("Opsionet e regjimit dhe çfarë dhanë në testim");
doc.table(
  [
    { header: "Ana", width: 46 },
    { header: "Kushti për referencën", width: 170 },
    { header: "Sinjale", width: 60, align: "right", mono: true },
    { header: "Mesatarja", width: 70, align: "right", mono: true },
    { header: "Shënim", width: CONTENT_W - 346 },
  ],
  [
    ["Long", "Poshtë mesatares në rritje", "100", "+0.74R", "paracaktuar; 70% pozitive, stop 16%"],
    ["Long", "Poshtë mesatares, çfarëdo pjerrësie", "153", "+0.46R", ""],
    ["Long", "Sipër mesatares (rregulli klasik)", "126", "-0.02R", "humbet; -0.16R me mesataren e vetë grafikut"],
    ["Long", "Pa regjim (v1.0)", "279", "+0.25R", "51% pozitive, stop 27%"],
    ["Short", "Poshtë mesatares", "19", "+0.66R", "paracaktuar; 74% pozitive"],
    ["Short", "Poshtë mesatares në rënie", "16", "+0.77R", ""],
    ["Short", "Sipër mesatares", "23", "+0.02R", ""],
  ],
);

doc.callout("Qëndrueshmëria e rregullit", [
  "Rregulli u mbajt në të dyja gjysmat e kampionit (+0.77R te 20 çiftet e para, +0.71R te 30 të tjerat), për çdo " +
    "gjatësi pjerrësie nga 5 deri në 60 ditë dhe për mesatare nga 150 deri në 250 ditë. Mesatarja 100-ditore nuk " +
    "funksionoi (+0.10R). 179 sinjalet long që dera i hoqi kishin mesatarisht -0.03R.",
  "Kur referenca nuk lexohet (simbol i gabuar, histori e pamjaftueshme) të dyja anët mbyllen dhe tabela shkruan " +
    "“Regime reference unavailable”. Rregulloni simbolin te cilësimet; mos e fikni derën.",
]);

/* ------------------------------------------------------------------ */
/* 4 — Nivelet                                                         */
/* ------------------------------------------------------------------ */

doc.heading("Nivelet mujore");

doc.body(
  "Nivelet vijnë vetëm nga muaj të mbyllur, prandaj asgjë nuk lëviz pasi është vizatuar dhe asnjë vlerë nuk mund " +
    "të vijë nga e ardhmja. Muajt ndërtohen nga vetë qirinjtë ditorë të grafikut: një muaj hyn në llogari vetëm kur " +
    "qiriri i tij i fundit është mbyllur.",
);

doc.defs(
  [
    ["MAKS./MIN. I MUAJIT TË KALUAR", "Dy vija shkallëzore, e kuqe sipër dhe jeshile poshtë. Nivelet kryesore të kurthit; ndryshojnë ditën e parë të çdo muaji."],
    ["ZONË KËRKESE MUJORE", "Një muaj minimumi i të cilit qëndron poshtë minimumeve të dy muajve para dhe dy muajve pas shënon kërkesë. Zona shkon nga ai minimum drejt trupit të qiririt mujor, jo më thellë se 1 ATR ditor."],
    ["ZONË OFERTE MUJORE", "Pasqyra: një maksimum mujor sipër maksimumeve të dy muajve në secilën anë. Zona shkon nga maksimumi drejt trupit."],
    ["JETA E ZONËS", "Një zonë qëndron e gjallë derisa një qiri ditor MBYLLET përmes saj; atëherë ose zhduket ose zbehet në gri (cilësimi “Keep mitigated zones”). Mbahen 10 zona për anë."],
    ["HAPJA E MUAJIT", "E fikur. Me të ndezur, testimi dha pak më shumë sinjale me mesatare pak më të ulët (+0.23R në vend të +0.25R në v1.0)."],
    ["TREMUJORI / VITI I KALUAR", "Vizatohen gjithmonë (vija të zbehta, viti më i trashë), por nuk janë burim kurthi. Një kurth mujor që bie mbi to etiketohet “stacked” (i mbivendosur) në tabelë dhe në alarm."],
  ],
  164,
);

{
  const w = data["ETHUSDT_2025-04-07"];
  const s = slice(w, 18, 31);
  const t = w.trade;
  const exitI = s.trap + w.exit.idx;
  const zone = w.zone ?? [1521, 1615.14];
  chart(doc, {
    tag: `${w.sym} - 1D - UTC`,
    headline: `Kurth në një zonë kërkese mujore: ${w.sym}, ${dateLong(w.trapDate)}`,
    candles: s.candles,
    volumes: s.volumes,
    height: 190,
    decimals: 0,
    zones: [{ from: zone[0], to: zone[1], label: `zonë kërkese mujore · ${w.zoneBorn ?? "tet 2023"}`, color: C.up, opacity: 0.16 }],
    lines: [
      { price: w.pmLow, label: "Min. i muajit të kaluar", color: C.up, bare: false },
      { price: t.stop, label: "Stop", color: C.down },
      { price: t.target, label: "Objektivi 2R", color: C.cyan },
    ],
    bands: [
      { i: s.trap, label: "kurthi", color: C.up, opacity: 0.12 },
      { i: exitI, label: "dita 30", color: C.neutral, opacity: 0.1 },
    ],
    notes: [
      {
        i: s.trap,
        price: s.candles[s.trap][2],
        text: `Minimumi ${fmt(s.candles[s.trap][2], 0)} hyn thellë në zonën ${fmt(zone[0], 0)}-${fmt(zone[1], 0)} (tetor 2023); mbyllja ${fmt(t.entry, 0)} sipër bazës së saj. Volumi ${(t.rv / 100).toFixed(1)}x.`,
        dx: -16,
        dy: -6,
        ring: { rx: 5, ry: 7 },
        color: C.up,
        maxWidth: 148,
      },
      {
        i: exitI,
        price: s.candles[exitI][3],
        text: `As stopi, as objektivi brenda 30 ditësh: mbyllet te ${fmt(w.exit.px, 0)}, ${rr(t.R)}.`,
        dx: -12,
        dy: 20,
        color: C.neutral,
        maxWidth: 118,
      },
    ],
    axis: axisEvery(s.dates, 10, 4),
    legend: [
      { label: "zonë kërkese", color: C.up },
      { label: "stop", color: C.down },
      { label: "objektiv", color: C.cyan },
    ],
    caption:
      `Zona ${fmt(zone[0], 0)}-${fmt(zone[1], 0)} lindi nga minimumi mujor i tetorit 2023 dhe qëndroi e gjallë 18 muaj, sepse ` +
      `asnjë qiri ditor nuk u mbyll nën ${fmt(zone[0], 0)}. Më ${dateLong(w.trapDate)}, ditën e tarifave, ETH ra te ` +
      `${fmt(s.candles[s.trap][2], 0)} dhe u mbyll te ${fmt(t.entry, 0)}. Niveli i kurthit është kulmi i zonës (${fmt(zone[1], 0)}): ` +
      `çmimi që fitili duhej ta kalonte. Stopi ${fmt(t.stop, 0)}, objektivi ${fmt(t.target, 0)}; tregtia u mbyll me kohë pas 30 ditësh me ${rr(t.R)}.`,
  });
}

doc.callout(
  "Tremujori dhe viti: pse vetëm etiketë",
  [
    "Si burime kurthi, nivelet e tremujorit dhe vitit të kaluar shtuan 32 sinjale long me +0.18R dhe 9 short me " +
      "-0.28R, dhe asnjëri prej tyre nuk kaloi derën dhe provën. Kurthet mujore që ranë mbi një nivel të tillë " +
      "dolën më keq, jo më mirë: +0.14R kundrejt +0.28R në v1.0, +0.63R kundrejt +0.77R brenda regjimit.",
    "Prandaj vizatohen për kontekst dhe shënohen “stacked”, por nuk janë kusht. Cilësimi “Previous quarter / year " +
      "high and low” i kthen në burim kurthi; testimi nuk e këshillon.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 5 — Portat 1–4                                                      */
/* ------------------------------------------------------------------ */

doc.heading("Portat 1 deri 4: kurthi në qiririn ditor");

doc.body(
  "Katër portat e para lexohen nga vetë qiriri ditor dhe janë të pandryshuara që nga v1.0. Të gjitha duhet të jenë " +
    "të hapura në të njëjtin qiri. Një qiri që kurth në të dy drejtimet njëkohësisht (long dhe short) nuk thotë asgjë " +
    "për drejtimin dhe nuk jep sinjal.",
);

doc.table(
  [
    { header: "#", width: 24, mono: true },
    { header: "Porta", width: 112 },
    { header: "Kalon kur (long; short në pasqyrë)", width: CONTENT_W - 136 - 100 },
    { header: "Paracaktimi", width: 100, mono: true },
  ],
  [
    ["1", "Niveli", "Minimumi i ditës arrin një nivel mujor (brenda tolerancës) dhe qiriri mbyllet përsëri SIPËR nivelit. Për zonat: fitili prek kulmin e zonës, mbyllja mbi bazën e saj.", "0.25 x ATR"],
    ["2", "Fshirja e stopeve", "Minimumi i ditës bie nën minimumin më të ulët të 12 ditëve të mëparshme: stopet poshtë nivelit janë marrë.", "12 ditë"],
    ["3", "Fitili i refuzimit", "Fitili i poshtëm është të paktën 45% e gjithë gamës së qiririt (maksimum minus minimum). 45% është dyshemeja; nuk ulet më poshtë.", ">= 45%"],
    ["4", "Kulmi i volumit", "Volumi i ditës është të paktën 250% e mesatares së 20 ditëve të mëparshme. Pa të dhëna volumi nuk ka sinjal.", ">= 250%"],
  ],
);

doc.body(
  "Porta e volumit mund të fiket vetëm me qëllim, për simbole pa të dhëna volumi (shumica e çifteve forex, disa " +
    "indekse). Atëherë sinjali kërkon një portë më pak dhe shifrat e testimit nuk vlejnë më. Në kripto lëreni ndezur.",
);

doc.sub("Çfarë matet saktësisht");
doc.code([
  "toleranca      = 0.25 x ATR(14)",
  "niveli (long)  = minimumi <= niveli + toleranca   DHE   mbyllja > niveli",
  "fshirja (long) = minimumi <  minimumi më i ulët i 12 ditëve të mëparshme",
  "fitili (long)  = (min(hapja, mbyllja) - minimumi) / (maksimumi - minimumi) >= 45%",
  "volumi         = volumi / mesatarja(volumi, 20 ditët e mëparshme) >= 250%",
]);

doc.body(
  "Për short, çdo rresht lexohet në pasqyrë: maksimumi arrin maksimumin mujor ose bazën e një zone oferte, mbyllja " +
    "nën nivel, maksimumi mbi maksimumin e 12 ditëve, fitili i sipërm të paktën 45%.",
);

/* ------------------------------------------------------------------ */
/* 6 — Prova e fitilit                                                 */
/* ------------------------------------------------------------------ */

doc.heading("Porta 5: prova e fitilit nga qirinjtë e brendshëm");

doc.body(
  "Qiriri ditor tregon se çmimi shkoi poshtë nivelit dhe u kthye. Nuk tregon KUR ndodhi kjo brenda ditës, as me sa " +
    "volum. Një fitil i gjatë mund të jetë një shpërthim shitjeje që u ble me forcë, ose një thyerje e shpejtë në " +
    "një orë të vetme pa volum, që pastaj u braktis. Prova e fitilit i ndan këto dy raste duke lexuar qirinjtë " +
    "1-orësh të ditës. Kërkohen dy shifra, të dyja:",
);

doc.code([
  "përtej = shuma(volumi i orës x pjesa e gamës POSHTË nivelit) / volumi i ditës   >= 10%",
  "pas    = volumi i orëve PAS ekstremit / volumi i orëve DERI te ekstremi        >= 50%",
]);

doc.bullets([
  "“Përtej” thotë se marrja e stopeve ishte e vërtetë: të paktën një e dhjeta e volumit të ditës u tregtua poshtë " +
    "nivelit mujor, jo një shtypje e vetme. Volumi i çdo ore ndahet në përpjesëtim me sa nga gama e saj ishte poshtë nivelit.",
  "“Pas” thotë se kthimi pati pjesëmarrje: orët pas minimumit të ditës mbartën të paktën gjysmën e volumit të orëve " +
    "deri te minimumi. Një fitil i shtypur në një spike dhe pastaj i braktisur dështon këtu.",
]);

{
  const w = data["XRPUSDT_2024-07-05"];
  const h = w.h1 ?? [];
  const candles: OHLC[] = h.map(([o, hi, lo, c]) => [o, hi, lo, c] as OHLC);
  const vols = h.map((r) => r[4]);
  const ext = h.reduce((best, r, i) => (r[2] < h[best][2] ? i : best), 0);
  const t = w.trade;
  const lvl = t.lvl;
  const dayLow = Math.min(...h.map((r) => r[2]));
  const body = Math.min(w.candles[w.trapIdx][0], w.candles[w.trapIdx][3]);
  chart(doc, {
    tag: `${w.sym} - 1h - ${dayLabel(w.trapDate)} 2024 UTC`,
    headline: `Prova e fitilit, orë pas ore: ${w.sym}, ${dateLong(w.trapDate)}`,
    candles,
    volumes: vols,
    height: 176,
    decimals: 4,
    zones: [{ from: dayLow, to: body, label: "fitili i qiririt ditor", color: C.amber, opacity: 0.07 }],
    lines: [{ price: lvl, label: "Niveli mujor (kulmi i zonës)", color: C.up, labelAt: 15 }],
    bands: [{ i: ext, color: C.down, opacity: 0.14 }],
    notes: [
      {
        i: ext,
        price: candles[ext][2],
        text: `Ora e minimumit (${String(ext).padStart(2, "0")}:00). Orët deri këtu: volumi “para”. Orët pas: ${pct(w.proof?.recov ?? 0)} e tij.`,
        dx: 16,
        dy: -2,
        ring: { rx: 5, ry: 7 },
        color: C.down,
        maxWidth: 126,
      },
      {
        i: 3,
        price: lvl,
        text: `Gjithë dita u tregtua poshtë nivelit ${fmt(lvl, 4)}: “përtej” = ${pct(w.proof?.beyond ?? 0)}.`,
        dx: 10,
        dy: 26,
        color: C.up,
        maxWidth: 120,
      },
    ],
    axis: [0, 6, 12, 18].map((i) => ({ i, label: `${String(i).padStart(2, "0")}:00` })),
    legend: [
      { label: "niveli mujor", color: C.up },
      { label: "ora e ekstremit", color: C.down },
      { label: "fitili ditor", color: C.amber },
    ],
    caption:
      `XRP hapi ditën tashmë nën kulmin e zonës mujore të kërkesës (${fmt(lvl, 4)}), ra te ${fmt(dayLow, 4)} në orën ` +
      `${String(ext).padStart(2, "0")}:00 dhe u ble gjithë pasditen: orët pas minimumit mbartën ${pct(w.proof?.recov ?? 0)} të volumit ` +
      `të orëve para tij. Të dyja shifrat shumë mbi pragjet 10% dhe 50%. Qiriri ditor u mbyll te ${fmt(t.entry, 4)}, ` +
      `sipër nivelit; objektivi 2R u arrit pas ${w.exit.idx} ditësh.`,
  });
}

doc.sub("Çfarë dha prova në testim");
doc.body(
  "Brenda regjimit, prova e çoi mesataren e sinjaleve long nga +0.74R në +0.92R dhe uli stopet nga 16% në 13% të " +
    "tregtive, me çmimin e 29 sinjaleve më pak (ato kishin mesatarisht +0.32R, pra prova heq edhe disa tregti " +
    "fituese). Leximi nga qirinj 2-orësh ose 4-orësh dha të njëjtin rezultat. Në short, prova hoqi po aq tregti të " +
    "mira sa të këqija (+0.42R me të, +0.66R pa të), prandaj është e fikur për short.",
);

doc.callout("Kur mungojnë qirinjtë e brendshëm", [
  "“Skip the signal” (paracaktuar): qiriri pa provë nuk jep sinjal. Grupi i sinjaleve mbetet saktësisht ai që u testua.",
  "“Pass without the proof”: qiriri kalon si sinjal i stilit v1.0 dhe tabela shfaq provën si “n/a”. Më shumë sinjale, " +
    "pa garancinë e testimit. E njëjta zgjedhje vlen edhe për profilin e volumit kur ai bëhet portë.",
]);

/* ------------------------------------------------------------------ */
/* 7 — Profili i volumit                                               */
/* ------------------------------------------------------------------ */

doc.heading("Porta 6: profili i volumit brenda ditës");

doc.body(
  "E reja e versionit 1.2. Profili i volumit i përgjigjet një pyetjeje që qiriri ditor nuk mund ta japë: në CILIN " +
    "çmim u tregtua më shumë gjatë ditës? Gama e ditës (maksimum minus minimum) ndahet në 24 shirita çmimi. Volumi i " +
    "çdo ore shpërndahet në shiritat që mbulon gama e saj, në përpjesëtim me mbivendosjen. Shiriti më i rëndë është " +
    "POC-i i ditës, pika e kontrollit. Shiritat që mbajnë të paktën 70% të volumit të POC-it janë nyje me volum të " +
    "lartë; kur janë ngjitur, bashkohen në një grumbull. Lexohet nga të njëjtët qirinj 1-orësh si prova e fitilit, " +
    "me një kërkesë të vetme të dhënash, prandaj buxheti i qirinjve të brendshëm nuk ndryshon.",
);

doc.sub("Çfarë vizatohet");
doc.defs(
  [
    ["HISTOGRAMI", "Djathtas qiririt të fundit, 12 shirita i gjerë. Çdo shirit është një nivel çmimi; gjatësia e tij, volumi që u tregtua aty. Shiritat e grumbujve më të theksuar, POC-i portokalli."],
    ["BANDAT E GRUMBUJVE", "Mbi qiririn e fundit, nga çmimi i tij deri te histogrami: çdo grumbull si një bandë horizontale me etiketën e vet (sa përqind e ditës, sa përqind u ble)."],
    ["VIJA E POC-IT", "Vijë portokalli e trashë te POC-i i ditës, me etiketë: çmimi, pjesa e volumit të ditës, pjesa e blerë."],
    ["POC-I I DJESHËM", "Vijë me pika gri te POC-i i seancës së mëparshme. Shpjegohet më poshtë te “kujdes”."],
    ["GRUMBULLI I KURTHIT", "Kur një qiri bëhet kurth, grumbulli brenda fitilit të tij mbetet i vizatuar për 30 ditë: kërkesa ose oferta mbi të cilën qëndron tregtia."],
    ["ÇELËSI", "“Show the profile” fsheh gjithçka më sipër me një klikim, që të mos mbulojë nivelet mujore. Rreshti i tabelës dhe etiketat e sinjalit mbeten."],
  ],
  120,
);

doc.sub("Ngjyrat: blerje, shitje, balancë");
doc.body(
  "Për çdo orë lexohet ku u mbyll ajo brenda gamës së saj: mbyllje afër maksimumit numërohet si blerje, afër " +
    "minimumit si shitje. Grumbulli del jeshil kur të paktën 55% e volumit të tij lexohet si blerje, i kuq kur më pak " +
    "se 45%, gri kur është i balancuar. Ngjyra tregon ku ishin aktivë blerësit. Por kini parasysh shifrën e " +
    "seksionit 10: avantazhi i matur qëndron te VENDI i grumbullit (brenda fitilit, përtej nivelit), jo te ngjyra e tij.",
);

figSub("Konfluenca: kur fitili i kurthit prek POC-in", 360);
doc.body(
  "Kur fitili i refuzimit të një kurthi mujor mban brenda vetes POC-in e ditës, tregtimi më i rëndë i ditës ndodhi " +
    "pikërisht aty ku u morën stopet, dhe qiriri megjithatë u mbyll në anën e duhur. Kur POC-i qëndron edhe PËRTEJ " +
    "nivelit mujor (më poshtë se niveli, për long), sinjali shënohet si konfluencë e lartë dhe etiketa bëhet “LONG ★”. " +
    "Indikatori dallon katër shkallë:",
);

doc.table(
  [
    { header: "Shkalla", width: 118 },
    { header: "Kushti", width: 190 },
    { header: "Sinjale", width: 54, align: "right", mono: true },
    { header: "Pozitive", width: 56, align: "right", mono: true },
    { header: "Mesatarja", width: CONTENT_W - 418, align: "right", mono: true },
  ],
  [
    ["★ Konfluencë e lartë", "POC brenda fitilit DHE përtej nivelit mujor", "40", "75%", "+0.99R"],
    ["POC brenda fitilit", "POC brenda fitilit, jo përtej nivelit", "17", "76%", "+0.84R"],
    ["Grumbull brenda fitilit", "Vetëm një grumbull prek fitilin", "13", "85%", "+0.95R"],
    ["Asnjë grumbull", "Fitili nuk prek asnjë grumbull", "1", "0%", "-1.00R"],
  ],
);
doc.body(
  "Shifrat janë mbi 71 sinjalet long të v1.1 (dera + prova). Te shkalla ★ gjysma e tregtive arritën objektivin 2R " +
    "dhe 15% u ndalën; te 20 çiftet e para +0.71R, te 30 të tjerat +1.15R. E njëjta renditje doli edhe pa provën " +
    "(100 sinjale long brenda regjimit: ★ 42 me +0.97R, POC brenda fitilit 29 me +0.84R, grumbull 21 me +0.45R, asnjë " +
    "8 me +0.01R) dhe mbi 279 sinjalet e v1.0 (★ 100 me +0.46R, 100 me +0.06R, 50 me +0.33R, 29 me +0.06R). " +
    "Renditja u mbajt me 12, 24 dhe 40 shirita dhe me pragje grumbulli 50% e 70%. Për short, 19 sinjale janë shumë " +
    "pak për të renditur shkallët.",
);

{
  const w = data["XRPUSDT_2024-07-05"];
  const h = w.h1 ?? [];
  const p = w.profile as FigProfile;
  const candles: OHLC[] = h.map(([o, hi, lo, c]) => [o, hi, lo, c] as OHLC);
  const vols = h.map((r) => r[4]);
  const dayVol = vols.reduce((a, b) => a + b, 0);
  const { bins, poc } = profileBins(p);
  const t = w.trade;
  const dayLow = Math.min(...h.map((r) => r[2]));
  const body = Math.min(w.candles[w.trapIdx][0], w.candles[w.trapIdx][3]);
  const zones: ChartZone[] = [
    { from: dayLow, to: body, color: C.amber, opacity: 0.06 },
    ...clusterZones(p, dayVol, "grumbull blerjeje"),
  ];
  chart(doc, {
    tag: `${w.sym} - 1h + profili i ditës`,
    headline: `★ Konfluencë e lartë: POC-i brenda fitilit dhe nën nivelin, ${w.sym}`,
    candles,
    height: 196,
    decimals: 4,
    padRight: 11,
    profile: { bins, poc, width: 118, hvn: 0.7 },
    zones,
    lines: [
      { price: t.lvl, label: "Niveli mujor", color: C.up },
      { price: poc, label: `POC ${fmt(poc, 4)}`, color: C.amber, dash: false, thickness: 1.2, labelAt: 20 },
    ],
    notes: [
      {
        i: 14,
        price: poc,
        text: `POC ${fmt(poc, 4)}: ${pct(t.pocShare)} e volumit të ditës, ${pct(t.pocBuy)} blerje. Brenda fitilit (${fmt(dayLow, 4)}-${fmt(body, 4)}) dhe nën nivelin ${fmt(t.lvl, 4)}: ★.`,
        dx: -8,
        dy: -34,
        ring: { rx: 7, ry: 5 },
        color: C.amber,
        maxWidth: 150,
      },
    ],
    axis: [0, 6, 12, 18].map((i) => ({ i, label: `${String(i).padStart(2, "0")}:00` })),
    legend: [
      { label: "POC", color: C.amber },
      { label: "grumbull (HVN)", color: C.cyan },
      { label: "blerje >= 55%", color: C.up },
      { label: "fitili ditor (bandë e zbehtë)", color: C.amber },
    ],
    caption:
      `Histogrami djathtas është profili i ditës: 24 shirita çmimi, gjatësia e secilit volumi që u tregtua aty. Shiriti ` +
      `më i rëndë, POC ${fmt(poc, 4)}, mban ${pct(t.pocShare)} të ditës dhe qëndron poshtë nivelit mujor ${fmt(t.lvl, 4)}, pra ` +
      `aty ku u morën stopet. Tre grumbuj, të gjithë brenda fitilit të qiririt ditor. Qiriri u mbyll te ${fmt(t.entry, 4)}: ` +
      "kjo është shkalla ★, 40 nga 71 sinjalet e testuara, +0.99R mesatarisht.",
  });
}

{
  const w = data["BTCUSDT_2024-08-05"];
  const h = w.h1 ?? [];
  const p = w.profile as FigProfile;
  const candles: OHLC[] = h.map(([o, hi, lo, c]) => [o, hi, lo, c] as OHLC);
  const vols = h.map((r) => r[4]);
  const dayVol = vols.reduce((a, b) => a + b, 0);
  const { bins, poc } = profileBins(p);
  const t = w.trade;
  const dayLow = Math.min(...h.map((r) => r[2]));
  const body = Math.min(w.candles[w.trapIdx][0], w.candles[w.trapIdx][3]);
  const zones: ChartZone[] = [
    { from: dayLow, to: body, color: C.amber, opacity: 0.06 },
    ...clusterZones(p, dayVol, "grumbull"),
  ];
  chart(doc, {
    tag: `${w.sym} - 1h + profili i ditës`,
    headline: `Shkalla “grumbull brenda fitilit”: POC-i sipër nivelit, ${w.sym}, ${dateLong(w.trapDate)}`,
    candles,
    height: 196,
    decimals: 0,
    padRight: 11,
    profile: { bins, poc, width: 118, hvn: 0.7 },
    zones,
    lines: [
      { price: t.lvl, label: "Min. i muajit të kaluar", color: C.up, labelAt: 9 },
      { price: poc, label: `POC ${fmt(poc, 0)}`, color: C.amber, dash: false, thickness: 1.2, labelAt: 9 },
    ],
    notes: [
      {
        i: 15,
        price: poc,
        text: `POC ${fmt(poc, 0)} qëndron SIPËR nivelit ${fmt(t.lvl, 0)} dhe sipër mbylljes ${fmt(t.entry, 0)}: dita u tregtua kryesisht mbi nivelin. Jo ★.`,
        dx: -8,
        dy: 30,
        ring: { rx: 7, ry: 5 },
        color: C.amber,
        maxWidth: 150,
      },
      {
        i: 5,
        price: (p.zones[0][0] + p.zones[0][1]) / 2,
        text: `Grumbulli i dytë (${fmt(p.zones[0][0], 0)}-${fmt(p.zones[0][1], 0)}) është brenda fitilit: shkalla “grumbull brenda fitilit”.`,
        dx: 12,
        dy: -24,
        color: C.neutral,
        maxWidth: 136,
      },
    ],
    axis: [0, 6, 12, 18].map((i) => ({ i, label: `${String(i).padStart(2, "0")}:00` })),
    legend: [
      { label: "POC", color: C.amber },
      { label: "grumbull (HVN)", color: C.cyan },
      { label: "niveli mujor", color: C.up },
      { label: "fitili ditor (bandë e zbehtë)", color: C.amber },
    ],
    caption:
      `Bitcoin, dita e kapitullimit të 5 gushtit 2024: minimumi ${fmt(dayLow, 0)}, mbyllja ${fmt(t.entry, 0)}, fitili ${pct(t.wick)} e gamës, ` +
      `volumi ${(t.rv / 100).toFixed(1)}x. Kurthi është i plotë dhe prova kalon (${pct(w.proof?.beyond ?? 0)} përtej, ${pct(w.proof?.recov ?? 0)} pas), ` +
      `por POC-i i ditës (${fmt(poc, 0)}) është sipër nivelit mujor: pjesa më e madhe e tregtimit u bë pasi çmimi ishte kthyer. ` +
      `Sinjali printohet si “LONG” pa yll; tregtia u mbyll me kohë pas 30 ditësh me ${rr(t.R)}.`,
  });
}

figSub("Kujdes: fitili brenda vlerës së djeshme", 330);
doc.body(
  "Profili i seancës së mëparshme ruhet në mbylljen e saj. Kur fitili i kurthit të sotëm ndalet brenda POC-it ose " +
    "një grumbulli të djeshëm, çmimi ka rënë vetëm deri aty ku tregu tashmë e kishte pranuar vlerën dje: nuk ka pasur " +
    "marrje stopesh përtej vlerës, vetëm një kthim brenda saj. Indikatori e shënon këtë si “caution” në tabelë dhe në " +
    "alarm. Nuk e bllokon sinjalin, sepse brenda cilësimeve të paracaktuara rastet janë pak, por shifrat flasin qartë:",
);
doc.table(
  [
    { header: "Grupi", width: 200 },
    { header: "Brenda vlerës së djeshme", width: 150, mono: true },
    { header: "Jashtë saj", width: CONTENT_W - 350, mono: true },
  ],
  [
    ["279 sinjale long v1.0", "37 · 24% · -0.20R", "242 · 55% · +0.32R"],
    ["100 sinjale long brenda regjimit", "7 · 43% · +0.21R", "93 · 72% · +0.78R"],
    ["71 sinjale long v1.1", "6 · 50% · +0.41R", "65 · 78% · +0.96R"],
    ["19 short të konfirmuara v1.1", "9 · 56% · +0.03R", "10 · 90% · +1.22R"],
  ],
);
doc.body("Lexim: numri i sinjaleve · pjesa pozitive · mesatarja në R.", { size: 8.4 });

{
  const w = data["XTZUSDT_2025-04-07"];
  const s = slice(w, 14, 10);
  const t = w.trade;
  const exitI = s.trap + w.exit.idx;
  const prevPoc = w.profilePrev?.poc_px ?? 0.5863;
  const zone = w.demand.find((z) => Math.abs(z[1] - t.lvl) < 1e-6) ?? [0.5215, t.lvl];
  chart(doc, {
    tag: `${w.sym} - 1D - UTC`,
    headline: `★ me kujdes: fitili ndalet brenda POC-it të djeshëm, ${w.sym}, ${dateLong(w.trapDate)}`,
    candles: s.candles,
    volumes: s.volumes,
    height: 186,
    decimals: 3,
    zones: [{ from: zone[0], to: zone[1], label: "zonë kërkese mujore", color: C.up, opacity: 0.14 }],
    lines: [
      { price: prevPoc, label: "POC i djeshëm", color: C.neutral },
      { price: t.pocPx, label: "POC i ditës", color: C.amber, dash: false },
      { price: t.stop, label: "Stop", color: C.down },
    ],
    bands: [
      { i: s.trap, label: "kurthi ★", color: C.up, opacity: 0.12 },
      { i: exitI, label: "stopi", color: C.down, opacity: 0.12 },
    ],
    notes: [
      {
        i: s.trap,
        price: prevPoc,
        text: `POC-i i djeshëm (${fmt(prevPoc, 4)}) bie brenda fitilit ${fmt(s.candles[s.trap][2], 3)}-${fmt(Math.min(s.candles[s.trap][0], s.candles[s.trap][3]), 3)}: “caution”.`,
        dx: -16,
        dy: 30,
        ring: { rx: 5, ry: 4 },
        color: C.neutral,
        maxWidth: 136,
      },
      {
        i: exitI,
        price: t.stop,
        text: `Stopi ${fmt(t.stop, 4)} goditet pas ${w.exit.idx} ditësh: -1R.`,
        dx: 12,
        dy: 16,
        color: C.down,
        maxWidth: 110,
      },
    ],
    axis: axisEvery(s.dates, 5, 2),
    legend: [
      { label: "POC i djeshëm", color: C.neutral },
      { label: "POC i ditës", color: C.amber },
      { label: "stop", color: C.down },
    ],
    caption:
      `Profili i vetë ditës jep ★: POC ${fmt(t.pocPx, 4)} brenda fitilit dhe nën kulmin e zonës ${fmt(t.lvl, 4)}. Por POC-i i ` +
      `seancës së mëparshme (${fmt(prevPoc, 4)}) qëndron brenda të njëjtit fitil: çmimi ra vetëm deri te vlera e djeshme dhe u kthye ` +
      `prej saj, pa marrë stope përtej saj. Alarmi do të përmbante “caution: wick inside yesterday's value”. Tregtia u ndal pas ` +
      `${w.exit.idx} ditësh. Një ★ me kujdes nuk është një ★ i pastër.`,
  });
}

doc.callout(
  "Cilësimi “Require the confluence”",
  [
    "“Off · tag only” (paracaktuar): profili raportohet në tabelë, në etiketën e sinjalit dhe në alarm, por nuk bllokon " +
      "asnjë sinjal. Ky është grupi i plotë i testuar (71 long, +0.92R).",
    "“POC inside the wick”: vetëm shkallët 2 dhe ★. 57 nga 71 sinjalet, +0.94R.",
    "“High confluence”: vetëm ★. 40 sinjale, +0.99R, gjysma te objektivi. Më pak tregti, më e pastër secila. Për " +
      "short, 19 sinjale janë shumë pak për ta vendosur këtë portë me siguri.",
  ],
  GREEN,
);

/* ------------------------------------------------------------------ */
/* 8 — Sinjalet dhe plani                                              */
/* ------------------------------------------------------------------ */

doc.heading("Sinjalet dhe plani i tregtimit");

doc.body(
  "Gjithçka vendoset vetëm në mbylljen e qiririt ditor. Gjatë ditës tabela tregon portat që hapen dhe mbyllen, " +
    "por asnjë sinjal nuk printohet dhe asnjë alarm nuk niset para mbylljes. Një sinjal që është printuar nuk zhduket " +
    "dhe nuk zhvendoset më pas: indikatori nuk ripikturohet.",
);

doc.defs(
  [
    ["LONG", "Printohet në mbylljen e vetë qiririt të kurthit. Hyrja është ajo mbyllje. Pritja e një mbylljeje mbi maksimumin e kurthit u testua: hoqi 80% të sinjaleve dhe avantazhin bashkë me to; është e fikur."],
    ["SHORT", "Pret konfirmimin: qiriri ditor PASUES duhet të mbyllet nën minimumin e qiririt të kurthit. Hyrja është ajo mbyllje. Në v1.0 kjo i çoi short-et nga -0.15R në +0.28R; me regjimin, +0.66R. Pa konfirmim, short-et humbasin para."],
    ["ROMBI", "Një romb i vogël mbi ose nën qiri: të gjitha portat e hapura, por sinjali pret konfirmimin e qiririt pasues. Vetëm qiriri menjëherë pas kurthit mund ta konfirmojë."],
    ["TREKËNDËSHI", "Një portë mungon, brenda regjimit të duhur. Nuk është tregti; vlen një vështrim. Mund të fiket (“Mark traps one gate short”)."],
    ["STOPI", "0.25 ATR përtej fitilit të kurthit: nën minimumin për long, mbi maksimumin për short. Për short-et e konfirmuara, mbi më të lartin nga maksimumi i kurthit dhe i qiririt konfirmues."],
    ["OBJEKTIVI", "2R: dyfishi i distancës hyrje-stop, në drejtimin e tregtisë. Vizatohet si vijë me pika; stopi si vijë e ndërprerë."],
    ["MBAJTJA", "30 ditë. Një tregti që nuk prek as stopin as objektivin mbyllet në mbylljen ditore të ditës së 30-të dhe regjistrohet me R-në e saj."],
    ["QETËSIMI", "5 ditë para se e njëjta anë të mund të ngrihet përsëri. Shmang dy sinjale në të njëjtin kurth."],
  ],
  96,
);

{
  const w = data.SHORT;
  const s = slice(w, 16, 22);
  const t = w.trade;
  const confI = s.trap + (w.confirmIdx ?? 1);
  const exitI = s.trap + w.exit.idx;
  chart(doc, {
    tag: `${w.sym} - 1D - UTC`,
    headline: `Short i konfirmuar te maksimumi mujor: ${w.sym}, ${dateLong(w.trapDate)}`,
    candles: s.candles,
    volumes: s.volumes,
    height: 190,
    decimals: 1,
    lines: [
      { price: w.pmHigh, label: "Maks. i muajit të kaluar", color: C.down },
      { price: t.stop, label: "Stop", color: C.down, dash: true },
      { price: t.target, label: "Objektivi 2R", color: C.cyan },
    ],
    bands: [
      { i: s.trap, label: "kurthi", color: C.down, opacity: 0.12 },
      { i: confI, label: "konfirmimi", color: C.amber, opacity: 0.12 },
      { i: exitI, label: "objektivi", color: C.cyan, opacity: 0.1 },
    ],
    notes: [
      {
        i: s.trap,
        price: s.candles[s.trap][1],
        text: `Maksimumi ${fmt(s.candles[s.trap][1], 2)} kalon maksimumin e shkurtit (${fmt(w.pmHigh, 1)}) dhe maksimumin e 12 ditëve; mbyllja ${fmt(s.candles[s.trap][3], 2)} nën nivel. Fitili ${pct(t.wick)}, volumi ${(t.rv / 100).toFixed(1)}x. Rombi: pritet konfirmimi.`,
        dx: -16,
        dy: 10,
        ring: { rx: 5, ry: 6 },
        color: C.down,
        maxWidth: 160,
      },
      {
        i: confI,
        price: s.candles[confI][3],
        text: `Dita pasuese mbyllet te ${fmt(t.entry, 2)}, nën minimumin e kurthit (${fmt(s.candles[s.trap][2], 2)}): SHORT. Stopi ${fmt(t.stop, 2)}, objektivi ${fmt(t.target, 2)}.`,
        dx: 16,
        dy: -30,
        color: C.amber,
        maxWidth: 140,
      },
    ],
    axis: axisEvery(s.dates, 7, 2),
    legend: [
      { label: "nivel mujor / stop", color: C.down },
      { label: "konfirmimi", color: C.amber },
      { label: "objektiv", color: C.cyan },
    ],
    caption:
      `Bitcoin më ${dateLong(w.trapDate)}: ${data.btcDist[w.trapDate].pct.toFixed(1)}% nën mesataren 200-ditore, pra dera e short-eve e hapur. ` +
      `AXS thyen maksimumin e muajit të kaluar (${fmt(w.pmHigh, 1)}) me fitil ${pct(t.wick)} dhe volum ${(t.rv / 100).toFixed(1)}x, por sinjali pret: ` +
      `vetëm kur qiriri pasues mbyllet nën minimumin e kurthit printohet SHORT, me hyrje ${fmt(t.entry, 2)}. Objektivi 2R u arrit ` +
      `pas ${w.exit.idx - (w.confirmIdx ?? 1)} ditësh.`,
  });
}

doc.callout(
  "Si ta përdorni R-në",
  [
    "1R është distanca nga hyrja te stopi. Madhësia e pozicionit = rreziku që pranoni në para / 1R. Indikatori nuk " +
      "e bën këtë llogari dhe nuk e njeh llogarinë tuaj; ai jep vetëm hyrjen, stopin dhe objektivin.",
    "Regjistri në tabelë (“Chart record”) numëron tregtitë e mbyllura në këtë grafik me këto cilësime: numri, pjesa " +
      "e mbyllur me fitim, mesatarja në R. Pa komisione. Është regjistri i këtij grafiku, jo i testimit.",
  ],
  AMBER,
);

/* ------------------------------------------------------------------ */
/* 9 — Tabela dhe alarmet                                              */
/* ------------------------------------------------------------------ */

doc.heading("Tabela e portave dhe alarmet");

doc.body(
  "Tabela në cep të grafikut është pjesa që ia vlen të mësohet. Çdo rresht emërton një portë, tregon çfarë mat " +
    "tani dhe ngjyroset kur porta është e hapur: jeshile për long, e kuqe për short, gri kur jo. Koka e kolonës " +
    "“Long” ose “Short” ndizet kur çdo portë është e hapur në qiririn aktual; sinjali prapë pret mbylljen ditore. " +
    "Mbi çdo rresht ka një shpjegim që shfaqet kur mbani kursorin sipër.",
);

doc.table(
  [
    { header: "Rreshti", width: 150 },
    { header: "Tregon", width: CONTENT_W - 150 },
  ],
  [
    ["0 · Regime", "Referenca kundrejt mesatares së saj: p.sh. “BTCUSDT -3.3% vs rising 200d”. Pastaj “open” ose “closed” për secilën anë."],
    ["1 · Monthly level", "Niveli i arritur (PM low, demand, PQ/PY, +PQ/+PY kur është i mbivendosur) ose, kur s'është arritur, distanca nga mbyllja te niveli më i afërt."],
    ["2 · 12-day sweep", "“new low” / “new high” kur minimumi ose maksimumi i 12 ditëve është thyer."],
    ["3 · Rejection wick", "Fitili i poshtëm dhe i sipërm si përqindje e gamës. Ngjyroset nga 45% e lart."],
    ["4 · Volume climax", "Volumi kundrejt mesatares 20-ditore, në përqindje. “n/a” kur simboli nuk ka volum."],
    ["5 · Wick proof · 60m", "“përtej% · pas%” kur matet; “no intrabars” kur qiriri është jashtë buxhetit; “—” kur s'ka nivel të arritur."],
    ["6 · Intraday profile", "Shkalla e konfluencës për secilën anë: “★ high”, “POC in wick”, “cluster in wick”, “no cluster”, dhe “· caution” kur fitili është brenda vlerës së djeshme. “· gate” në emër kur është bërë portë."],
    ["POC ... · n% of the day", "Çmimi i POC-it dhe pjesa e volumit të ditës që u tregtua aty; numri i grumbujve; pjesa e blerë te POC-i (jeshile, e kuqe ose gri)."],
    ["Gates open", "Portat e hapura nga ato aktive, p.sh. “4/5”. Dera e regjimit nuk numërohet: është derë, jo portë."],
    ["Trade", "Sinjali i freskët me stopin, ose kurthi që pret konfirmim (“needs close < ...”), ose tregtia e hapur me stopin dhe objektivin."],
    ["Chart record", "Tregtitë e mbyllura në këtë grafik: numri · % me fitim · mesatarja në R."],
    ["Live zones", "Sa zona kërkese dhe oferte janë të gjalla tani."],
    ["Dashboard band", "A është ky çift brenda universit të panelit Nova ($0.001-$7.00, plus Bitcoin). Shënim, kurrë portë."],
    ["Rreshti i fundit", "Gjendja: “Daily close”, “Live candle · signals at the close”, ose një paralajmërim (pa volum, referencë e palexueshme, pa qirinj të brendshëm)."],
  ],
);

doc.sub("Alarmet");
doc.body(
  "Në TradingView, shtypni ikonën e orës (Alert), zgjidhni “Nova Monthly Trap” te “Condition” dhe pastaj një nga " +
    "kushtet: “Monthly Trap · LONG”, “Monthly Trap · SHORT”, “... · high confluence” për vetëm ★, ose kurthet që " +
    "presin konfirmim. Zgjidhni “Once per bar close”. Për mesazhin e plotë me shifrat e ditës, zgjidhni “Any alert() " +
    "function call”: skripti dërgon vetë një tekst si ky, i përshtatshëm edhe për webhook:",
);
doc.code([
  "LONG · XLMUSDT 1D @ 0.0854 | prev month low 0.0846 · swept the 12-day low",
  "· lower wick 85% · RVOL 420% · proof 86% beyond / 97% after",
  "· profile: ★ high confluence (POC 0.0785, 9% of the day)",
  "· BTCUSDT -3.3% vs rising 200d | stop 0.0755 | target 0.1052 (2R)",
]);
doc.defs(
  [
    ["LONG · ... @", "Ana, çifti, koha (1D) dhe çmimi i hyrjes (mbyllja ditore)."],
    ["prev month low", "Niveli i kurthit dhe çmimi i tij. Mund të jetë “monthly demand a-b”, “prev quarter low” etj., plus “stacked on ...” kur është i mbivendosur."],
    ["swept · wick · RVOL", "Portat 2, 3 dhe 4 me shifrat e matura."],
    ["proof", "Porta 5: përqindja përtej nivelit dhe përqindja pas ekstremit. “proof n/a” kur s'ka qirinj të brendshëm dhe kalimi është lejuar."],
    ["profile", "Porta 6: shkalla e konfluencës, POC-i dhe pjesa e tij e ditës; “caution: wick inside yesterday's value” kur vlen."],
    ["BTCUSDT ... 200d", "Dera: distanca e referencës nga mesatarja dhe drejtimi i mesatares."],
    ["stop / target", "Stopi dhe objektivi 2R të llogaritur për këtë sinjal."],
    ["outside the ... band", "Shtohet në fund kur çifti është jashtë universit të panelit Nova."],
  ],
  126,
);

/* ------------------------------------------------------------------ */
/* 10 — Testimi                                                        */
/* ------------------------------------------------------------------ */

doc.heading("Çfarë tregoi testimi");

doc.body(
  "Metoda është e njëjtë për çdo version: 50 çifte USDT në Binance, qirinj ditorë nga 2017 deri në 2026 (354 " +
    "vite-monedhë). 20 çifte u përdorën për ta ndërtuar rregullin, 30 të tjerat vetëm për ta kontrolluar (“IS” dhe " +
    "“OOS” në shënime). Çdo sinjal u tregtua njësoj: hyrje në mbyllje, stop 0.25 ATR përtej fitilit, objektiv 2R, " +
    "dalje pas 30 ditësh nëse asnjëri nuk preket; kur një qiri prek të dyja, numërohet stopi. Pa komisione. Prova " +
    "dhe profili u lexuan nga qirinj 1-orësh të vërtetë për çdo ditë kandidate.",
);

doc.sub("Sinjalet long, version pas versioni");
doc.table(
  [
    { header: "Rregulli", width: 168 },
    { header: "Sinjale", width: 56, align: "right", mono: true },
    { header: "Pozitive", width: 58, align: "right", mono: true },
    { header: "Stop", width: 46, align: "right", mono: true },
    { header: "Mesatarja", width: 66, align: "right", mono: true },
    { header: "IS / OOS", width: CONTENT_W - 394, align: "right", mono: true },
  ],
  [
    ["v1.0 · katër portat", "279", "51%", "27%", "+0.25R", "+0.32 / +0.17"],
    ["+ dera e regjimit", "100", "70%", "16%", "+0.74R", "+0.77 / +0.71"],
    ["+ prova e fitilit (v1.1, paracaktimi)", "71", "76%", "13%", "+0.92R", "+0.93 / +0.90"],
    ["v1.2 · vetëm ★ konfluencë e lartë", "40", "75%", "15%", "+0.99R", "+0.71 / +1.15"],
  ],
);

doc.sub("Sinjalet short");
doc.table(
  [
    { header: "Rregulli", width: 200 },
    { header: "Sinjale", width: 56, align: "right", mono: true },
    { header: "Pozitive", width: 58, align: "right", mono: true },
    { header: "Mesatarja", width: 66, align: "right", mono: true },
    { header: "IS / OOS", width: CONTENT_W - 380, align: "right", mono: true },
  ],
  [
    ["v1.0 · pa konfirmim", "290", "36%", "-0.15R", "-0.11 / -0.17"],
    ["v1.0 · të konfirmuara", "43", "67%", "+0.28R", "+0.59 / +0.18"],
    ["+ dera e regjimit (v1.1, paracaktimi)", "19", "74%", "+0.66R", "+0.72 / +0.63"],
  ],
);

doc.sub("71 sinjalet long të v1.1 sipas periudhës");
doc.table(
  [
    { header: "Periudha", width: 110 },
    { header: "Sinjale", width: 70, align: "right", mono: true },
    { header: "Mesatarja", width: 80, align: "right", mono: true },
    { header: "Shënim", width: CONTENT_W - 260 },
  ],
  [
    ["2017-2019", "0", "-", "katër long kaluan derën, të katër u ndalën; prova i hoqi, fat sa edhe dizajn"],
    ["2020-2021", "2", "+1.03R", ""],
    ["2022", "14", "+1.29R", "tregu i ariut, korrigjime të thella brenda mesatares në rritje"],
    ["2023-2024", "42", "+0.71R", "mbi gjysma e kampionit"],
    ["2025-2026", "13", "+1.16R", ""],
  ],
);

doc.callout(
  "Kujdes me numrat: 71 sinjale, 8 ditë",
  [
    "71 sinjalet long të v1.1 bien në vetëm tetë ditë kalendarike: 5 gusht 2024 (22 çifte), 5 korrik 2024 (19), 7 " +
      "prill 2025 (13), 24 shkurt 2022 (10), 22 janar 2022 (3), 22 qershor 2021 (2) dhe nga një në tetor 2023 e janar " +
      "2022. Shtatë nga tetë ditët dolën pozitive, me +0.98R mesatarisht për ditë. Pesë ditët me ★ dolën të pesta pozitive.",
    "Kjo është natyra e kurthit mujor në kripto: gjithë tregu kapitullon bashkë, dhe atë ditë shumë çifte japin " +
      "sinjal njëkohësisht. Mos i trajtoni 20 sinjalet e një dite si 20 tregti të pavarura: është një ngjarje tregu me " +
      "20 shprehje. Ndajeni rrezikun në nivel dite, jo në nivel çifti.",
    "40 nga 50 çiftet dhanë të paktën një sinjal, asnjëri më shumë se pesë. 71 tregti janë kampion i vogël; 42 prej " +
      "tyre vijnë nga 2023-2024. Të dhënat e testimit janë çmime spot, paneli Nova skanon kontrata perpetual: " +
      "modeli është i njëjtë, çmimet mund të ndryshojnë pak.",
  ],
  RED,
);

doc.sub("Çfarë NUK ndihmoi");
doc.bullets([
  "Rregulli klasik “long sipër mesatares”: -0.02R kundrejt Bitcoin-it, -0.16R kundrejt mesatares së vetë grafikut.",
  "Nivelet e tremujorit dhe vitit si burim kurthi: +0.18R për 32 long, -0.28R për 9 short, asnjë brenda derës dhe provës.",
  "Prova e fitilit te short-et: hoqi po aq tregti të mira sa të këqija.",
  "Ngjyra e POC-it: te 71 long, POC me blerje >= 55% dha +0.68R (26 sinjale), i balancuar +1.17R (25), me shitje " +
    "dominuese +1.16R (6). Ngjyrat tregojnë ku ishin blerësit; avantazhi i matur është te vendi i grumbullit.",
  "Pritja e konfirmimit për long: hoqi 80% të sinjaleve dhe avantazhin.",
]);

/* ------------------------------------------------------------------ */
/* 11 — Cilësimet                                                      */
/* ------------------------------------------------------------------ */

doc.heading("Referenca e cilësimeve");

doc.body(
  "Emrat janë ata që shfaqen në dritaren e cilësimeve të TradingView (në anglisht); vlera në kllapa është e " +
    "paracaktuara, pra ajo e testuar. Çdo cilësim ka edhe një shpjegim të vetin brenda dritares.",
);

const SETTINGS_COLS = [
  { header: "Cilësimi", width: 196, mono: true },
  { header: "Paracaktimi", width: 86, mono: true },
  { header: "Çfarë bën", width: CONTENT_W - 282 },
];

doc.sub("0 · Market regime");
doc.table(SETTINGS_COLS, [
  ["Require the market regime", "on", "Dera. Fikja e saj kthen sinjalet në stilin v1.0: +0.25R në vend të +0.74R."],
  ["Reference market", "BINANCE:BTCUSDT", "Tregu referencë. Bitcoin testoi shumë më mirë se vetë grafiku."],
  ["Use the chart symbol instead", "off", "Përdor trendin e vetë çiftit si referencë. Testimi: +0.28R."],
  ["Regime average (days)", "200", "Gjatësia e mesatares së thjeshtë. 150-250 njësoj; 100 jo."],
  ["Slope lookback (days)", "20", "Mesatarja është në rritje kur është më e lartë se kaq ditë më parë. 5-60 njësoj."],
  ["Longs need the reference", "Below a rising average", "Kushti i derës për long (shih tabelën në seksionin 3)."],
  ["Shorts need the reference", "Below the average", "Kushti i derës për short."],
]);

doc.sub("1-4 · Trap gates dhe 5 · Wick proof");
doc.table(SETTINGS_COLS, [
  ["1 · Level reach (x ATR)", "0.25", "Sa afër nivelit duhet të vijë fitili. 0 do të thotë ta prekë vetë nivelin."],
  ["2 · Sweep lookback (days)", "12", "Ditët, minimumi ose maksimumi i të cilave duhet thyer."],
  ["3 · Rejection wick (% of range)", "45", "Fitili i refuzimit si pjesë e gamës. 45% është dyshemeja."],
  ["4 · Volume climax (% of average)", "250", "Volumi kundrejt mesatares së 20 ditëve të mëparshme."],
  ["Require the volume gate", "on", "Fikeni vetëm për simbole pa të dhëna volumi."],
  ["Require the wick proof (longs)", "on", "Porta 5 për long."],
  ["Require it for shorts too", "off", "Prova për short. Testimi: nuk ndihmoi."],
  ["Intrabar timeframe", "60", "Qirinjtë e brendshëm për provën dhe profilin. 1h i testuar; 2h/4h njësoj, më shumë histori."],
  ["Volume beyond the level (%)", "10", "Pragu i parë i provës. 5-25% testuan mes +0.79R dhe +0.87R."],
  ["Volume after the extreme (%)", "50", "Pragu i dytë. 25-100% testuan mes +0.74R dhe +0.86R."],
  ["When intrabars are unavailable", "Skip the signal", "Skip: pa sinjal. Pass: kalon pa provë, si në v1.0."],
]);

doc.sub("6 · Intraday volume profile");
doc.table(SETTINGS_COLS, [
  ["Build the intraday profile", "on", "Ndërton profilin dhe shkallën e konfluencës. Fikja heq rreshtin, etiketat ★ dhe vizatimet."],
  ["Price bins across the day", "24", "Në sa shirita ndahet gama e ditës. 12, 24 dhe 40 testuan njësoj."],
  ["Cluster threshold (% of the POC bin)", "70", "Shiritat me të paktën kaq përqind të POC-it janë grumbuj. 50% dhe 70% njësoj."],
  ["Require the confluence", "Off · tag only", "Off · tag only / POC inside the wick / High confluence. Shih seksionin 7."],
  ["Show the profile", "on", "Çelësi kryesor i vizatimeve. Fsheh gjithçka pa prekur tabelën dhe etiketat."],
  ["Histogram / Cluster bands / Yesterday's POC", "on", "Pjesët e veçanta të vizatimit, secila me çelësin e vet."],
  ["Keep the cluster that caught a trap wick", "on", "Grumbulli i kurthit mbetet 30 ditë në grafik."],
  ["Profile width (bars)", "12", "Gjerësia e histogramit, në qirinj."],
]);

doc.sub("Monthly levels, Signals and trade plan, Display");
doc.table(SETTINGS_COLS, [
  ["Previous month high / low", "on", "Nivelet kryesore të kurthit."],
  ["Monthly supply / demand zones", "on", "Zonat mujore. Zone pivot strength 2 muaj, Zone depth cap 1 ATR, Live zones kept per side 10."],
  ["Current month open", "off", "Hapja e muajit si nivel. Testimi: pak më keq."],
  ["Previous quarter / year high and low", "off", "Si burim kurthi. Vizatohen gjithsesi me Quarter / year level lines."],
  ["Signals", "Both", "Both / Long only / Short only."],
  ["Shorts wait for a close below the trap low", "on", "Konfirmimi i short-eve. Mos e fikni."],
  ["Longs wait for a close above the trap high", "off", "Konfirmimi i long-eve. Testimi: hoqi avantazhin."],
  ["Stop beyond the wick (x ATR)", "0.25", "Stopi përtej fitilit të kurthit."],
  ["Target (R multiple)", "2", "Objektivi."],
  ["Max hold (days) · Cooldown (days)", "30 · 5", "Mbajtja maksimale dhe qetësimi mes dy sinjaleve të të njëjtës anë."],
  ["Display", "", "Vijat mujore, vijat e tremujorit/vitit, zonat, zonat e zbehura, nivelet e tregtisë, trekëndëshat, tabela dhe pozicioni i saj, ngjyrat (long, short, neutral, POC)."],
  ["Dashboard universe", "0.001 · 7", "Shënimi i universit Nova: dyshemeja dhe tavani në dollarë. Vetëm informacion."],
]);

/* ------------------------------------------------------------------ */
/* 12 — Kufizimet                                                      */
/* ------------------------------------------------------------------ */

doc.heading("Kufizimet dhe këshilla praktike");

doc.bullets([
  "Vetëm grafiku ditor (1D). Nivelet, portat, dera, prova, profili dhe çdo shifër testimi janë ndërtuar mbi qirinj " +
    "ditorë. Në çdo kohë tjetër indikatori shfaq një njoftim dhe nuk vizaton.",
  "Nuk ripikturohet. Nivelet vijnë nga muaj të mbyllur, regjimi lexohet nga e njëjta kohë ditore pa shikim përpara, " +
    "qirinjtë e brendshëm janë të plotë në mbylljen ditore dhe asgjë nuk lexon një qiri të ardhshëm. Profili i qiririt " +
    "të fundit rritet orë pas ore deri në mbyllje; profili i një qiriri të mbyllur është i ngrirë.",
  "Buxheti i qirinjve të brendshëm (100.000 në shumicën e planeve) kufizon sa larg në histori ka provë dhe profil. " +
    "Tabela thotë që nga cila datë. Më përpara, me cilësimet e paracaktuara, nuk ka sinjal.",
  "Universi i panelit Nova është Bitcoin plus altcoin-et me çmim rreptësisht mes $0.001 dhe $7.00. Rreshti " +
    "“Dashboard band” thotë nëse çifti para jush është brenda; alarmi shton “outside the dashboard band” kur jo. " +
    "Indikatori punon njësoj në çdo çift; shënimi është vetëm për të ditur çfarë sheh paneli.",
  "Të dhënat e testimit janë spot Binance; paneli Nova skanon kontrata perpetual USD-M. Modeli i kurthit është i " +
    "njëjtë; çmimet dhe volumet mund të ndryshojnë pak nga ato që shihni në një grafik perpetual.",
  "Komisionet nuk janë përfshirë. Në kohë ditore me objektiv 2R efekti është i vogël, por nuk është zero.",
]);

doc.callout(
  "Çfarë nuk bën ky indikator",
  [
    "Nuk përcakton madhësinë e pozicionit, nuk menaxhon rrezikun dhe nuk e njeh llogarinë tuaj. Ai shënon një qiri ku " +
      "disa kushte ishin të vërteta njëkohësisht dhe jep stopin e objektivin që testimi përdori.",
    "Nuk ka kujtesë nëse sinjali i fundit funksionoi dhe nuk ka mendim për lajmet. Çdo qiri gjykohet me faktet e veta.",
    "Nuk është këshillë financiare. Rezultatet e kaluara, edhe kur maten me kujdes, nuk janë premtim për të ardhmen.",
  ],
  RED,
);

doc.sub("Rutina e këshilluar");
doc.steps([
  { title: "Në mbylljen ditore (00:00 UTC), shikoni alarmet", text: "Një alarm LONG ose SHORT ka gjithçka: nivelin, portat, provën, profilin, derën, stopin dhe objektivin." },
  { title: "Lexoni shkallën e konfluencës dhe “caution”", text: "★ pa “caution” është sinjali më i pastër i testuar. ★ me “caution” ose një “no cluster” meriton dyshim." },
  { title: "Numëroni sa çifte dhanë sinjal të njëjtën ditë", text: "Shumë sinjale në një ditë janë një ngjarje e vetme tregu. Ndajeni rrezikun e ditës mes tyre, mos e shumëfishoni." },
  { title: "Vendosni stopin dhe objektivin siç i jep indikatori", text: "Stopi 0.25 ATR përtej fitilit, objektivi 2R, mbyllje pas 30 ditësh. Çdo ndryshim ju nxjerr jashtë shifrave të testuara." },
  { title: "Mos e fikni derën dhe konfirmimin e short-eve", text: "Të dyja janë ndryshimet që e kthyen kurthin mujor nga një rregull mesatar në një të përdorshëm." },
]);

/* ------------------------------------------------------------------ */
/* Finish                                                              */
/* ------------------------------------------------------------------ */

doc.renderToc(tocPage, tocY);
doc.finish(`NOVA MONTHLY TRAP - PINE SCRIPT v6 - ${VERSION} - MANUAL NË SHQIP`);

const bytes = await doc.save();
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, bytes);

const pine = await readFile(PINE, "utf8");
console.log(
  `${path.relative(process.cwd(), OUT)}  ${doc.pageNumber} pages  ${figureCount()} figures  ` +
    `${bytes.length.toLocaleString("en-US")} bytes`,
);
console.log(`${path.relative(process.cwd(), PINE)}  ${pine.split("\n").length} lines  v1.2: ${pine.includes("v1.2")}`);
