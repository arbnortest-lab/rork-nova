/**
 * DocsPanel — the Pine Script indicators, manuals and the engine audit,
 * carried over from the v1 dashboard unchanged (same files, same links).
 */

import { Download, FileText } from "lucide-react";

import { Button, Panel } from "@/components/kit";
import {
  ENGINE_AUDIT_PAGES,
  ENGINE_AUDIT_URL,
  ENGINE_AUDIT_VERSION,
  INDICATOR_MANUAL_FIGURES,
  INDICATOR_MANUAL_PAGES,
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

export function DocsPanel() {
  return (
    <div className="grid gap-3 p-3 lg:grid-cols-3">
      <Panel title="TradingView · Exhaustion Trap" bodyClassName="space-y-2.5">
        <p className="text-[11px] leading-[1.55] text-muted-foreground">
          The same four gates as this engine, in Pine Script v6. Paste it into the Pine Editor and add it to any chart.
        </p>
        <a href={PINE_URL} download={PINE_FILENAME} className="block">
          <Button tone="solid" size="sm" className="w-full">
            <Download className="h-3 w-3" />
            Download Pine Script · {PINE_VERSION}
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
      </Panel>

      <Panel title="TradingView · VWAP & Monthly Trap" bodyClassName="space-y-2.5">
        <div className="space-y-2.5">
          <p className="text-[11px] leading-[1.55] text-muted-foreground">
            <span className="font-medium text-foreground">VWAP Distance Filter Pro ({VWAP_PINE_VERSION})</span> — how far
            price is stretched from VWAP in percent, sigma or ATR, with adaptive percentile bands and mean-reversion
            signals. Works both directions.
          </p>
          <a href={VWAP_PINE_URL} download={VWAP_PINE_FILENAME} className="block">
            <Button tone="outline" size="sm" className="w-full">
              <Download className="h-3 w-3" />
              Download Pine Script
            </Button>
          </a>
        </div>
        <div className="space-y-2.5 border-t border-border/60 pt-3">
          <p className="text-[11px] leading-[1.55] text-muted-foreground">
            <span className="font-medium text-foreground">Monthly Trap ({MONTHLY_PINE_VERSION})</span> — daily-chart
            traps at monthly levels, only while Bitcoin sits below its rising 200-day average, with the day&apos;s
            volume profile read from intrabars and a ★ high-confluence flag.
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
            Tested on 50 Binance pairs, 2017–2026; the Albanian manual covers install, every gate and the profile, with{" "}
            {MONTHLY_MANUAL_FIGURES} real-history chart figures.
          </p>
        </div>
      </Panel>

      <Panel title="Engine audit" bodyClassName="space-y-2.5">
        <p className="text-[11px] leading-[1.55] text-muted-foreground">
          Every formula behind the four gates, the verdict and alert state machine, and the squeeze radar&apos;s depth,
          wall, squeeze, liquidation-cluster and open-interest reads, transcribed from the shipped code with the file
          and function each one lives in.
        </p>
        <a href={ENGINE_AUDIT_URL} download target="_blank" rel="noreferrer" className="block">
          <Button tone="outline" size="sm" className="w-full">
            <FileText className="h-3 w-3" />
            Audit report · {ENGINE_AUDIT_PAGES}pp · {ENGINE_AUDIT_VERSION}
          </Button>
        </a>
        <p className="num text-[10px] leading-[1.5] text-muted-foreground">
          Worked examples are computed by the engine itself when the report is built, and every quoted constant is
          pinned to the source, so the document cannot drift from the code. Includes the edge-case guards and a
          findings list.
        </p>
      </Panel>
    </div>
  );
}
