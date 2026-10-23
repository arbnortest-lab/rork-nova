import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Bell, Link2, Radar, RotateCcw, Send, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { memo, useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { Button, Metric, Segmented, Tag } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { chainBackendView } from "@/lib/onchainView";
import { routeSummary } from "@/lib/radar/stream";
import { DEEP_OPTIONS, HORIZON_OPTIONS, REFRESH_OPTIONS } from "@/lib/wick/rules";
import { PRICE_BAND_LABEL, UNIVERSE_LABEL } from "@/lib/wick/universe";
import { cn } from "@/lib/utils";
import { useOnChain } from "@/store/OnChainProvider";
import { RADAR_ARM_AT, useRadar } from "@/store/RadarProvider";
import { useWick } from "@/store/WickProvider";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Compact terminal switch — 32×18, amber when on. */
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-[32px] shrink-0 rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-primary/60 bg-primary" : "border-input bg-input",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[12px] w-[12px] rounded-full transition-[left,background-color] duration-200",
          checked ? "left-[16px] bg-primary-foreground" : "left-[2px] bg-muted-foreground",
        )}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  action,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Optional control shown between the copy and the switch, e.g. "Grant". */
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="num text-[11.5px] font-semibold text-foreground">{label}</div>
        <p className="mt-0.5 text-[10.5px] leading-[1.5] text-muted-foreground">{description}</p>
      </div>
      {action}
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

