import { Check, Download, FileText, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, Field, Panel, Row } from "@/components/kit";
import {
  INDICATOR_MANUAL_FIGURES,
  INDICATOR_MANUAL_PAGES,
  INDICATOR_MANUAL_URL,
  INDICATOR_MANUAL_VERSION,
  PINE_FILENAME,
  PINE_URL,
  PINE_VERSION,
} from "@/lib/manual";
import { UNIVERSE_LABEL } from "@/lib/wick/universe";
import { useAccount } from "@/store/AccountProvider";
import { useAuth } from "@/store/AuthProvider";
import { useJournal } from "@/store/JournalProvider";
import { useWick } from "@/store/WickProvider";

export default function Settings() {
  const { settings, updateSettings, resetSettings } = useAccount();
  const { entries } = useJournal();
  const { credentials, updateCredentials } = useAuth();
  const { alerts, rules, status, tracked, excluded } = useWick();

  const [username, setUsername] = useState<string>(credentials.username);
  const [password, setPassword] = useState<string>(credentials.password);
  const [savedAt, setSavedAt] = useState<number>(0);

  /** Equity nudge scaled to the account, so a small wallet is editable. */
  const equityStep = useMemo<number>(() => {
    const e = settings.equity;
    if (e >= 50_000) return 1000;
    if (e >= 10_000) return 500;
    if (e >= 1_000) return 100;
    if (e >= 100) return 10;
    return 1;
  }, [settings.equity]);

  useEffect(() => {
    setUsername(credentials.username);
    setPassword(credentials.password);
  }, [credentials]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(0), 1800);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const saveAccess = useCallback(() => {
    const u = username.trim();
    if (!u || !password) return;
    updateCredentials({ username: u, password });
    setSavedAt(Date.now());
  }, [username, password, updateCredentials]);

  return (
    <div className="animate-fade-in mx-auto grid max-w-[900px] grid-cols-1 gap-3 md:grid-cols-2">
      <Panel
        title="Account"
        aside={
          <Button tone="ghost" size="sm" onClick={resetSettings}>
            Reset
          </Button>
        }
        bodyClassName="space-y-2.5"
      >
        <Field
          label="Equity"
          value={settings.equity}
          onChange={(v) => updateSettings({ equity: v })}
          step={equityStep}
          min={0}
          decimals={settings.equity > 0 && settings.equity < 1000 ? 2 : 0}
          unit="$"
        />
        <p className="num text-[10px] leading-[1.5] text-muted-foreground">
          Used only to express logged results as a share of the account. Nothing in the engine reads it.
        </p>
      </Panel>

      <Panel title="Access" bodyClassName="space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="lbl mb-1 block">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="field"
            />
          </div>
          <div>
            <span className="lbl mb-1 block">Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              className="field"
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Local device only</span>
          <Button tone="solid" size="sm" onClick={saveAccess}>
            {savedAt ? <Check className="h-3 w-3" /> : null}
            {savedAt ? "Saved" : "Update"}
          </Button>
        </div>
      </Panel>

      <Panel
        title="TradingView indicator"
        aside={<span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{PINE_VERSION}</span>}
        bodyClassName="space-y-2.5"
      >
        <p className="num text-[11px] leading-[1.55] text-muted-foreground">
          Pine Script v6. The same four exhaustion gates as this engine: 24h extreme pin, volume climax and cooling,
          wick-rejection trap, and long-horizon liquidity depletion.
        </p>
        <a href={PINE_URL} download={PINE_FILENAME} className="block">
          <Button tone="solid" size="sm" className="w-full">
            <Download className="h-3 w-3" />
            Download Pine Script
          </Button>
        </a>
      </Panel>

      <Panel
        title="Indicator manual"
        aside={
          <span className="num text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {INDICATOR_MANUAL_VERSION}
          </span>
        }
        bodyClassName="space-y-2.5"
      >
        <p className="num text-[11px] leading-[1.55] text-muted-foreground">
          Installation, a gate-by-gate breakdown of the detection logic, and how to trade the signals.{" "}
          {INDICATOR_MANUAL_PAGES} pages, {INDICATOR_MANUAL_FIGURES} annotated chart figures.
        </p>
        <a href={INDICATOR_MANUAL_URL} download target="_blank" rel="noreferrer" className="block">
          <Button tone="solid" size="sm" className="w-full">
            <FileText className="h-3 w-3" />
            Download manual
          </Button>
        </a>
      </Panel>

      <Panel title="Storage" bodyClassName="p-0 px-3">
        <Row label="Logged results" value={String(entries.length)} tone="muted" />
        <Row label="Stored signals" value={String(alerts.length)} tone="muted" />
        <Row label="Universe" value={UNIVERSE_LABEL} tone="muted" />
        <Row
          label="Contracts scanned"
          value={
            status.universe > 0
              ? `${tracked.toLocaleString("en-US")} of ${status.universe.toLocaleString("en-US")} · ${excluded} outside band`
              : "not seeded"
          }
          tone={status.universe > 0 ? "muted" : "warn"}
        />
        <Row label="History slots" value={`${status.deepCount} / ${rules.deepWatch}`} tone="muted" />
        <Row label="Location" value="This browser" tone="muted" />
        <Row label="Session" value="12 hours" tone="muted" />
      </Panel>
    </div>
  );
}
