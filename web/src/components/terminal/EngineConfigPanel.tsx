/**
 * EngineConfigPanel — the settings face of the exhaustion engine, extracted
 * verbatim from the v1 dashboard's config block. Same controls, same
 * persistence: gate thresholds, universe rule, alert channels, the squeeze
 * radar's switch and the on-chain add-on. Changing a threshold here is the
 * sanctioned way to touch the engine; nothing else writes into it.
 */

import { Play, Pause, RotateCcw, Send, ShieldCheck } from "lucide-react";

import { Button, Metric, Panel, Segmented, Tag } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { routeSummary } from "@/lib/radar/stream";
import { HORIZON_OPTIONS, REFRESH_OPTIONS } from "@/lib/wick/rules";
import { PRICE_BAND_LABEL, UNIVERSE_LABEL } from "@/lib/wick/universe";
import { useOnChain } from "@/store/OnChainProvider";
import { useRadar } from "@/store/RadarProvider";
import { useWick } from "@/store/WickProvider";

export function EngineConfigPanel() {
  const {
    rules,
    patchRules,
    resetRules,
    prefs,
    patchPrefs,
    tracked,
    excluded,

    lastDelivery,
    testAlert,
    requestPermission,
    permission,
  } = useWick();

  const {
    enabled: radarEnabled,
    setEnabled: setRadarEnabled,
    reads: radarReads,
    armed: radarArmed,
    status: radarStatus,
    streams: radarStreams,
    holds: radarHolds,
    now: radarNow,
  } = useRadar();

  const {
    enabled: chainEnabled,
    setEnabled: setChainEnabled,
    jobs: chainJobs,
    clear: clearChain,
    busy: chainBusy,
    status: chainStatus,
    statusAt: chainStatusAt,
    statusFailed: chainStatusFailed,
    verify: verifyChain,
    verifying: chainVerifying,
    verifyResult: chainVerify,
  } = useOnChain();

  const chainBackend = chainEnabled
    ? chainStatusAt === 0
      ? "checking"
      : chainStatusFailed || !chainStatus
        ? "offline"
        : !chainStatus.configured
          ? "no key"
          : chainBusy
            ? "scanning"
            : "ready"
    : "off";

  return (
    <Panel
      title="Engine settings — gate thresholds & channels"
      aside={
        <Button tone="ghost" size="sm" onClick={resetRules}>
          <RotateCcw className="h-[11px] w-[11px]" />
          Defaults
        </Button>
      }
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="lbl mb-1">Scan cadence</div>
          <Segmented
            value={String(rules.refreshMs)}
            options={REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onChange={(v) => patchRules({ refreshMs: Number(v) })}
          />
        </div>
        <div>
          <div className="lbl mb-1">Streaming</div>
          <Button tone={prefs.paused ? "solid" : "outline"} size="sm" onClick={() => patchPrefs({ paused: !prefs.paused })}>
            {prefs.paused ? <Play className="h-[12px] w-[12px]" /> : <Pause className="h-[12px] w-[12px]" />}
            {prefs.paused ? "Resume" : "Pause"}
          </Button>
        </div>
        <div>
          <div className="lbl mb-1">Desktop alerts</div>
          <Button
            tone="outline"
            size="sm"
            onClick={() => (permission === "granted" ? patchPrefs({ desktop: !prefs.desktop }) : requestPermission())}
          >
            {permission === "granted" ? (prefs.desktop ? "On" : "Off") : "Grant"}
          </Button>
        </div>
        <div>
          <div className="lbl mb-1">Chime</div>
          <Button tone="outline" size="sm" onClick={() => patchPrefs({ sound: !prefs.sound })}>
            {prefs.sound ? "On" : "Off"}
          </Button>
        </div>
        <div>
          <div className="lbl mb-1">Pin distance</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.5}
              max={50}
              step={0.5}
              value={rules.pinBps}
              onChange={(e) => patchRules({ pinBps: Number(e.target.value) })}
              className="h-1 flex-1 accent-primary"
              aria-label="Pin distance from the 24h high, in basis points"
            />
            <span className="num w-14 text-right text-[12.5px] font-semibold text-primary">{rules.pinBps} bps</span>
          </div>
        </div>
        <div>
          <div className="lbl mb-1">Volume climax</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={150}
              max={1000}
              step={10}
              value={rules.rvolClimax}
              onChange={(e) => patchRules({ rvolClimax: Number(e.target.value) })}
              className="h-1 flex-1 accent-primary"
              aria-label="Relative volume climax threshold"
            />
            <span className="num w-11 text-right text-[12.5px] font-semibold">{rules.rvolClimax}%</span>
          </div>
        </div>
        <div>
          <div className="lbl mb-1">Rejection wick</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={45}
              max={95}
              step={1}
              value={rules.wickPct}
              onChange={(e) => patchRules({ wickPct: Number(e.target.value) })}
              className="h-1 flex-1 accent-primary"
              aria-label="Rejection wick as a share of the candle range"
            />
            <span className="num w-11 text-right text-[12.5px] font-semibold">{rules.wickPct}%</span>
          </div>
        </div>
        <div>
          <div className="lbl mb-1">Depletion band</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={rules.depletionPct}
              onChange={(e) => patchRules({ depletionPct: Number(e.target.value) })}
              className="h-1 flex-1 accent-primary"
              aria-label="Distance to the long-horizon high that counts as swept"
            />
            <span className="num w-11 text-right text-[12.5px] font-semibold">{rules.depletionPct.toFixed(1)}%</span>
          </div>
        </div>
        <div>
          <div className="lbl mb-1">Liquidity horizon</div>
          <Segmented
            value={String(rules.horizonDays)}
            options={HORIZON_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onChange={(v) => patchRules({ horizonDays: Number(v) })}
          />
        </div>
        <div>
          <div className="lbl mb-1">History slots</div>
          <Segmented
            value={String(rules.deepWatch)}
            options={[
              { value: "6", label: "6" },
              { value: "12", label: "12" },
              { value: "18", label: "18" },
              { value: "24", label: "24" },
            ]}
            onChange={(v) => patchRules({ deepWatch: Number(v) })}
          />
        </div>
        <div>
          <div className="lbl mb-1">Min 24h turnover</div>
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
        </div>
        <div>
          <div className="lbl mb-1">Cooldown</div>
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
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">Universe</span>
          <Tag tone="brand">{UNIVERSE_LABEL}</Tag>
        </div>
        <p className="num text-[10px] leading-[1.5] text-muted-foreground">
          V2 monitors exactly two instruments — BTCUSDT and USDCUSDT — the tracking rule is a fixed list, no longer a
          price band. The historical band rule ({PRICE_BAND_LABEL}) is kept only as reference. Right now {tracked}{" "}
          contract{tracked === 1 ? "" : "s"} track and {excluded} sit outside.
        </p>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">Remote alert channels</span>
          <Button tone="outline" size="sm" onClick={testAlert}>
            <Send className="h-[11px] w-[11px]" />
            Send test
          </Button>
        </div>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
          <div>
            <div className="lbl mb-1">Telegram bot token</div>
            <Input
              value={prefs.telegramToken}
              onChange={(e) => patchPrefs({ telegramToken: e.target.value })}
              placeholder="123456:ABC-DEF…"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <div className="lbl mb-1">Telegram chat id</div>
            <Input
              value={prefs.telegramChatId}
              onChange={(e) => patchPrefs({ telegramChatId: e.target.value })}
              placeholder="-1001234567890"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <div className="lbl mb-1">Discord webhook</div>
            <Input
              value={prefs.discordWebhook}
              onChange={(e) => patchPrefs({ discordWebhook: e.target.value })}
              placeholder="https://discord.com/api/webhooks/…"
              className="h-8 text-[12px]"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <p className="num mt-2 text-[10px] leading-[1.5] text-muted-foreground">
          Sent straight from this browser — no relay server. Credentials stay in this browser&apos;s local storage.
          {lastDelivery.length
            ? ` Last dispatch: ${lastDelivery
                .map((d) => `${d.channel} ${d.ok ? "ok" : `failed (${d.error ?? "error"})`}`)
                .join(", ")}.`
            : ""}
        </p>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">Squeeze radar · micro layer</span>
          <div className="flex items-center gap-1.5">
            <Tag
              tone={radarEnabled ? (radarStatus.state === "open" ? "pos" : "warn") : "muted"}
              title={radarEnabled ? routeSummary(radarStatus, radarNow) : undefined}
            >
              public {radarEnabled ? radarStatus.routes.public.state : "off"}
            </Tag>
            <Tag
              tone={radarEnabled ? (radarStatus.routes.market.state === "open" ? "pos" : "warn") : "muted"}
              title={radarEnabled ? routeSummary(radarStatus, radarNow) : undefined}
            >
              market {radarEnabled ? radarStatus.routes.market.state : "off"}
            </Tag>
            <Button tone={radarEnabled ? "outline" : "solid"} size="sm" onClick={() => setRadarEnabled(!radarEnabled)}>
              {radarEnabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5">
          <Metric label="Attached" value={String(radarReads.size)} size="sm" tone={radarReads.size ? "brand" : "muted"} />
          <Metric label="Armed" value={String(radarArmed.length)} size="sm" tone={radarArmed.length ? "warn" : "muted"} />
          <Metric label="Streams" value={String(radarStreams.length)} size="sm" />
          <Metric label="Held" value={String(radarHolds.length)} size="sm" />
          <Metric label="Frames" value={radarStatus.messages.toLocaleString("en-US")} size="sm" />
          <Metric label="Reconnects" value={String(radarStatus.retries)} size="sm" tone={radarStatus.retries ? "warn" : "muted"} />
        </div>
      </div>

      <div className="mt-4 border-t border-line-soft pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">On-chain intelligence · Arkham</span>
          <div className="flex items-center gap-1.5">
            {chainJobs.length ? (
              <Button tone="ghost" size="sm" onClick={clearChain}>
                Clear scans
              </Button>
            ) : null}
            <Button tone="ghost" size="sm" onClick={verifyChain} disabled={chainVerifying}>
              <ShieldCheck className="h-[11px] w-[11px]" />
              {chainVerifying ? "Checking…" : "Verify key"}
            </Button>
            <Button tone={chainEnabled ? "outline" : "solid"} size="sm" onClick={() => setChainEnabled(!chainEnabled)}>
              {chainEnabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-x-5 gap-y-2.5">
          <Metric label="Backend" value={chainBackend} size="sm" tone={chainBackend === "ready" ? "pos" : "muted"} />
          <Metric
            label="Credits today"
            value={chainStatus ? `${chainStatus.today.credits.toLocaleString("en-US")} / ${chainStatus.creditCap.toLocaleString("en-US")}` : "—"}
            size="sm"
          />
          <Metric label="Scans today" value={chainStatus ? String(chainStatus.today.scans) : "—"} size="sm" />
          <Metric
            label="Failures"
            value={chainStatus ? String(chainStatus.today.failures) : "—"}
            size="sm"
            tone={chainStatus && chainStatus.today.failures > 0 ? "warn" : "muted"}
          />
          <Metric label="Tracked signals" value={String(chainJobs.length)} size="sm" />
        </div>
        <p className="num mt-2 text-[10px] leading-[1.5] text-muted-foreground">
          Every signal is checked for $100k–$500k exchange flows around it, on the backend, with the key kept
          server-side. The engine never waits on it.
          {chainVerify ? ` Key check: ${chainVerify.message}.` : ""}
        </p>
      </div>
    </Panel>
  );
}
