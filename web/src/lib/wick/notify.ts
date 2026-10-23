/**
 * Alert delivery for the Liquidity Exhaustion Engine.
 *
 * Five channels, all dispatched from the browser: desktop notification, sound,
 * in-app popup, Telegram and Discord. The two remote channels are called
 * directly because both expose permissive CORS headers, so there is no relay
 * server and no credential ever leaves this browser except to its own service.
 *
 * Request shapes are chosen to avoid a CORS preflight where possible — Telegram
 * is sent as form-encoded, which is a "simple" request.
 */

import { fmtPrice } from "@/lib/format";

import type { WickAlert } from "./types";

export interface NotifyTargets {
  desktop: boolean;
  sound: boolean;
  popup: boolean;
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
}

export interface DeliveryResult {
  channel: "telegram" | "discord";
  ok: boolean;
  error?: string;
}

/** Short headline shared by every channel. Short-only, so there is one form. */
export function alertHeadline(alert: WickAlert): string {
  return `SHORT · BULL TRAP AT 24H HIGH — ${alert.symbol}`;
}

/** Plain-text body shared by the remote channels. */
export function alertText(alert: WickAlert): string {
  const head = alertHeadline(alert);
  const meta = [
    `Price ${fmtPrice(alert.price)}`,
    `extreme ${fmtPrice(alert.extreme)}`,
    alert.rvol === undefined ? null : `RVOL ${Math.round(alert.rvol)}%`,
    alert.wickPct === undefined ? null : `wick ${alert.wickPct.toFixed(1)}%`,
    `conviction ${alert.conviction}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const why = alert.reasons.map((r) => `- ${r}`).join("\n");
  return `${head}\n${meta}\n\nAll four gates passed:\n${why}`;
}

/** Every alert is a short, so the embed colour is fixed. */
const SHORT_COLOUR = 0xef4444;

let audioCtx: AudioContext | null = null;

/** Three descending notes — deliberately distinct from the radar's two-note chime. */
export function playWickChime(): void {
  try {
    type WithLegacy = typeof window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as WithLegacy).webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();

    const notes = [880, 660, 494];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
  } catch {
    // Audio is a nicety; never let it break the scan loop.
  }
}

export function showDesktop(alert: WickAlert): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification(alertHeadline(alert), {
      body: alert.reasons.slice(0, 3).join(" · "),
      tag: `wick-${alert.symbol}`,
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* permission revoked mid-session */
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function sendTelegram(
  token: string,
  chatId: string,
  alert: WickAlert,
): Promise<DeliveryResult> {
  try {
    await postForm(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
      chat_id: chatId.trim(),
      text: alertText(alert),
      disable_web_page_preview: "true",
    });
    return { channel: "telegram", ok: true };
  } catch (err) {
    return {
      channel: "telegram",
      ok: false,
      error: err instanceof Error ? err.message : "send failed",
    };
  }
}

export async function sendDiscord(webhook: string, alert: WickAlert): Promise<DeliveryResult> {
  try {
    const res = await fetch(webhook.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: alertHeadline(alert),
            description: alert.reasons.map((r) => `• ${r}`).join("\n").slice(0, 3800),
            color: SHORT_COLOUR,
            footer: { text: `Conviction ${alert.conviction} · Nova Exhaustion Engine` },
            timestamp: new Date(alert.at).toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { channel: "discord", ok: true };
  } catch (err) {
    return {
      channel: "discord",
      ok: false,
      error: err instanceof Error ? err.message : "send failed",
    };
  }
}

/** Fans an alert out to every configured remote channel. */
export async function deliverRemote(
  alert: WickAlert,
  targets: NotifyTargets,
): Promise<DeliveryResult[]> {
  const jobs: Promise<DeliveryResult>[] = [];
  if (targets.telegramToken && targets.telegramChatId) {
    jobs.push(sendTelegram(targets.telegramToken, targets.telegramChatId, alert));
  }
  if (targets.discordWebhook) {
    jobs.push(sendDiscord(targets.discordWebhook, alert));
  }
  if (!jobs.length) return [];
  return Promise.all(jobs);
}
