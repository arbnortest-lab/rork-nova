import { Check, RotateCcw, Save, Trash2 } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { Button, Panel, Segmented, Tag } from "@/components/kit";
import {
  DEFAULT_WICK_RULES,
  formatParam,
  MAX_CONFIG_NAME,
  matchPreset,
  SLIDER_STEPS,
  sliderToValue,
  toDisplay,
  validateParamInput,
  valueToSlider,
  WICK_PARAMS,
  WICK_PRESETS,
  type SavedWickConfig,
  type WickParamSpec,
  type WickPresetId,
} from "@/lib/wick/rules";
import type { WickRules } from "@/lib/wick/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* One parameter: curved slider + exact numeric input                  */
/* ------------------------------------------------------------------ */

function displayText(spec: WickParamSpec, stored: number): string {
  return toDisplay(spec, stored).toFixed(spec.decimals);
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: WickParamSpec;
  value: number;
  onChange: (stored: number) => void;
}) {
  const id = useId();
  // The typed text while editing; otherwise the input shows the live value, so
  // slider moves, presets and resets show up at once.
  const [draft, setDraft] = useState<string | null>(null);
  const [rejected, setError] = useState<{ text: string; message: string; at: number } | null>(null);
  // A rejection is dropped as soon as the value changes elsewhere (preset, reset, load).
  const error = rejected && rejected.at === value ? rejected : null;
  const text = draft ?? error?.text ?? displayText(spec, value);

  const commit = () => {
    const check = validateParamInput(spec, text);
    setDraft(null);
    if ("error" in check) {
      // Keep the rejected text visible beside its message until fixed.
      setError({ text, message: check.error, at: value });
      return;
    }
    setError(null);
    onChange(check.stored);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      commit();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(displayText(spec, value));
      setError(null);
    }
  };

  const isDefault = value === DEFAULT_WICK_RULES[spec.key];

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="lbl">
          {spec.label}
        </label>
        <span className={cn("num text-[10px]", isDefault ? "text-muted-foreground/60" : "text-primary/80")}>
          {isDefault ? "default" : `def ${formatParam(spec, DEFAULT_WICK_RULES[spec.key])}`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={valueToSlider(spec, toDisplay(spec, value))}
          onChange={(e) => {
            const display = sliderToValue(spec, Number(e.target.value));
            const check = validateParamInput(spec, String(display));
            if ("stored" in check) {
              setError(null);
              onChange(check.stored);
            }
          }}
          className="h-1 min-w-0 flex-1 accent-primary"
          aria-label={`${spec.label} slider`}
        />
        <div
          className={cn(
            "flex h-7 w-[104px] shrink-0 items-center rounded-[3px] border bg-input px-1.5",
            error ? "border-neg/70" : "border-input focus-within:border-primary/60",
          )}
        >
          {spec.prefix ? <span className="num text-[11px] text-muted-foreground">{spec.prefix}</span> : null}
          <input
            id={id}
            type="text"
            inputMode="decimal"
            value={text}
            onFocus={() => setDraft(text)}
            onBlur={commit}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onKey}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint`}
            className="num w-full min-w-0 bg-transparent text-right text-[12.5px] font-semibold text-foreground outline-none"
          />
          {spec.unit ? <span className="num ml-1 text-[10.5px] text-muted-foreground">{spec.unit}</span> : null}
        </div>
      </div>
      <p id={`${id}-hint`} className={cn("mt-1 text-[10.5px] leading-[1.4]", error ? "text-neg" : "text-muted-foreground")}>
        {error?.message ?? `${spec.hint} Range ${spec.prefix ?? ""}${spec.min}–${spec.prefix ?? ""}${spec.max}${spec.unit ? ` ${spec.unit}` : ""}.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Saved configurations                                                */
/* ------------------------------------------------------------------ */

