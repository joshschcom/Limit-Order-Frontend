import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  deserializeSignedOrder,
  hashOrder,
  pairForOrder,
  serializeSignedOrder,
  verifySignedOrderPure,
  type OrderRecord,
  type OrderStatus,
  type SignedOrderJson,
} from "@seltra/sdk";
import { buildBook, priceAndSize } from "./book";
import { ALLOWED_INTERVALS, buildCandles, buildTrades } from "./candles";
import { ChainIndexer } from "./chain";
import { config, pairById } from "./config";
import { parseVenues, QuoteService } from "./quote";
import { OrderStore } from "./store";
import { StreamHub } from "./ws";

const store = new OrderStore(config.dbFile, {
  ordersJson: config.dataFile,
  checkpointJson: config.checkpointFile,
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": config.corsOrigin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

/**
 * Sliding-window per-IP rate limiter. In-memory is fine: limits are per
 * instance and the service runs as a single process (like the SQLite store).
 */
class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [key, times] of this.hits) {
      const recent = times.filter((ts) => now - ts < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

const submitLimiter = new RateLimiter(config.submitPerMinute);
const requestLimiter = new RateLimiter(config.requestsPerMinute);
setInterval(() => {
  submitLimiter.sweep();
  requestLimiter.sweep();
}, 300_000).unref();

/** Client IP, trusting x-forwarded-for only for the first hop (set by our reverse proxy). */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleSubmit(req: IncomingMessage, res: ServerResponse) {
  let signed;
  try {
    const body = JSON.parse(await readBody(req)) as SignedOrderJson;
    signed = deserializeSignedOrder(body);
  } catch {
    return json(res, 400, { error: "Malformed order payload", code: "BadPayload" });
  }
  const orderHash = hashOrder(signed.order);
  const existing = store.get(orderHash);
  // Idempotent by orderHash: a refresh mid-submit can never duplicate an order.
  if (existing) return json(res, 200, { orderHash, status: existing.status });

  const verdict = await verifySignedOrderPure(
    {
      chainId: config.chainId,
      permit2: config.permit2,
      settlement: config.settlement,
      maxExpirySeconds: config.maxExpirySeconds,
    },
    signed,
    { allowedPairs: config.pairs },
  );
  if (verdict !== true) return json(res, 400, { error: verdict.userMessage, code: verdict.code });

  const match = pairForOrder(config.pairs, signed.order.makerAsset, signed.order.takerAsset);
  if (!match) return json(res, 400, { error: "Pair not supported", code: "PairNotSupported" });

  const now = Date.now();
  const record: OrderRecord = {
    ...serializeSignedOrder(signed),
    orderHash,
    chainId: config.chainId,
    pair: match.pair.id,
    side: match.side,
    price: "0",
    baseAmount: "0",
    status: "resting",
    softCancelled: false,
    createdAt: now,
    updatedAt: now,
  };
  const { price, size } = priceAndSize(record, match.pair);
  record.price = price.toFixed(Math.max(match.pair.pricePrecision, 6));
  record.baseAmount = size.toString();

  store.upsert(record);
  hub.broadcastBook(match.pair.id, buildBook(store.restingForPair(match.pair.id), match.pair));
  hub.broadcastUserOrder(record);
  return json(res, 201, { orderHash, status: record.status });
}

function handleSoftCancel(res: ServerResponse, hash: string) {
  const record = store.get(hash);
  if (!record) return json(res, 404, { error: "Order not found" });
  record.softCancelled = true;
  record.updatedAt = Date.now();
  store.upsert(record);
  const pair = pairById(record.pair);
  if (pair) hub.broadcastBook(pair.id, buildBook(store.restingForPair(pair.id), pair));
  hub.broadcastUserOrder(record);
  return json(res, 200, { orderHash: record.orderHash, softCancelled: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, ts: Date.now() });
    const ip = clientIp(req);
    if (!requestLimiter.allow(ip)) return json(res, 429, { error: "Too many requests", code: "RateLimited" });
    if (req.method === "POST" && path === "/orders") {
      if (!submitLimiter.allow(`submit:${ip}`)) {
        return json(res, 429, { error: "Too many order submissions — slow down", code: "RateLimited" });
      }
      return await handleSubmit(req, res);
    }
    if (req.method === "GET" && path === "/orders") {
      return json(res, 200, store.list({
        maker: url.searchParams.get("maker") ?? undefined,
        pair: url.searchParams.get("pair") ?? undefined,
        status: (url.searchParams.get("status") as OrderStatus | null) ?? undefined,
      }));
    }
    const reconcileMatch = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})\/reconcile$/);
    if (req.method === "POST" && reconcileMatch) {
      if (!indexer) return json(res, 503, { error: "Reconciliation unavailable: settlement not configured" });
      const record = store.get(reconcileMatch[1]);
      if (!record) return json(res, 404, { error: "Order not found" });
      return json(res, 200, await indexer.reconcileOrder(record));
    }
    const orderMatch = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})$/);
    if (orderMatch) {
      if (req.method === "GET") {
        const record = store.get(orderMatch[1]);
        return record ? json(res, 200, record) : json(res, 404, { error: "Order not found" });
      }
      if (req.method === "DELETE") return handleSoftCancel(res, orderMatch[1]);
    }
    const bookMatch = path.match(/^\/orderbook\/([A-Za-z0-9.-]+)$/);
    if (req.method === "GET" && bookMatch) {
      const pair = pairById(bookMatch[1]);
      if (!pair) return json(res, 404, { error: "Pair not supported" });
      return json(res, 200, buildBook(store.restingForPair(pair.id), pair));
    }
    const candlesMatch = path.match(/^\/candles\/([A-Za-z0-9.-]+)$/);
    if (req.method === "GET" && candlesMatch) {
      const pair = pairById(candlesMatch[1]);
      if (!pair) return json(res, 404, { error: "Pair not supported" });
      const interval = Number(url.searchParams.get("interval") ?? "3600");
      if (!ALLOWED_INTERVALS.has(interval)) return json(res, 400, { error: "Unsupported interval" });
      return json(res, 200, buildCandles(store.list({ pair: pair.id, status: "filled" }), pair, interval));
    }
    const quoteMatch = path.match(/^\/quote\/([A-Za-z0-9.-]+)$/);
    if (req.method === "GET" && quoteMatch) {
      const pair = pairById(quoteMatch[1]);
      if (!pair) return json(res, 404, { error: "Pair not supported" });
      const quote = quotes.get(pair.id);
      return quote ? json(res, 200, quote) : json(res, 404, { error: "No executable quote available" });
    }
    const tradesMatch = path.match(/^\/trades\/([A-Za-z0-9.-]+)$/);
    if (req.method === "GET" && tradesMatch) {
      const pair = pairById(tradesMatch[1]);
      if (!pair) return json(res, 404, { error: "Pair not supported" });
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      return json(res, 200, buildTrades(store.list({ pair: pair.id, status: "filled" }), pair, limit));
    }
    const quoteHistoryMatch = path.match(/^\/quote-history\/([A-Za-z0-9.-]+)$/);
    if (req.method === "GET" && quoteHistoryMatch) {
      const pair = pairById(quoteHistoryMatch[1]);
      if (!pair) return json(res, 404, { error: "Pair not supported" });
      const from = Number(url.searchParams.get("from") ?? Date.now() - 86_400_000);
      return json(res, 200, quotes.getHistory(pair.id, from));
    }
    if (req.method === "GET" && path === "/stats") return json(res, 200, store.stats());
    // Operational metrics for monitoring/alerting; not part of the public API surface.
    if (req.method === "GET" && path === "/metrics") {
      const byStatus: Record<string, number> = {};
      for (const record of store.list()) byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
      const quote = quotes.get(config.pairs[0].id);
      return json(res, 200, {
        ok: true,
        uptimeSeconds: Math.floor(process.uptime()),
        wsClients: hub.clientCount,
        orders: byStatus,
        checkpoint: store.getCheckpoint()?.toString() ?? null,
        eventsApplied: store.eventCount(),
        indexing: indexer !== null,
        quoteAgeMs: quote ? Date.now() - quote.ts : null,
      });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(req.method, path, error);
    return json(res, 500, { error: "Internal error" });
  }
});

