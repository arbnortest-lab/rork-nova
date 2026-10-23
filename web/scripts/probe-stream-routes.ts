/**
 * Which Binance futures socket route delivers which stream?
 *
 * Since March 2026 the venue serves `/public` (depth, bookTicker, trade) and
 * `/market` (aggTrade, markPrice, kline, forceOrder, tickers) on separate
 * routed endpoints, and an unrouted connection acknowledges every stream but
 * only delivers the public group. This probe subscribes the same stream list
 * on each endpoint and counts what actually arrives, so a routing change can
 * be spotted in seconds instead of debugging an empty tape.
 *
 *   bun scripts/probe-stream-routes.ts            # BTCUSDT, 8 s per endpoint
 *   bun scripts/probe-stream-routes.ts vetusdt 12 # another symbol, longer
 */

const symbol = (process.argv[2] ?? "btcusdt").toLowerCase();
const seconds = Number.parseFloat(process.argv[3] ?? "8") || 8;

const STREAMS = [
  `${symbol}@depth20@100ms`,
  `${symbol}@bookTicker`,
  `${symbol}@trade`,
  `${symbol}@aggTrade`,
  `${symbol}@markPrice@1s`,
  `${symbol}@kline_1m`,
  "!forceOrder@arr",
  "!ticker@arr",
];

const ENDPOINTS = [
  "wss://fstream.binance.com/public/stream",
  "wss://fstream.binance.com/market/stream",
  "wss://fstream.binance.com/stream",
];

interface Envelope {
  stream?: string;
  data?: unknown;
  id?: number;
  result?: unknown;
  error?: unknown;
}

function probe(url: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const counts = new Map<string, number>();
    let acked = false;
    ws.onopen = () => ws.send(JSON.stringify({ method: "SUBSCRIBE", params: STREAMS, id: 1 }));
    ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as Envelope;
      if (m.id === 1) {
        acked = m.error === undefined;
        return;
      }
      const name = m.stream ?? "(raw)";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    ws.onerror = () => console.log(`${url}\n  error`);
    setTimeout(() => {
      console.log(`${url}\n  subscribe ${acked ? "acknowledged" : "NOT acknowledged"}`);
      for (const s of STREAMS) {
        const n = counts.get(s) ?? 0;
        console.log(`  ${n ? "delivers" : "silent  "}  ${s.padEnd(26)} ${n ? `${n} frames` : ""}`);
      }
      ws.close();
      resolve();
    }, seconds * 1000);
  });
}

for (const url of ENDPOINTS) await probe(url);
process.exit(0);
