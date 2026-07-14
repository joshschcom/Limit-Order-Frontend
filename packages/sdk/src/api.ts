import type { Address, Hex } from "viem";
import type {
  BookLevel,
  BookMsg,
  BookSnapshot,
  BookWireMsg,
  Candle,
  ClientMsg,
  ExecutableQuote,
  LevelChange,
  OrderRecord,
  OrderStatus,
  ProtocolStats,
  QuotePoint,
  TradePrint,
  ServerMsg,
  SignedOrder,
  UserMsg,
} from "./types";
import { serializeSignedOrder } from "./serialize";

export type Unsubscribe = () => void;
export type ConnectionStatus = "connecting" | "open" | "closed";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
/** Server heartbeats every 15s; treat the socket as dead after missing two. */
const STALE_AFTER_MS = 35_000;

export class SeltraApi {
  private ws: WebSocket | null = null;
  private wsStatus: ConnectionStatus = "closed";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private channels = new Map<string, Set<(msg: ServerMsg | BookMsg) => void>>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  /** Per-pair book assembly state: diffs apply against this, keyed by wire seq. */
  private bookState = new Map<string, { seq: number; bids: Map<number, number>; asks: Map<number, number> }>();
  private disposed = false;

  constructor(private readonly cfg: { restUrl: string; wsUrl: string }) {}

  // --- REST ---

