/**
 * View helpers for the on-chain add-on's status, shared by the status strip
 * tag and the settings dialog. Pure functions over provider state — nothing
 * here talks to the backend.
 */

export type ChainBackendTone = "muted" | "pos" | "warn" | "brand";

export interface ChainBackendView {
  text: string;
  tone: ChainBackendTone;
}

/**
 * One word for the add-on's backend state. `null` while the first status
 * probe is still in flight, so the UI can show nothing rather than a guess.
 */
export function chainBackendView(input: {
  enabled: boolean;
  statusAt: number;
  statusFailed: boolean;
  configured: boolean | undefined;
  busy: boolean;
}): ChainBackendView | null {
  if (!input.enabled) return { text: "off", tone: "muted" };
  if (input.statusAt === 0) return null;
  if (input.statusFailed || input.configured === undefined) return { text: "offline", tone: "warn" };
  if (!input.configured) return { text: "no key", tone: "warn" };
  if (input.busy) return { text: "scanning", tone: "brand" };
  return { text: "ready", tone: "pos" };
}
