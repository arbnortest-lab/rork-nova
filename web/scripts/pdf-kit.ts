/**
 * Minimal PDF layout engine used to typeset the operator manual.
 *
 * pdf-lib draws text at coordinates and nothing more — this adds the parts a
 * document needs: word wrap, a downward cursor, automatic page breaks,
 * headings, bullets, tables, callouts and footers.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

export const PAGE = { w: 595.28, h: 841.89 };
export const MARGIN = { top: 58, bottom: 54, x: 54 };
export const CONTENT_W = PAGE.w - MARGIN.x * 2;

export const INK: RGB = rgb(0.09, 0.1, 0.13);
export const MUTED: RGB = rgb(0.44, 0.47, 0.52);
export const AMBER: RGB = rgb(0.9, 0.58, 0.08);
export const GREEN: RGB = rgb(0.11, 0.55, 0.38);
export const RED: RGB = rgb(0.75, 0.19, 0.24);
export const RULE: RGB = rgb(0.85, 0.86, 0.88);
export const SOFT: RGB = rgb(0.965, 0.968, 0.973);
export const DARK: RGB = rgb(0.047, 0.055, 0.075);
export const PAPER: RGB = rgb(1, 1, 1);

/**
 * Standard PDF fonts are WinAnsi-encoded and throw on anything outside it.
 * Content is written with typographic characters, so fold the common offenders
 * down to safe equivalents instead of policing every string by hand.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[\u2192\u27f6]/g, "->")
    .replace(/[\u2190\u27f5]/g, "<-")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u2260/g, "!=")
    .replace(/\u2248/g, "~")
    .replace(/[\u00d7\u2715]/g, "x")
    .replace(/\u00f7/g, "/")
    .replace(/\u2212/g, "-")
    .replace(/\u221e/g, "inf")
    .replace(/\u0394/g, "delta ")
    .replace(/\u03a3/g, "sum ")
    .replace(/\u00b2/g, "^2")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u2605/g, "*")
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2500-\u257f]/g, "-")
    // U+2022 survives: WinAnsi encodes it at 0x95, and it is the bullet marker.
    .replace(/[^\u0020-\u00ff\u2022]/g, "");
}

export interface Fonts {
  sans: PDFFont;
  sansBold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

export interface TableColumn {
  header: string;
  width: number;
  align?: "left" | "right";
  mono?: boolean;
}

export class Doc {
  readonly pdf: PDFDocument;
  readonly fonts: Fonts;
  private page: PDFPage;
  private pages: PDFPage[] = [];
  private y = 0;
  private section = 0;
  /** Filled as headings are emitted, then replayed onto the contents page. */
  readonly toc: { num: number; title: string; page: number }[] = [];

  private constructor(pdf: PDFDocument, fonts: Fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = this.addPage();
  }

  static async create(): Promise<Doc> {
    const pdf = await PDFDocument.create();
    const fonts: Fonts = {
      sans: await pdf.embedFont(StandardFonts.Helvetica),
      sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
      mono: await pdf.embedFont(StandardFonts.Courier),
      monoBold: await pdf.embedFont(StandardFonts.CourierBold),
    };
    return new Doc(pdf, fonts);
  }

  /* ---------------- page plumbing ---------------- */

  private addPage(): PDFPage {
    const page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.pages.push(page);
    this.y = PAGE.h - MARGIN.top;
    this.page = page;
    return page;
  }

  newPage(): void {
    this.addPage();
  }

  get cursor(): number {
    return this.y;
  }

  get pageNumber(): number {
    return this.pages.length;
  }

  get current(): PDFPage {
    return this.page;
  }

  /** Breaks to a new page when `height` will not fit in the remaining space. */
  need(height: number): void {
    if (this.y - height < MARGIN.bottom) this.addPage();
  }

  space(height: number): void {
    this.y -= height;
  }

  /* ---------------- measurement ---------------- */

  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = sanitize(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [""];
  }

  /* ---------------- primitives ---------------- */

  private draw(text: string, x: number, y: number, font: PDFFont, size: number, color: RGB): void {
    this.page.drawText(sanitize(text), { x, y, size, font, color });
  }

  rule(color: RGB = RULE, thickness = 0.75, width = CONTENT_W): void {
    this.need(6);
    this.page.drawRectangle({ x: MARGIN.x, y: this.y, width, height: thickness, color });
    this.y -= 6;
  }

  /* ---------------- blocks ---------------- */

  title(text: string): void {
    this.need(34);
    this.y -= 20;
    this.draw(text, MARGIN.x, this.y, this.fonts.sansBold, 19, INK);
    this.y -= 12;
  }

  /** Numbered section heading. Always starts on a fresh page. */
  heading(text: string, { newPage = true }: { newPage?: boolean } = {}): void {
    if (newPage && this.pageNumber > 1) this.addPage();
    this.section += 1;
    this.need(48);
    this.toc.push({ num: this.section, title: text, page: this.pageNumber });

    this.page.drawRectangle({ x: MARGIN.x, y: this.y - 2, width: 26, height: 15, color: AMBER });
    this.draw(String(this.section).padStart(2, "0"), MARGIN.x + 6, this.y + 2, this.fonts.monoBold, 9.5, PAPER);
    this.draw(text.toUpperCase(), MARGIN.x + 34, this.y + 1.5, this.fonts.sansBold, 12.5, INK);
    this.y -= 11;
    this.page.drawRectangle({ x: MARGIN.x, y: this.y, width: CONTENT_W, height: 0.75, color: INK });
    this.y -= 16;
  }

  sub(text: string): void {
    this.need(26);
    this.y -= 6;
    this.draw(text.toUpperCase(), MARGIN.x, this.y, this.fonts.monoBold, 8.5, AMBER);
    this.y -= 13;
  }

  body(text: string, { color = INK, size = 9.3, indent = 0 }: { color?: RGB; size?: number; indent?: number } = {}): void {
    const lines = this.wrap(text, this.fonts.sans, size, CONTENT_W - indent);
    for (const line of lines) {
      this.need(size + 4);
      this.draw(line, MARGIN.x + indent, this.y, this.fonts.sans, size, color);
      this.y -= size + 3.6;
    }
    this.y -= 3;
  }

  bullets(items: string[], { marker = "\u2022" }: { marker?: string } = {}): void {
    const size = 9.3;
    for (const item of items) {
      const lines = this.wrap(item, this.fonts.sans, size, CONTENT_W - 14);
      lines.forEach((line, i) => {
        this.need(size + 4);
        if (i === 0) this.draw(marker, MARGIN.x + 2, this.y, this.fonts.sans, size, AMBER);
        this.draw(line, MARGIN.x + 14, this.y, this.fonts.sans, size, INK);
        this.y -= size + 3.4;
      });
      this.y -= 1.5;
    }
    this.y -= 2;
  }

  /** Numbered steps with an amber index column. */
  steps(items: { title: string; text?: string }[]): void {
    items.forEach((item, i) => {
      const size = 9.3;
      this.need(26);
      this.draw(String(i + 1).padStart(2, "0"), MARGIN.x, this.y, this.fonts.monoBold, 9, AMBER);
      const titleLines = this.wrap(item.title, this.fonts.sansBold, size, CONTENT_W - 22);
      titleLines.forEach((line) => {
        this.need(size + 4);
        this.draw(line, MARGIN.x + 22, this.y, this.fonts.sansBold, size, INK);
        this.y -= size + 3.2;
      });
      if (item.text) {
        for (const line of this.wrap(item.text, this.fonts.sans, size, CONTENT_W - 22)) {
          this.need(size + 4);
          this.draw(line, MARGIN.x + 22, this.y, this.fonts.sans, size, INK);
          this.y -= size + 3.2;
        }
      }
      this.y -= 4;
    });
  }

  /** Two-column definition list; the value column is monospaced. */
  defs(rows: [string, string][], labelWidth = 132): void {
    const size = 9;
    for (const [label, value] of rows) {
      const valueLines = this.wrap(value, this.fonts.sans, size, CONTENT_W - labelWidth - 10);
      this.need(valueLines.length * (size + 3.4) + 4);
      this.draw(label, MARGIN.x, this.y, this.fonts.monoBold, 8.2, INK);
      valueLines.forEach((line, i) => {
        this.draw(line, MARGIN.x + labelWidth, this.y - i * (size + 3.2), this.fonts.sans, size, INK);
      });
      this.y -= valueLines.length * (size + 3.2) + 4;
    }
    this.y -= 2;
  }

  /** Cells wrap onto extra lines when they outgrow their column. */
  table(columns: TableColumn[], rows: string[][]): void {
    const size = 8.2;
    const rowH = 15;
    const lineH = size + 2.6;
    this.need(rowH * Math.min(rows.length + 1, 6));

    // header
    this.page.drawRectangle({ x: MARGIN.x, y: this.y - 4, width: CONTENT_W, height: rowH, color: SOFT });
    let x = MARGIN.x + 6;
    for (const col of columns) {
      const w = col.width - 12;
      const label = sanitize(col.header.toUpperCase());
      const offset = col.align === "right" ? w - this.fonts.monoBold.widthOfTextAtSize(label, 7.2) : 0;
      this.draw(label, x + offset, this.y + 0.5, this.fonts.monoBold, 7.2, MUTED);
      x += col.width;
    }
    this.y -= rowH;

    for (const row of rows) {
      const wrapped = row.map((cell, i) => {
        const col = columns[i];
        if (!col) return [sanitize(cell)];
        return this.wrap(cell, col.mono ? this.fonts.mono : this.fonts.sans, size, col.width - 12);
      });
      const lines = Math.max(1, ...wrapped.map((cellLines) => cellLines.length));
      const extra = (lines - 1) * lineH;
      this.need(rowH + extra + 2);
      x = MARGIN.x + 6;
      wrapped.forEach((cellLines, i) => {
        const col = columns[i];
        if (!col) return;
        const font = col.mono ? this.fonts.mono : this.fonts.sans;
        const w = col.width - 12;
        cellLines.forEach((text, k) => {
          const offset = col.align === "right" ? w - font.widthOfTextAtSize(text, size) : 0;
          this.draw(text, x + offset, this.y + 1 - k * lineH, font, size, INK);
        });
        x += col.width;
      });
      this.page.drawRectangle({ x: MARGIN.x, y: this.y - 3.5 - extra, width: CONTENT_W, height: 0.5, color: RULE });
      this.y -= rowH + extra;
    }
    this.y -= 6;
  }

  /** Boxed aside with an amber spine — used for rules and warnings. */
  callout(title: string, lines: string[], accent: RGB = AMBER): void {
    const size = 8.8;
    const wrapped = lines.flatMap((l) => this.wrap(l, this.fonts.sans, size, CONTENT_W - 34));
    const height = 20 + wrapped.length * (size + 3.4);
    this.need(height + 8);

    const top = this.y + 10;
    this.page.drawRectangle({ x: MARGIN.x, y: top - height, width: CONTENT_W, height, color: SOFT });
    this.page.drawRectangle({ x: MARGIN.x, y: top - height, width: 2.5, height, color: accent });

    this.draw(title.toUpperCase(), MARGIN.x + 14, top - 13, this.fonts.monoBold, 7.6, accent);
    wrapped.forEach((line, i) => {
      this.draw(line, MARGIN.x + 14, top - 26 - i * (size + 3.4), this.fonts.sans, size, INK);
    });

    this.y = top - height - 10;
  }

  /** Monospaced formula block. */
  code(lines: string[]): void {
    const size = 8.4;
    const height = 12 + lines.length * (size + 3.6);
    this.need(height + 6);
    const top = this.y + 8;
    this.page.drawRectangle({ x: MARGIN.x, y: top - height, width: CONTENT_W, height, color: rgb(0.972, 0.976, 0.98) });
    lines.forEach((line, i) => {
      this.draw(line, MARGIN.x + 12, top - 18 - i * (size + 3.6), this.fonts.mono, size, INK);
    });
    this.y = top - height - 8;
  }

  /* ---------------- finishing ---------------- */

  /** Draws the running footer on every page except the cover. */
  finish(label: string): void {
    this.pages.forEach((page, i) => {
      if (i === 0) return;
      page.drawRectangle({ x: MARGIN.x, y: MARGIN.bottom - 16, width: CONTENT_W, height: 0.5, color: RULE });
      page.drawText(sanitize(label), {
        x: MARGIN.x,
        y: MARGIN.bottom - 28,
        size: 7,
        font: this.fonts.mono,
        color: MUTED,
      });
      const num = String(i + 1).padStart(2, "0");
      page.drawText(num, {
        x: PAGE.w - MARGIN.x - this.fonts.monoBold.widthOfTextAtSize(num, 7),
        y: MARGIN.bottom - 28,
        size: 7,
        font: this.fonts.monoBold,
        color: INK,
      });
    });
  }

  /** Replays the collected headings onto a reserved contents page. */
  renderToc(page: PDFPage, startY: number): void {
    let y = startY;
    for (const item of this.toc) {
      page.drawText(String(item.num).padStart(2, "0"), {
        x: MARGIN.x,
        y,
        size: 8.5,
        font: this.fonts.monoBold,
        color: AMBER,
      });
      page.drawText(sanitize(item.title), {
        x: MARGIN.x + 26,
        y,
        size: 9.5,
        font: this.fonts.sans,
        color: INK,
      });
      const num = String(item.page).padStart(2, "0");
      page.drawText(num, {
        x: PAGE.w - MARGIN.x - this.fonts.mono.widthOfTextAtSize(num, 8.5),
        y,
        size: 8.5,
        font: this.fonts.mono,
        color: MUTED,
      });
      page.drawRectangle({ x: MARGIN.x, y: y - 6, width: CONTENT_W, height: 0.4, color: RULE });
      y -= 19;
    }
  }

  async save(): Promise<Uint8Array> {
    return this.pdf.save();
  }
}