function SavedConfigs({
  configs,
  rules,
  onSave,
  onLoad,
  onDelete,
}: {
  configs: SavedWickConfig[];
  rules: WickRules;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const overwrites = configs.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  const save = () => {
    if (!trimmed) return;
    onSave(trimmed);
    setName("");
  };
  const sameAs = (c: SavedWickConfig) =>
    WICK_PARAMS.every((p) => c.rules[p.key] === rules[p.key]);

  return (
    <div>
      <div className="lbl mb-1.5">Saved configurations</div>
      <div className="flex items-center gap-1.5">
        <input
          value={name}
          maxLength={MAX_CONFIG_NAME}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder="Name this setup…"
          aria-label="Configuration name"
          className="num h-7 min-w-0 flex-1 rounded-[3px] border border-input bg-input px-2 text-[12px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
        />
        <Button tone="outline" size="sm" onClick={save} disabled={!trimmed}>
          <Save className="h-[11px] w-[11px]" />
          {overwrites ? "Overwrite" : "Save"}
        </Button>
      </div>
      {configs.length ? (
        <ul className="mt-2 divide-y divide-border rounded-[3px] border border-border">
          {configs.map((c) => {
            const active = sameAs(c);
            return (
              <li key={c.name} className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => onLoad(c.name)}
                  className={cn(
                    "num min-w-0 flex-1 truncate text-left text-[12px] hover:text-primary",
                    active ? "text-primary" : "text-foreground",
                  )}
                  title={`Load "${c.name}"`}
                >
                  {active ? <Check className="mr-1 inline h-[11px] w-[11px]" /> : null}
                  {c.name}
                </button>
                <span className="num hidden text-[10px] text-muted-foreground sm:inline">
                  {formatParam(WICK_PARAMS[0], c.rules.pinBps)} · {Math.round(c.rules.rvolClimax)}% ·{" "}
                  {c.rules.wickPct}% · {c.rules.depletionPct}%
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(c.name)}
                  className="text-muted-foreground hover:text-neg"
                  aria-label={`Delete "${c.name}"`}
                >
                  <Trash2 className="h-[12px] w-[12px]" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          Save the current thresholds under a name to switch back to them later. Stored in this browser.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function RulesConfig({
  rules,
  patchRules,
  resetRules,
  applyPreset,
  savedConfigs,
  saveConfig,
  loadConfig,
  deleteConfig,
}: {
  rules: WickRules;
  patchRules: (patch: Partial<WickRules>) => void;
  resetRules: () => void;
  applyPreset: (id: WickPresetId) => void;
  savedConfigs: SavedWickConfig[];
  saveConfig: (name: string) => void;
  loadConfig: (name: string) => void;
  deleteConfig: (name: string) => void;
}) {
  const profile = matchPreset(rules);
  const preset = WICK_PRESETS.find((p) => p.id === profile);
  const gates = WICK_PARAMS.filter((p) => p.group === "gates");
  const scanner = WICK_PARAMS.filter((p) => p.group === "scanner");

  return (
    <Panel
      title="Engine settings"
      aside={
        <Button tone="ghost" size="sm" onClick={resetRules} title="Restore every setting to the engine defaults">
          <RotateCcw className="h-[11px] w-[11px]" />
          Reset to defaults
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="lbl shrink-0">Profile</div>
        <Segmented<WickPresetId | "custom">
          value={profile}
          options={[
            ...WICK_PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.description })),
            { value: "custom" as const, label: "Custom", hint: "Any combination that matches no preset" },
          ]}
          onChange={(v) => {
            if (v !== "custom") applyPreset(v);
          }}
          className="sm:max-w-[560px] sm:flex-1"
        />
        <p className="text-[10.5px] text-muted-foreground">
          {preset ? preset.description : "Custom thresholds — save them below to keep them."}
        </p>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <h3 className="lbl">Gate thresholds</h3>
        <Tag tone="brand">4 gates</Tag>
      </div>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        {gates.map((spec) => (
          <ParamControl
            key={spec.key}
            spec={spec}
            value={rules[spec.key]}
            onChange={(stored) => patchRules({ [spec.key]: stored })}
          />
        ))}
      </div>

      <div className="mb-2 mt-5 flex items-center gap-2">
        <h3 className="lbl">Scanner</h3>
      </div>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        {scanner.map((spec) => (
          <ParamControl
            key={spec.key}
            spec={spec}
            value={rules[spec.key]}
            onChange={(stored) => patchRules({ [spec.key]: stored })}
          />
        ))}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <SavedConfigs
          configs={savedConfigs}
          rules={rules}
          onSave={saveConfig}
          onLoad={loadConfig}
          onDelete={deleteConfig}
        />
      </div>
    </Panel>
  );
}
