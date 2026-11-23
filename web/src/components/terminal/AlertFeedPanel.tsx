/**
 * Alert Center feed — one panel for every monitored condition, with the
 * per-category toggles, thresholds and delivery channels. The exhaustion
 * engine's own alerting (state machine, cooldowns, Telegram/Discord) is
 * untouched; those alerts simply appear here too, relayed.
 */

import { Bell, BellOff, Send, Volume2, VolumeX, X } from "lucide-react";
import { useState } from "react";

import { Button, Segmented, Tag } from "@/components/kit";
import { Field } from "@/components/kit";
import { timeAgo } from "@/lib/format";
import { ALERT_CATEGORIES, useAlertCenter, type AlertCategory } from "@/store/AlertCenterProvider";
import { cn } from "@/lib/utils";

const CAT_TONE: Record<AlertCategory, "pos" | "neg" | "warn" | "muted" | "brand"> = {
  wick: "brand",
  exhaustion: "neg",
  squeeze: "warn",
  wall: "brand",
  whale: "pos",
  oi: "muted",
  funding: "muted",
  liquidation: "neg",
};

export function AlertFeedPanel({ onSelect }: { onSelect: (symbol: string) => void }) {
  const { alerts, unseen, markAllSeen, clear, prefs, toggleCategory, setChannel, patchThresholds, test } =
    useAlertCenter();
  const [filter, setFilter] = useState<"all" | "unseen">("all");

  const rows = filter === "unseen" ? alerts.filter((a) => !a.seen) : alerts;

  return (
    <div className="flex min-h-0 flex-col">
      {/* channels + prefs */}
      <div className="shrink-0 space-y-2 border-b border-line-soft px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {ALERT_CATEGORIES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => toggleCategory(value)}
              className={cn(
                "num rounded-[2px] border px-1.5 py-[2px] text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors",
                prefs.categories[value]
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-secondary/40 text-muted-foreground/60 line-through",
              )}
              title={`${prefs.categories[value] ? "Mute" : "Enable"} ${label}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button tone="ghost" size="sm" onClick={() => setChannel("sound", !prefs.sound)} title="Toggle chime">
            {prefs.sound ? <Volume2 className="h-[12px] w-[12px]" /> : <VolumeX className="h-[12px] w-[12px]" />}
          </Button>
          <Button tone="ghost" size="sm" onClick={() => setChannel("desktop", !prefs.desktop)} title="Desktop notifications">
            {prefs.desktop ? <Bell className="h-[12px] w-[12px]" /> : <BellOff className="h-[12px] w-[12px]" />}
          </Button>
          <Segmented<"all" | "unseen">
            value={filter}
            options={[
              { value: "all", label: `All (${alerts.length})` },
              { value: "unseen", label: `New (${unseen})` },
            ]}
            onChange={setFilter}
            className="h-7 w-[168px]"
          />
          <Button tone="ghost" size="sm" onClick={test} title="Delivery test — not a live signal">
            <Send className="h-[11px] w-[11px]" />
            Test
          </Button>
          <div className="ml-auto flex items-center gap-1">
            {unseen > 0 ? (
              <Button tone="ghost" size="sm" onClick={markAllSeen}>
                Mark read
              </Button>
            ) : null}
            {alerts.length > 0 ? (
              <Button tone="ghost" size="sm" onClick={clear}>
                <X className="h-[11px] w-[11px]" />
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <details className="group">
          <summary className="num cursor-pointer text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground">
            Thresholds
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Field
              label="Squeeze min"
              value={prefs.thresholds.squeezeWarm}
              onChange={(v) => patchThresholds({ squeezeWarm: v })}
              step={1000}
              min={0}
              unit="$"
              decimals={0}
            />
            <Field
              label="Liq notional"
              value={prefs.thresholds.liquidationNotional}
              onChange={(v) => patchThresholds({ liquidationNotional: v })}
              step={1000}
              min={0}
              unit="$"
              decimals={0}
            />
            <Field
              label="OI 5m chg"
              value={prefs.thresholds.oiChangePct}
              onChange={(v) => patchThresholds({ oiChangePct: v })}
              step={0.1}
              min={0}
              unit="%"
              decimals={2}
            />
            <Field
              label="Funding"
              value={prefs.thresholds.fundingPct}
              onChange={(v) => patchThresholds({ fundingPct: v })}
              step={0.01}
              min={0}
              unit="%"
              decimals={3}
            />
            <Field
              label="Whale print"
              value={prefs.thresholds.whaleNotional}
              onChange={(v) => patchThresholds({ whaleNotional: v })}
              step={1000}
              min={0}
              unit="$"
              decimals={0}
              hint="0 = auto"
            />
          </div>
        </details>
      </div>

      {/* feed */}
      <ul className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <li className="px-3 py-8 text-center">
            <p className="num text-[11.5px] uppercase tracking-[0.12em] text-muted-foreground">No alerts</p>
            <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-foreground/70">
              Wick signals, squeeze transitions, walls, liquidations, funding and the engine's verdicts all land here
              as they fire.
            </p>
          </li>
        ) : (
          rows.map((a) => (
            <li
              key={a.id}
              className={cn("border-b border-line-soft last:border-b-0", !a.seen && "bg-primary/[0.06]")}
            >
              <button type="button" onClick={() => onSelect(a.symbol)} className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left">
                <Tag tone={CAT_TONE[a.category]}>{a.category}</Tag>
                <span className="min-w-0 flex-1">
                  <span className="num flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold">{a.symbol}</span>
                    <span className="text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">{a.type}</span>
                    <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground">{timeAgo(a.at)}</span>
                  </span>
                  <span className="num mt-0.5 block truncate text-[10.5px] text-foreground/85">{a.title}</span>
                  <span className="num block truncate text-[9.5px] text-muted-foreground">{a.detail}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