  async submitOrder(signed: SignedOrder): Promise<{ orderHash: Hex; status: OrderStatus }> {
    const response = await fetch(`${this.cfg.restUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeSignedOrder(signed)),
    });
    const body = (await response.json()) as { orderHash?: Hex; status?: OrderStatus; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Order rejected");
    if (!body.orderHash) throw new Error("Malformed API response");
    return { orderHash: body.orderHash, status: body.status ?? "resting" };
  }

  async getOrders(q: { maker?: Address; pair?: string; status?: OrderStatus } = {}): Promise<OrderRecord[]> {
    const params = new URLSearchParams();
    if (q.maker) params.set("maker", q.maker);
    if (q.pair) params.set("pair", q.pair);
    if (q.status) params.set("status", q.status);
    const qs = params.size > 0 ? `?${params}` : "";
    const response = await fetch(`${this.cfg.restUrl}/orders${qs}`);
    if (!response.ok) throw new Error(`Orders request failed (${response.status})`);
    return (await response.json()) as OrderRecord[];
  }

  async getOrder(orderHash: string): Promise<OrderRecord | null> {
    const response = await fetch(`${this.cfg.restUrl}/orders/${orderHash}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Order request failed (${response.status})`);
    return (await response.json()) as OrderRecord;
  }

  async getOrderbook(pair: string): Promise<BookSnapshot> {
    const response = await fetch(`${this.cfg.restUrl}/orderbook/${pair}`);
    if (!response.ok) throw new Error(`Orderbook request failed (${response.status})`);
    return (await response.json()) as BookSnapshot;
  }

  async getCandles(pair: string, intervalSeconds: number): Promise<Candle[]> {
    const response = await fetch(`${this.cfg.restUrl}/candles/${pair}?interval=${intervalSeconds}`);
    if (!response.ok) throw new Error(`Candles request failed (${response.status})`);
    return (await response.json()) as Candle[];
  }

  /** Live executable price from the router; null when no venue has liquidity. */
  async getQuote(pair: string): Promise<ExecutableQuote | null> {
    const response = await fetch(`${this.cfg.restUrl}/quote/${pair}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Quote request failed (${response.status})`);
    return (await response.json()) as ExecutableQuote;
  }

  /** Observed router-quote samples since `fromMs` (default: server-side 24h). */
  async getQuoteHistory(pair: string, fromMs?: number): Promise<QuotePoint[]> {
    const qs = fromMs ? `?from=${fromMs}` : "";
    const response = await fetch(`${this.cfg.restUrl}/quote-history/${pair}${qs}`);
    if (!response.ok) throw new Error(`Quote history request failed (${response.status})`);
    return (await response.json()) as QuotePoint[];
  }

  /** Recent settled fills on the venue tape, newest first. */
  async getTrades(pair: string, limit = 50): Promise<TradePrint[]> {
    const response = await fetch(`${this.cfg.restUrl}/trades/${pair}?limit=${limit}`);
    if (!response.ok) throw new Error(`Trades request failed (${response.status})`);
    return (await response.json()) as TradePrint[];
  }

  async getStats(): Promise<ProtocolStats> {
    const response = await fetch(`${this.cfg.restUrl}/stats`);
    if (!response.ok) throw new Error(`Stats request failed (${response.status})`);
    return (await response.json()) as ProtocolStats;
  }

  /** Off-chain soft-hide only, non-authoritative. Real cancellation is on-chain. */
  async softCancel(orderHash: Hex): Promise<void> {
    const response = await fetch(`${this.cfg.restUrl}/orders/${orderHash}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Soft cancel failed (${response.status})`);
  }

  /** Asks the API to re-derive an order's status from chain state right now (post-cancel). */
  async reconcile(orderHash: Hex): Promise<OrderRecord> {
    const response = await fetch(`${this.cfg.restUrl}/orders/${orderHash}/reconcile`, { method: "POST" });
    if (!response.ok) throw new Error(`Reconcile failed (${response.status})`);
    return (await response.json()) as OrderRecord;
  }

  // --- WebSocket ---

  subscribeBook(pair: string, cb: (msg: BookMsg) => void): Unsubscribe {
    return this.subscribe(`book:${pair}`, (msg) => {
      if (msg.type === "book.snapshot" || msg.type === "book.update") cb(msg as BookMsg);
    });
  }

  subscribeUser(addr: Address, cb: (msg: UserMsg) => void): Unsubscribe {
    return this.subscribe(`user:${addr.toLowerCase()}`, (msg) => {
      if (msg.type === "user.order") cb(msg);
    });
  }

  onStatus(cb: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    cb(this.wsStatus);
    return () => this.statusListeners.delete(cb);
  }

  get status(): ConnectionStatus {
    return this.wsStatus;
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.ws?.close();
    this.channels.clear();
    this.bookState.clear();
    this.statusListeners.clear();
  }

  private subscribe(channel: string, cb: (msg: ServerMsg | BookMsg) => void): Unsubscribe {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
      this.send({ type: "subscribe", channel });
    }
    subs.add(cb);
    this.ensureConnected();
    return () => {
      subs.delete(cb);
      if (subs.size === 0) {
        this.channels.delete(channel);
        if (channel.startsWith("book:")) this.bookState.delete(channel.slice("book:".length));
        this.send({ type: "unsubscribe", channel });
      }
    };
  }

  /** Applies a wire book message to local assembly state; null = drop (resnapshot requested). */
  private assembleBook(msg: BookWireMsg): BookMsg | null {
    if (msg.type === "book.snapshot") {
      this.bookState.set(msg.pair, {
        seq: msg.seq,
        bids: new Map(msg.book.bids.map((level) => [level.price, level.size])),
        asks: new Map(msg.book.asks.map((level) => [level.price, level.size])),
      });
      return { v: 1, type: "book.snapshot", pair: msg.pair, book: msg.book };
    }
    const state = this.bookState.get(msg.pair);
    if (!state || msg.seq !== state.seq + 1) {
      // Sequence gap — never guess at the book: resubscribe for a fresh snapshot.
      this.bookState.delete(msg.pair);
      this.send({ type: "subscribe", channel: `book:${msg.pair}` });
      return null;
    }
    state.seq = msg.seq;
    applyLevelChanges(state.bids, msg.bids);
    applyLevelChanges(state.asks, msg.asks);
    return {
      v: 1,
      type: "book.update",
      pair: msg.pair,
      book: {
        pair: msg.pair,
        bids: toSortedLevels(state.bids, true),
        asks: toSortedLevels(state.asks, false),
        ts: msg.ts,
      },
    };
  }

  private ensureConnected() {
    if (this.disposed || typeof WebSocket === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus("connecting");
    const ws = new WebSocket(this.cfg.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      // Resubscribe: the server sends a fresh snapshot per channel on subscribe.
      for (const channel of this.channels.keys()) {
        ws.send(JSON.stringify({ type: "subscribe", channel } satisfies ClientMsg));
      }
      this.bumpStaleTimer();
    };
    ws.onmessage = (event) => {
      this.bumpStaleTimer();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "heartbeat") return;
      if (msg.type === "book.snapshot" || msg.type === "book.diff") {
        const assembled = this.assembleBook(msg);
        if (assembled) this.channels.get(`book:${msg.pair}`)?.forEach((cb) => cb(assembled));
        return;
      }
      this.channels.get(`user:${(msg as UserMsg).order.order.maker.toLowerCase()}`)?.forEach((cb) => cb(msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect() {
    if (this.disposed || this.channels.size === 0 || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private bumpStaleTimer() {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      // No heartbeat: force-close so onclose triggers the reconnect path.
      this.ws?.close();
    }, STALE_AFTER_MS);
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(status: ConnectionStatus) {
    if (this.wsStatus === status) return;
    this.wsStatus = status;
    this.statusListeners.forEach((cb) => cb(status));
  }
}

function applyLevelChanges(levels: Map<number, number>, changes: LevelChange[]) {
  for (const { price, size } of changes) {
    if (size === 0) levels.delete(price);
    else levels.set(price, size);
  }
}

function toSortedLevels(levels: Map<number, number>, descending: boolean): BookLevel[] {
  const sorted = [...levels.entries()].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  let total = 0;
  return sorted.map(([price, size]) => {
    total += size;
    return { price, size, total };
  });
}
