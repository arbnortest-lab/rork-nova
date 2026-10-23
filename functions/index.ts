// functions/index.ts — the entrypoint for Nova DCA Pro's backend.
//
// The only thing served here is the on-chain intelligence add-on for the
// Wick module. Every `/onchain/*` route is handed to the single
// `OnChainScanner` Durable Object, which owns the Arkham API key, the
// rate-limit pacing and the scan cache. The Wick engine itself never
// depends on this backend: when it is down the add-on reports
// "unavailable" and nothing else changes.

export { OnChainScanner } from "./scanner";

type Env = {
  DO: Fetcher;
  ARKHAM_API_KEY?: string;
  /** Extra hostnames (comma separated) allowed to call the scan endpoint from a browser. */
  ONCHAIN_ALLOWED_HOSTS?: string;
};

const ALLOWED_HOST_SUFFIXES = [".rork.live", ".rork.app", "localhost"];

/**
 * Browsers always send `Origin` on cross-site POSTs, so an Origin outside the
 * app's own hosts is a stranger trying to spend this project's Arkham credits.
 * Requests without an Origin (same-origin GETs, native callers) pass through:
 * the guard is for drive-by browser abuse, not a security boundary.
 */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const extra = (env.ONCHAIN_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return (
    ALLOWED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, "") || host.endsWith(s)) ||
    extra.some((h) => host === h || host.endsWith(`.${h}`))
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }

    if (url.pathname.startsWith("/onchain/")) {
      if (request.method === "POST" && !originAllowed(request, env)) {
        return Response.json({ error: "origin not allowed" }, { status: 403 });
      }
      const wrapped = new Request(request.url, request);
      wrapped.headers.set("X-Rork-DO-Class", "OnChainScanner");
      wrapped.headers.set("X-Rork-DO-Id", "global");
      return env.DO.fetch(wrapped);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