function SliderField({
  label,
  hint,
  display,
  note,
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
}: {
  label: string;
  /** Which gate the threshold belongs to. */
  hint: string;
  display: string;
  note: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="lbl flex items-baseline gap-1.5">
          <span>{label}</span>
          <span className="text-primary/75">{hint}</span>
        </label>
        <span className="num shrink-0 text-[12.5px] font-semibold text-primary">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full accent-primary"
        aria-label={ariaLabel}
      />
      <p className="num mt-1.5 text-[10px] leading-[1.5] text-muted-foreground">{note}</p>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="lbl mb-1">{label}</div>
      {children}
    </div>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <span className="lbl text-foreground">{title}</span>
      {children ? <div className="flex flex-wrap items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("border-t border-line-soft pt-4 first:border-t-0 first:pt-0", className)}>{children}</section>;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export type SettingsTab = "gates" | "alerts" | "radar" | "chain";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "gates", label: "Gates" },
  { id: "alerts", label: "Alerts" },
  { id: "radar", label: "Radar" },
  { id: "chain", label: "On-chain" },
];

/* ---------------------------- Gates -------------------------------- */

const GatesTab = memo(function GatesTab() {
  const { rules, patchRules, resetRules, tracked, excluded, status } = useWick();

  return (
    <div className="space-y-4">
      <Section>
        <SectionHead title="Gate thresholds">
          <Button tone="ghost" size="sm" onClick={resetRules}>
            <RotateCcw className="h-[11px] w-[11px]" />
            Defaults
          </Button>
        </SectionHead>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <SliderField
            label="Pin distance"
            hint="gate 1"
            display={`${rules.pinBps} bps`}
            note="How far below the 24h high price may sit and still count as pinned to it."
            value={rules.pinBps}
            min={0.5}
            max={50}
            step={0.5}
            onChange={(v) => patchRules({ pinBps: v })}
            ariaLabel="Pin distance from the 24h high, in basis points"
          />
          <SliderField
            label="Volume climax"
            hint="gate 2"
            display={`${rules.rvolClimax}%`}
            note="Relative volume that counts as a climax; the gate also needs that volume to be cooling."
            value={rules.rvolClimax}
            min={150}
            max={1000}
            step={10}
            onChange={(v) => patchRules({ rvolClimax: v })}
            ariaLabel="Relative volume climax threshold"
          />
          <SliderField
            label="Rejection wick"
            hint="gate 3"
            display={`${rules.wickPct}%`}
            note="Upper wick as a share of the candle's range on the rejected higher high."
            value={rules.wickPct}
            min={45}
            max={95}
            step={1}
            onChange={(v) => patchRules({ wickPct: v })}
            ariaLabel="Rejection wick as a share of the candle range"
          />
          <SliderField
            label="Depletion band"
            hint="gate 4"
            display={`${rules.depletionPct.toFixed(1)}%`}
            note="Distance to the long-horizon high that counts as swept — upside liquidity exhausted."
            value={rules.depletionPct}
            min={0}
            max={5}
            step={0.1}
            onChange={(v) => patchRules({ depletionPct: v })}
            ariaLabel="Distance to the long-horizon high that counts as swept"
          />
        </div>
      </Section>

      <Section>
        <SectionHead title="Scanner" />
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Group label="Scan cadence">
            <Segmented
              value={String(rules.refreshMs)}
              options={REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => patchRules({ refreshMs: Number(v) })}
            />
          </Group>
          <Group label="Liquidity horizon">
            <Segmented
              value={String(rules.horizonDays)}
              options={HORIZON_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => patchRules({ horizonDays: Number(v) })}
            />
          </Group>
          <Group label="History slots">
            <Segmented
              value={String(rules.deepWatch)}
              options={DEEP_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => patchRules({ deepWatch: Number(v) })}
            />
          </Group>
          <Group label="Min 24h turnover">
            <Segmented
              value={String(rules.minVolume)}
              options={[
                { value: "0", label: "Any" },
                { value: "1000000", label: "$1M" },
                { value: "5000000", label: "$5M" },
                { value: "25000000", label: "$25M" },
              ]}
              onChange={(v) => patchRules({ minVolume: Number(v) })}
            />
          </Group>
          <Group label="Cooldown">
            <Segmented
              value={String(rules.cooldownMins)}
              options={[
                { value: "5", label: "5m" },
                { value: "15", label: "15m" },
                { value: "30", label: "30m" },
                { value: "120", label: "2h" },
              ]}
              onChange={(v) => patchRules({ cooldownMins: Number(v) })}
            />
          </Group>
        </div>
        <p className="num mt-3 text-[10px] leading-[1.5] text-muted-foreground">
          Cadence is how often every tracked contract is re-scored. The horizon is the daily lookback behind gate 4.
          History slots are the contracts that keep kline history attached — pinned and focused contracts always get
          one. Cooldown is the minimum gap before the same contract can alert again.
        </p>
      </Section>

      <Section>
        <SectionHead title="Universe">
          <Tag tone="brand">{UNIVERSE_LABEL}</Tag>
        </SectionHead>
        <p className="num text-[10px] leading-[1.5] text-muted-foreground">
          Bitcoin always, plus any altcoin whose live price sits strictly inside {PRICE_BAND_LABEL}. The test runs on
          every pass: a contract that crosses out of the band leaves the scanner on the next tick and returns only once
          its price is back inside. Right now {tracked} of {status.universe || tracked + excluded} perpetuals qualify
          and {excluded} sit outside the band. Multiplied contracts (1000PEPE, 1000SHIB…) are judged on the price they
          trade at.
        </p>
      </Section>
    </div>
  );
});

/* ---------------------------- Alerts ------------------------------- */

const AlertsTab = memo(function AlertsTab() {
  const { prefs, patchPrefs, permission, requestPermission, testAlert, lastDelivery } = useWick();

  const desktopNote = useMemo(() => {
    if (permission === "unsupported") return "This browser does not support desktop notifications.";
    if (permission === "denied") return "Blocked by the browser — allow notifications for this site in its settings.";
    if (permission !== "granted") return "Needs a one-time permission grant from the browser.";
    return "System notification when a contract arms, even while this tab is in the background.";
  }, [permission]);

  return (
    <div className="space-y-4">
      <Section>
        <SectionHead title="In this browser" />
        <div>
          <ToggleRow
            label="Popup"
            description="A toast in the corner of the page the moment all four gates pass."
            checked={prefs.popup}
            onChange={(v) => patchPrefs({ popup: v })}
          />
          <ToggleRow
            label="Chime"
            description="Short tone on every new signal."
            checked={prefs.sound}
            onChange={(v) => patchPrefs({ sound: v })}
          />
          <ToggleRow
            label="Desktop notification"
            description={desktopNote}
            checked={prefs.desktop && permission === "granted"}
            onChange={(v) => (permission === "granted" ? patchPrefs({ desktop: v }) : requestPermission())}
            disabled={permission === "unsupported" || permission === "denied"}
            action={
              permission === "default" ? (
                <Button tone="outline" size="sm" onClick={requestPermission}>
                  <Bell className="h-[11px] w-[11px]" />
                  Grant
                </Button>
              ) : null
            }
          />
        </div>
      </Section>

      <Section>
        <SectionHead title="Remote channels">
          <Button tone="outline" size="sm" onClick={testAlert}>
            <Send className="h-[11px] w-[11px]" />
            Send test
          </Button>
        </SectionHead>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Group label="Telegram bot token">
            <Input
              value={prefs.telegramToken}
              onChange={(e) => patchPrefs({ telegramToken: e.target.value })}
              placeholder="123456:ABC-DEF…"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </Group>
          <Group label="Telegram chat id">
            <Input
              value={prefs.telegramChatId}
              onChange={(e) => patchPrefs({ telegramChatId: e.target.value })}
              placeholder="-1001234567890"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </Group>
          <Group label="Discord webhook">
            <Input
              value={prefs.discordWebhook}
              onChange={(e) => patchPrefs({ discordWebhook: e.target.value })}
              placeholder="https://discord.com/api/webhooks/…"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </Group>
        </div>
        <p className="num mt-3 text-[10px] leading-[1.5] text-muted-foreground">
          Sent straight from this browser — no relay server. Credentials stay in this browser&apos;s local storage.
          {lastDelivery.length
            ? ` Last dispatch: ${lastDelivery
                .map((d) => `${d.channel} ${d.ok ? "ok" : `failed (${d.error ?? "error"})`}`)
                .join(", ")}.`
            : ""}
        </p>
      </Section>
    </div>
  );
});

/* ---------------------------- Radar -------------------------------- */

const RadarTab = memo(function RadarTab() {
  const { enabled, setEnabled, reads, armed, status, streams, holds, now } = useRadar();
  const summary = enabled ? routeSummary(status, now) : undefined;

  return (
    <div className="space-y-4">
      <Section>
        <SectionHead title="Squeeze radar · micro layer">
          <Tag tone={enabled ? (status.routes.public.state === "open" ? "pos" : "warn") : "muted"} title={summary}>
            public {enabled ? status.routes.public.state : "off"}
          </Tag>
          <Tag tone={enabled ? (status.routes.market.state === "open" ? "pos" : "warn") : "muted"} title={summary}>
            market {enabled ? status.routes.market.state : "off"}
          </Tag>
          <Button tone={enabled ? "outline" : "solid"} size="sm" onClick={() => setEnabled(!enabled)}>
            <Radar className="h-[11px] w-[11px]" />
            {enabled ? "Disable" : "Enable"}
          </Button>
        </SectionHead>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Attached" value={String(reads.size)} size="sm" tone={reads.size ? "brand" : "muted"} />
          <Metric label="Armed" value={String(armed.length)} size="sm" tone={armed.length ? "warn" : "muted"} />
          <Metric label="Streams" value={String(streams.length)} size="sm" />
          <Metric label="Held" value={String(holds.length)} size="sm" />
          <Metric label="Frames" value={status.messages.toLocaleString("en-US")} size="sm" />
          <Metric label="Reconnects" value={String(status.retries)} size="sm" tone={status.retries ? "warn" : "muted"} />
        </div>
        <p className="num mt-3 text-[10px] leading-[1.5] text-muted-foreground">
          Two routed Binance Futures sockets — the public one carries order-book depth, the market one carries
          aggressive trades, mark price, the chart&apos;s klines and liquidations. When a contract reaches {RADAR_ARM_AT}{" "}
          of 4 gates its depth (20 levels, 100ms), aggressive trades and mark price are subscribed live; the venue-wide
          liquidation stream is shared by every armed contract. Streams unsubscribe two minutes after a contract falls
          below the line, unless it is in focus or held. The radar reads the gates&apos; verdict and never feeds back
          into it.
          {status.lastError ? ` Last socket note: ${status.lastError}.` : ""}
        </p>
      </Section>
    </div>
  );
});

/* ---------------------------- On-chain ----------------------------- */

const ChainTab = memo(function ChainTab() {
  const {
    enabled,
    setEnabled,
    jobs,
    clear,
    busy,
    status,
    statusAt,
    statusFailed,
    verify,
    verifying,
    verifyResult,
  } = useOnChain();

  const backend = chainBackendView({
    enabled,
    statusAt,
    statusFailed,
    configured: status?.configured,
    busy,
  });

  return (
    <div className="space-y-4">
      <Section>
        <SectionHead title="On-chain intelligence · Arkham">
          {jobs.length ? (
            <Button tone="ghost" size="sm" onClick={clear}>
              Clear scans
            </Button>
          ) : null}
          <Button tone="ghost" size="sm" onClick={verify} disabled={verifying}>
            <ShieldCheck className="h-[11px] w-[11px]" />
            {verifying ? "Checking…" : "Verify key"}
          </Button>
          <Button tone={enabled ? "outline" : "solid"} size="sm" onClick={() => setEnabled(!enabled)}>
            <Link2 className="h-[11px] w-[11px]" />
            {enabled ? "Disable" : "Enable"}
          </Button>
        </SectionHead>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Backend" value={backend ? backend.text : "checking"} size="sm" tone={backend ? backend.tone : "muted"} />
          <Metric
            label="Credits today"
            value={
              status ? `${status.today.credits.toLocaleString("en-US")} / ${status.creditCap.toLocaleString("en-US")}` : "—"
            }
            size="sm"
            tone={status && status.today.credits >= status.creditCap ? "warn" : "default"}
          />
          <Metric label="Scans today" value={status ? String(status.today.scans) : "—"} size="sm" />
          <Metric
            label="Failures"
            value={status ? String(status.today.failures) : "—"}
            size="sm"
            tone={status && status.today.failures > 0 ? "warn" : "muted"}
          />
          <Metric label="Queue" value={status ? String(status.queue + (status.inFlight ? 1 : 0)) : "—"} size="sm" />
          <Metric label="Tracked signals" value={String(jobs.length)} size="sm" />
        </div>
        <p className="num mt-3 text-[10px] leading-[1.5] text-muted-foreground">
          Every signal is checked for $100k–$500k exchange flows in the 15 minutes before and 2 minutes after it. The
          scan runs on the backend with the Arkham key kept server-side: an early read at once, the final read 5
          minutes later. The engine never waits on it.
          {verifyResult ? ` Key check: ${verifyResult.message}.` : ""}
          {status?.lastError ? ` Last backend error: ${status.lastError}.` : ""}
        </p>
      </Section>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

/**
 * Engine settings in a modal: gate thresholds and scanner knobs, alert
 * channels, the squeeze radar and the on-chain add-on. Full-screen on
 * phones, a centred card from `sm` up. Every change applies immediately
 * through the same providers the inline panel used — nothing here touches
 * the engine itself.
 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<SettingsTab>("gates");
  const baseId = useId();
  const { enabled: radarEnabled } = useRadar();
  const { enabled: chainEnabled } = useOnChain();

  const dot: Partial<Record<SettingsTab, boolean>> = { radar: radarEnabled, chain: chainEnabled };

  /** Roving tabindex: arrow keys move both the selection and the focus. */
  const focusTab = useCallback(
    (id: SettingsTab) => {
      setTab(id);
      document.getElementById(`${baseId}-tab-${id}`)?.focus();
    },
    [baseId],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/75 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <DialogPrimitive.Content
            className={cn(
              "pointer-events-auto flex h-[100dvh] w-full flex-col overflow-hidden bg-card text-foreground outline-none",
              "sm:h-auto sm:max-h-[min(100dvh-2rem,860px)] sm:w-[min(100vw-2rem,900px)] sm:rounded sm:border sm:border-border sm:shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)]",
              "duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-4",
              "sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
            )}
          >
            <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-secondary/40 px-4">
              <SlidersHorizontal className="h-[14px] w-[14px] text-primary" />
              <DialogPrimitive.Title className="num text-[12px] font-semibold uppercase tracking-[0.14em] text-foreground">
                Engine settings
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Gate thresholds, scanner cadence, alert channels, squeeze radar and on-chain intelligence. Changes
                apply immediately.
              </DialogPrimitive.Description>
              <DialogPrimitive.Close
                aria-label="Close settings"
                className="ml-auto grid h-7 w-7 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              >
                <X className="h-[14px] w-[14px]" />
              </DialogPrimitive.Close>
            </header>

            <nav
              role="tablist"
              aria-label="Settings sections"
              className="flex shrink-0 overflow-x-auto border-b border-border bg-background/40 px-2"
            >
              {TABS.map((t) => {
                const active = t.id === tab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`${baseId}-tab-${t.id}`}
                    aria-selected={active}
                    aria-controls={`${baseId}-panel-${t.id}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => {
                      const i = TABS.findIndex((x) => x.id === tab);
                      if (e.key === "ArrowRight") {
                        e.preventDefault();
                        focusTab(TABS[(i + 1) % TABS.length].id);
                      } else if (e.key === "ArrowLeft") {
                        e.preventDefault();
                        focusTab(TABS[(i - 1 + TABS.length) % TABS.length].id);
                      }
                    }}
                    className={cn(
                      "num relative flex h-9 shrink-0 items-center gap-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] transition-colors",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary",
                      active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                    {dot[t.id] !== undefined ? (
                      <span
                        aria-hidden
                        className={cn("h-1.5 w-1.5 rounded-full", dot[t.id] ? "bg-pos" : "bg-muted-foreground/40")}
                      />
                    ) : null}
                    {active ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" /> : null}
                  </button>
                );
              })}
            </nav>

            <div
              role="tabpanel"
              id={`${baseId}-panel-${tab}`}
              aria-labelledby={`${baseId}-tab-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
            >
              {tab === "gates" ? <GatesTab /> : null}
              {tab === "alerts" ? <AlertsTab /> : null}
              {tab === "radar" ? <RadarTab /> : null}
              {tab === "chain" ? <ChainTab /> : null}
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-secondary/25 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
              <span className="num text-[10px] leading-[1.4] text-muted-foreground">
                Changes apply immediately and stay in this browser.
              </span>
              <DialogPrimitive.Close asChild>
                <Button tone="solid" size="sm">
                  Done
                </Button>
              </DialogPrimitive.Close>
            </footer>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
