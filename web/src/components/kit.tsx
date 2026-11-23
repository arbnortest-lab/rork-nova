import { forwardRef, useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClassName,
  flush,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Removes body padding — use for tables that draw their own rows. */
  flush?: boolean;
}) {
  return (
    <section className={cn("panel", className)}>
      {title ? (
        <header className="panel-head">
          <h2 className="lbl">{title}</h2>
          {aside}
        </header>
      ) : null}
      <div className={cn(!flush && "p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Metric — one compact label/number pair                              */
/* ------------------------------------------------------------------ */

export type Tone = "default" | "pos" | "neg" | "warn" | "muted" | "brand";

const TONE: Record<Tone, string> = {
  default: "text-foreground",
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  muted: "text-muted-foreground",
  brand: "text-primary",
};

export function Metric({
  label,
  value,
  sub,
  tone = "default",
  size = "md",
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizing = size === "lg" ? "text-[19px]" : size === "sm" ? "text-[12.5px]" : "text-[15px]";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="lbl truncate">{label}</div>
      <div className={cn("num mt-1 font-semibold leading-none", sizing, TONE[tone])}>{value}</div>
      {sub ? <div className="num mt-1 text-[10.5px] leading-none text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row — dense label/value line                                        */
/* ------------------------------------------------------------------ */

export function Row({
  label,
  value,
  tone = "default",
  strong,
}: {
  label: string;
  value: string;
  tone?: Tone;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-[27px] items-center justify-between gap-4 border-b border-line-soft last:border-b-0",
        strong && "bg-secondary/25",
      )}
    >
      <span className={cn("lbl", strong && "text-foreground")}>{label}</span>
      <span className={cn("num text-[12.5px]", strong ? "font-semibold" : "font-medium", TONE[tone])}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonTone = "solid" | "outline" | "ghost" | "danger";

const BUTTON_TONE: Record<ButtonTone, string> = {
  solid: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline: "border border-input bg-secondary/40 text-foreground hover:border-muted-foreground/50 hover:bg-secondary",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  danger: "border border-neg/35 bg-neg-soft text-neg hover:bg-neg/20",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: "sm" | "md";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "outline", size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[3px] font-medium uppercase tracking-[0.08em] transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        "active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-[10.5px]" : "h-8 px-3 text-[11px]",
        BUTTON_TONE[tone],
        className,
      )}
      style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace' }}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex h-8 gap-px rounded-[3px] border border-input bg-input p-px", className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.hint}
            onClick={() => onChange(opt.value)}
            className={cn(
              "num min-w-0 flex-1 whitespace-nowrap rounded-[2px] px-1.5 text-[10.5px] font-medium uppercase leading-none tracking-[0.04em] transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field — numeric terminal input                                      */
/* ------------------------------------------------------------------ */

interface FieldProps {
  label: string;
  /** Short role note shown beside the label, e.g. "first fill". */
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  accent?: "pos" | "neg" | "brand";
  disabled?: boolean;
  className?: string;
}

/**
 * Numeric input that holds its own text buffer while focused, so typing
 * "0.0" or clearing the box never fights the parent's rounded value.
 */
export function Field({
  label,
  hint,
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  decimals,
  accent,
  disabled,
  className,
}: FieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);

  const display = useMemo(() => {
    if (draft !== null) return draft;
    if (!Number.isFinite(value)) return "";
    if (decimals === undefined) return String(value);
    return value.toFixed(decimals);
  }, [draft, value, decimals]);

  const clamp = useCallback(
    (n: number) => {
      let out = n;
      if (min !== undefined) out = Math.max(min, out);
      if (max !== undefined) out = Math.min(max, out);
      return out;
    },
    [min, max],
  );

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number.parseFloat(raw.replace(/,/g, ""));
      onChange(Number.isFinite(parsed) ? clamp(parsed) : 0);
      setDraft(null);
    },
    [clamp, onChange],
  );

  const bump = useCallback(
    (dir: 1 | -1) => {
      const next = clamp((Number.isFinite(value) ? value : 0) + dir * step);
      onChange(Number.parseFloat(next.toPrecision(12)));
      setDraft(null);
    },
    [clamp, onChange, step, value],
  );

  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="lbl mb-1 flex items-baseline gap-1.5">
        <span className="truncate">{label}</span>
        {hint ? <span className="shrink-0 tracking-[0.1em] text-primary/75">{hint}</span> : null}
      </label>
      <div className="relative flex items-center">
        <input
          id={id}
          inputMode="decimal"
          disabled={disabled}
          value={display}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setDraft(e.target.value);
            e.target.select();
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              bump(1);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              bump(-1);
            }
          }}
          className={cn(
            "field",
            unit && "pr-8",
            accent === "pos" && "text-pos",
            accent === "neg" && "text-neg",
            accent === "brand" && "text-primary",
            disabled && "opacity-40",
          )}
        />
        {unit ? (
          <span className="num pointer-events-none absolute right-2 text-[10.5px] text-muted-foreground">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tag                                                                 */
/* ------------------------------------------------------------------ */

export function Tag({
  children,
  tone = "muted",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "pos" | "neg" | "warn" | "brand";
  className?: string;
  /** Native tooltip, for detail that does not fit in the tag. */
  title?: string;
}) {
  const tones: Record<string, string> = {
    muted: "border-border bg-secondary text-muted-foreground",
    pos: "border-pos/30 bg-pos-soft text-pos",
    neg: "border-neg/30 bg-neg-soft text-neg",
    warn: "border-warn/30 bg-warn-soft text-warn",
    brand: "border-primary/40 bg-primary/10 text-primary",
  };
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-[0.1em]",
        tones[tone],
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}