const hub = new StreamHub(server, store);
const quotes = new QuoteService(parseVenues(config.venuesRaw));
quotes.start();

function notifyRecordChanged(record: OrderRecord) {
  hub.broadcastUserOrder(record);
  const pair = pairById(record.pair);
  if (pair) hub.broadcastBook(pair.id, buildBook(store.restingForPair(pair.id), pair));
}

let indexer: ChainIndexer | null = null;
if (config.settlement !== "0x0000000000000000000000000000000000000000") {
  indexer = new ChainIndexer(store, notifyRecordChanged);
  indexer.start();
  console.log(`indexing settlement events from ${config.settlement} via ${config.rpcUrl}`);
  setInterval(() => {
    const open = store.list().filter((record) => record.status === "resting" || record.status === "unfillable");
    if (open.length > 0) void indexer!.sweepNonces(open);
  }, 30_000).unref();
} else {
  console.warn("SETTLEMENT not configured — fill/cancel reconciliation disabled");
}

setInterval(() => {
  const changed = store.sweepExpired(Math.floor(Date.now() / 1000));
  if (changed.length === 0) return;
  for (const record of changed) hub.broadcastUserOrder(record);
  for (const pairId of new Set(changed.map((record) => record.pair))) {
    const pair = pairById(pairId);
    if (pair) hub.broadcastBook(pairId, buildBook(store.restingForPair(pairId), pair));
  }
}, config.expirySweepMs).unref();

server.listen(config.port, () => {
  console.log(`seltra orderbook-api listening on :${config.port} (chain ${config.chainId})`);
});
