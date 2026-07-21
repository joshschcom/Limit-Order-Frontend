import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OrderRecord, OrderStatus, ProtocolStats, QuotePoint } from "@seltra/sdk";
import pg from "pg";
import { formatUnits } from "viem";
import { dedupeSettlements } from "./candles";
import { config } from "./config";

const PG_SCHEMA = "seltra_orderbook";

export interface LegacyFiles {
  ordersJson?: string;
  checkpointJson?: string;
  quoteHistoryJson?: string;
}

export interface StoreSnapshot {
  orders: OrderRecord[];
  events: { txHash: string; logIndex: number }[];
  meta: Record<string, string>;
  quotes: { pairId: string; point: QuotePoint }[];
}

export interface OrderStore {
  readonly backend: "sqlite" | "postgres";
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): Promise<void>;
  getCheckpoint(): bigint | null;
  setCheckpoint(block: bigint): Promise<void>;
  isEventApplied(txHash: string, logIndex: number): boolean;
  markEventApplied(txHash: string, logIndex: number): Promise<void>;
  eventCount(): number;
  get(orderHash: string): OrderRecord | undefined;
  upsert(record: OrderRecord): Promise<void>;
  list(filter?: { maker?: string; pair?: string; status?: OrderStatus }): OrderRecord[];
  restingForPair(pair: string): OrderRecord[];
  sweepExpired(nowSeconds: number): Promise<OrderRecord[]>;
  cancelBelowEpoch(maker: string, newEpoch: bigint): Promise<OrderRecord[]>;
  getQuoteHistory(pairId: string, fromMs?: number): QuotePoint[];
  appendQuote(pairId: string, point: QuotePoint): Promise<void>;
  stats(): ProtocolStats;
  snapshot(): StoreSnapshot;
  close(): Promise<void>;
}

interface StoreOptions {
  chainId: number;
  quoteHistoryMax: number;
}

/** Shared in-memory read model. Every mutation is persisted before its promise resolves. */
abstract class CachedOrderStore {
  protected readonly orders = new Map<string, OrderRecord>();
  protected readonly events = new Set<string>();
  protected readonly meta = new Map<string, string>();
  protected readonly quotes = new Map<string, QuotePoint[]>();

  abstract readonly backend: "sqlite" | "postgres";

  constructor(protected readonly options: StoreOptions) {}

  protected abstract persistMeta(key: string, value: string): Promise<void>;
  protected abstract persistEvent(txHash: string, logIndex: number): Promise<void>;
  protected abstract persistOrder(orderHash: string, recordJson: string): Promise<void>;
  protected abstract persistQuote(pairId: string, point: QuotePoint): Promise<void>;

  protected async bindChain(): Promise<void> {
    const stored = this.getMeta("chain_id");
    if (stored !== null && stored !== String(this.options.chainId)) {
      throw new Error(`database belongs to chain ${stored}, refusing chain ${this.options.chainId}`);
    }
    if (stored === null) await this.setMeta("chain_id", String(this.options.chainId));
  }

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.persistMeta(key, value);
    this.meta.set(key, value);
  }

  getCheckpoint(): bigint | null {
    const value = this.getMeta("checkpoint");
    return value === null ? null : BigInt(value);
  }

  async setCheckpoint(block: bigint): Promise<void> {
    await this.setMeta("checkpoint", block.toString());
  }

  isEventApplied(txHash: string, logIndex: number): boolean {
    return this.events.has(eventKey(txHash, logIndex));
  }

  async markEventApplied(txHash: string, logIndex: number): Promise<void> {
    const normalized = txHash.toLowerCase();
    await this.persistEvent(normalized, logIndex);
    this.events.add(eventKey(normalized, logIndex));
  }

  eventCount(): number {
    return this.events.size;
  }

  get(orderHash: string): OrderRecord | undefined {
    return this.orders.get(orderHash.toLowerCase());
  }

  async upsert(record: OrderRecord): Promise<void> {
    const key = record.orderHash.toLowerCase();
    const recordJson = JSON.stringify(record);
    await this.persistOrder(key, recordJson);
    this.orders.set(key, record);
  }

  list(filter: { maker?: string; pair?: string; status?: OrderStatus } = {}): OrderRecord[] {
    const maker = filter.maker?.toLowerCase();
    return [...this.orders.values()]
      .filter((record) => {
        if (maker && record.order.maker !== maker) return false;
        if (filter.pair && record.pair !== filter.pair) return false;
        if (filter.status && record.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  restingForPair(pair: string): OrderRecord[] {
    return [...this.orders.values()].filter(
      (record) => record.pair === pair && record.status === "resting" && !record.softCancelled,
    );
  }

  async sweepExpired(nowSeconds: number): Promise<OrderRecord[]> {
    const changed: OrderRecord[] = [];
    for (const record of this.orders.values()) {
      if (record.status === "resting" && Number(record.order.expiry) <= nowSeconds) {
        record.status = "expired";
        record.updatedAt = Date.now();
        await this.upsert(record);
        changed.push(record);
      }
    }
    return changed;
  }

  async cancelBelowEpoch(maker: string, newEpoch: bigint): Promise<OrderRecord[]> {
    const changed: OrderRecord[] = [];
    for (const record of this.orders.values()) {
      if (
        record.order.maker === maker.toLowerCase() &&
        (record.status === "resting" || record.status === "unfillable") &&
        BigInt(record.order.epoch) < newEpoch
      ) {
        record.status = "cancelled";
        record.updatedAt = Date.now();
        await this.upsert(record);
        changed.push(record);
      }
    }
    return changed;
  }

  getQuoteHistory(pairId: string, fromMs?: number): QuotePoint[] {
    const points = this.quotes.get(pairId) ?? [];
    return fromMs === undefined ? [...points] : points.filter((point) => point.t >= fromMs);
  }

  async appendQuote(pairId: string, point: QuotePoint): Promise<void> {
    await this.persistQuote(pairId, point);
    let points = this.quotes.get(pairId);
    if (!points) {
      points = [];
      this.quotes.set(pairId, points);
    }
    const existing = points.findIndex((candidate) => candidate.t === point.t);
    if (existing >= 0) points[existing] = point;
    else points.push(point);
    points.sort((a, b) => a.t - b.t);
    if (points.length > this.options.quoteHistoryMax) {
      points.splice(0, points.length - this.options.quoteHistoryMax);
    }
  }

  stats() {
    const records = [...this.orders.values()];
    const filled = records.filter((record) => record.status === "filled");
    const volume = dedupeSettlements(filled).reduce((sum, record) => {
      const quoteAmount = record.side === "buy" ? record.order.makingAmount : record.order.takingAmount;
      return sum + BigInt(quoteAmount);
    }, 0n);
    const improvements = filled
      .filter((record) => record.fill)
      .map((record) => {
        const taking = BigInt(record.order.takingAmount);
        if (taking === 0n) return 0;
        return Number((BigInt(record.fill!.makerImprovement) * 10_000n) / taking);
      });
    const p2pFills = filled.filter((record) => record.fill?.path === "p2p").length;
    return {
      totalVolumeQuote: formatUnits(volume, config.pairs[0].quoteDecimals),
      ordersFilled: filled.length,
      ordersResting: records.filter((record) => record.status === "resting" && !record.softCancelled).length,
      avgImprovementBps:
        improvements.length > 0
          ? Math.round(improvements.reduce((sum, bps) => sum + bps, 0) / improvements.length)
          : null,
      p2pMatchRateBps: filled.length > 0 ? Math.round((p2pFills / filled.length) * 10_000) : null,
    };
  }

  snapshot(): StoreSnapshot {
    return {
      orders: this.list().map((record) => JSON.parse(JSON.stringify(record)) as OrderRecord),
      events: [...this.events]
        .map(parseEventKey)
        .sort((a, b) => a.txHash.localeCompare(b.txHash) || a.logIndex - b.logIndex),
      meta: Object.fromEntries([...this.meta].sort(([a], [b]) => a.localeCompare(b))),
      quotes: [...this.quotes]
        .flatMap(([pairId, points]) => points.map((point) => ({ pairId, point: { ...point } })))
        .sort((a, b) => a.pairId.localeCompare(b.pairId) || a.point.t - b.point.t),
    };
  }
}

export class SqliteOrderStore extends CachedOrderStore implements OrderStore {
  readonly backend = "sqlite" as const;

  private constructor(private readonly db: DatabaseSync, options: StoreOptions) {
    super(options);
  }

  static async open(dbFile: string, options: StoreOptions, legacy: LegacyFiles = {}): Promise<SqliteOrderStore> {
    mkdirSync(dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (order_hash TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_log (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quote_history (
        pair_id TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        price REAL NOT NULL,
        PRIMARY KEY (pair_id, observed_at_ms)
      );
    `);
    const store = new SqliteOrderStore(db, options);
    try {
      store.load();
      await store.bindChain();
      await store.importLegacy(legacy);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private load() {
    for (const row of this.db.prepare("SELECT order_hash, record FROM orders").all() as {
      order_hash: string;
      record: string;
    }[]) {
      this.orders.set(row.order_hash.toLowerCase(), JSON.parse(row.record) as OrderRecord);
    }
    for (const row of this.db.prepare("SELECT tx_hash, log_index FROM event_log").all() as {
      tx_hash: string;
      log_index: number;
    }[]) {
      this.events.add(eventKey(row.tx_hash, row.log_index));
    }
    for (const row of this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]) {
      this.meta.set(row.key, row.value);
    }
    for (const row of this.db
      .prepare("SELECT pair_id, observed_at_ms, price FROM quote_history ORDER BY pair_id, observed_at_ms")
      .all() as { pair_id: string; observed_at_ms: number; price: number }[]) {
      const points = this.quotes.get(row.pair_id) ?? [];
      points.push({ t: row.observed_at_ms, price: row.price });
      this.quotes.set(row.pair_id, points);
    }
  }

  private async importLegacy(legacy: LegacyFiles) {
    if (legacy.ordersJson && this.orders.size === 0 && existsSync(legacy.ordersJson)) {
      const records = JSON.parse(readFileSync(legacy.ordersJson, "utf8")) as OrderRecord[];
      for (const record of records) await this.upsert(record);
      console.log(`migrated ${records.length} order(s) from ${legacy.ordersJson}`);
    }
    if (legacy.checkpointJson && this.getMeta("checkpoint") === null && existsSync(legacy.checkpointJson)) {
      const { block } = JSON.parse(readFileSync(legacy.checkpointJson, "utf8")) as { block: string };
      await this.setMeta("checkpoint", block);
      console.log(`migrated checkpoint ${block} from ${legacy.checkpointJson}`);
    }
    if (legacy.quoteHistoryJson && this.quotes.size === 0 && existsSync(legacy.quoteHistoryJson)) {
      const history = JSON.parse(readFileSync(legacy.quoteHistoryJson, "utf8")) as Record<string, QuotePoint[]>;
      let count = 0;
      for (const [pairId, points] of Object.entries(history)) {
        for (const point of points.slice(-this.options.quoteHistoryMax)) {
          await this.appendQuote(pairId, point);
          count += 1;
        }
      }
      console.log(`migrated ${count} quote point(s) from ${legacy.quoteHistoryJson}`);
    }
  }

  protected async persistMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  protected async persistEvent(txHash: string, logIndex: number) {
    this.db.prepare("INSERT OR IGNORE INTO event_log (tx_hash, log_index) VALUES (?, ?)").run(txHash, logIndex);
  }

  protected async persistOrder(orderHash: string, recordJson: string) {
    this.db.prepare("INSERT OR REPLACE INTO orders (order_hash, record) VALUES (?, ?)").run(orderHash, recordJson);
  }

  protected async persistQuote(pairId: string, point: QuotePoint) {
    this.db
      .prepare("INSERT OR REPLACE INTO quote_history (pair_id, observed_at_ms, price) VALUES (?, ?, ?)")
      .run(pairId, point.t, point.price);
    this.db
      .prepare(`DELETE FROM quote_history WHERE pair_id = ? AND observed_at_ms IN (
        SELECT observed_at_ms FROM quote_history WHERE pair_id = ?
        ORDER BY observed_at_ms DESC LIMIT -1 OFFSET ?
      )`)
      .run(pairId, pairId, this.options.quoteHistoryMax);
  }

  async close() {
    this.db.close();
  }
}

export class PostgresOrderStore extends CachedOrderStore implements OrderStore {
  readonly backend = "postgres" as const;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(private readonly pool: pg.Pool, options: StoreOptions) {
    super(options);
  }

  static async open(databaseUrl: string, options: StoreOptions): Promise<PostgresOrderStore> {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return PostgresOrderStore.openPool(pool, options);
  }

  static async openPool(pool: pg.Pool, options: StoreOptions): Promise<PostgresOrderStore> {
    const store = new PostgresOrderStore(pool, options);
    try {
      await store.load();
      await store.bindChain();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  private async load() {
    const schema = await this.pool.query<{ orders: string | null }>(
      "SELECT to_regclass($1) AS orders",
      [`${PG_SCHEMA}.orders`],
    );
    if (!schema.rows[0]?.orders) {
      throw new Error("PostgreSQL schema is missing; apply services/orderbook-api/schema.postgres.sql first");
    }
    const [orders, events, meta, quotes] = await Promise.all([
      this.pool.query<{ order_hash: string; record: OrderRecord | string }>(
        `SELECT order_hash, record FROM ${PG_SCHEMA}.orders`,
      ),
      this.pool.query<{ tx_hash: string; log_index: number }>(
        `SELECT tx_hash, log_index FROM ${PG_SCHEMA}.event_log`,
      ),
      this.pool.query<{ key: string; value: string }>(`SELECT key, value FROM ${PG_SCHEMA}.meta`),
      this.pool.query<{ pair_id: string; observed_at_ms: string; price: number }>(
        `SELECT pair_id, observed_at_ms, price FROM ${PG_SCHEMA}.quote_history ORDER BY pair_id, observed_at_ms`,
      ),
    ]);
    for (const row of orders.rows) {
      const record = typeof row.record === "string" ? (JSON.parse(row.record) as OrderRecord) : row.record;
      this.orders.set(row.order_hash.toLowerCase(), record);
    }
    for (const row of events.rows) this.events.add(eventKey(row.tx_hash, row.log_index));
    for (const row of meta.rows) this.meta.set(row.key, row.value);
    for (const row of quotes.rows) {
      const points = this.quotes.get(row.pair_id) ?? [];
      points.push({ t: Number(row.observed_at_ms), price: row.price });
      this.quotes.set(row.pair_id, points);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  protected persistMeta(key: string, value: string) {
    return this.enqueue(async () => {
      await this.pool.query(
        `INSERT INTO ${PG_SCHEMA}.meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value],
      );
    });
  }

  protected persistEvent(txHash: string, logIndex: number) {
    return this.enqueue(async () => {
      await this.pool.query(
        `INSERT INTO ${PG_SCHEMA}.event_log (tx_hash, log_index) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [txHash, logIndex],
      );
    });
  }

  protected persistOrder(orderHash: string, recordJson: string) {
    return this.enqueue(async () => {
      await this.pool.query(
        `INSERT INTO ${PG_SCHEMA}.orders (order_hash, record) VALUES ($1, $2::jsonb)
         ON CONFLICT (order_hash) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
        [orderHash, recordJson],
      );
    });
  }

  protected persistQuote(pairId: string, point: QuotePoint) {
    return this.enqueue(async () => {
      await this.pool.query(
        `INSERT INTO ${PG_SCHEMA}.quote_history (pair_id, observed_at_ms, price) VALUES ($1, $2, $3)
         ON CONFLICT (pair_id, observed_at_ms) DO UPDATE SET price = EXCLUDED.price`,
        [pairId, point.t, point.price],
      );
      await this.pool.query(
        `DELETE FROM ${PG_SCHEMA}.quote_history WHERE pair_id = $1 AND observed_at_ms IN (
           SELECT observed_at_ms FROM ${PG_SCHEMA}.quote_history
           WHERE pair_id = $1 ORDER BY observed_at_ms DESC OFFSET $2
         )`,
        [pairId, this.options.quoteHistoryMax],
      );
    });
  }

  async importSnapshot(snapshot: StoreSnapshot): Promise<void> {
    await this.writes;
    const current = this.snapshot();
    const extraMeta = Object.keys(current.meta).filter((key) => key !== "chain_id");
    if (current.orders.length || current.events.length || current.quotes.length || extraMeta.length) {
      throw new Error("target PostgreSQL store is not empty; refusing to overwrite it");
    }
    const sourceChain = snapshot.meta.chain_id;
    if (sourceChain !== String(this.options.chainId)) {
      throw new Error(`source snapshot belongs to chain ${sourceChain ?? "unknown"}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const batch of chunks(snapshot.orders, 250)) {
        const values: unknown[] = [];
        const rows = batch.map((record, index) => {
          values.push(record.orderHash.toLowerCase(), JSON.stringify(record));
          return `($${index * 2 + 1}, $${index * 2 + 2}::jsonb)`;
        });
        await client.query(
          `INSERT INTO ${PG_SCHEMA}.orders (order_hash, record) VALUES ${rows.join(",")}
           ON CONFLICT (order_hash) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
          values,
        );
      }
      for (const batch of chunks(snapshot.events, 500)) {
        const values: unknown[] = [];
        const rows = batch.map((event, index) => {
          values.push(event.txHash.toLowerCase(), event.logIndex);
          return `($${index * 2 + 1}, $${index * 2 + 2})`;
        });
        await client.query(
          `INSERT INTO ${PG_SCHEMA}.event_log (tx_hash, log_index) VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
          values,
        );
      }
      for (const [key, value] of Object.entries(snapshot.meta)) {
        await client.query(
          `INSERT INTO ${PG_SCHEMA}.meta (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, value],
        );
      }
      for (const batch of chunks(snapshot.quotes, 400)) {
        const values: unknown[] = [];
        const rows = batch.map(({ pairId, point }, index) => {
          values.push(pairId, point.t, point.price);
          return `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`;
        });
        await client.query(
          `INSERT INTO ${PG_SCHEMA}.quote_history (pair_id, observed_at_ms, price) VALUES ${rows.join(",")}
           ON CONFLICT (pair_id, observed_at_ms) DO UPDATE SET price = EXCLUDED.price`,
          values,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.orders.clear();
    this.events.clear();
    this.meta.clear();
    this.quotes.clear();
    await this.load();
  }

  async close() {
    await this.writes;
    await this.pool.end();
  }
}

export async function createOrderStore(options: {
  databaseUrl?: string;
  dbFile: string;
  chainId: number;
  quoteHistoryMax: number;
  legacy?: LegacyFiles;
}): Promise<OrderStore> {
  const common = { chainId: options.chainId, quoteHistoryMax: options.quoteHistoryMax };
  return options.databaseUrl
    ? PostgresOrderStore.open(options.databaseUrl, common)
    : SqliteOrderStore.open(options.dbFile, common, options.legacy);
}

export function compareSnapshots(source: StoreSnapshot, target: StoreSnapshot): string[] {
  const errors: string[] = [];
  const sourceOrders = new Map(source.orders.map((record) => [record.orderHash.toLowerCase(), record]));
  const targetOrders = new Map(target.orders.map((record) => [record.orderHash.toLowerCase(), record]));
  if (sourceOrders.size !== targetOrders.size) errors.push(`orders: ${sourceOrders.size} != ${targetOrders.size}`);
  for (const [hash, record] of sourceOrders) {
    if (!isDeepStrictEqual(record, targetOrders.get(hash))) errors.push(`order mismatch: ${hash}`);
  }
  const sourceEvents = source.events.map((event) => eventKey(event.txHash, event.logIndex)).sort();
  const targetEvents = target.events.map((event) => eventKey(event.txHash, event.logIndex)).sort();
  if (!isDeepStrictEqual(sourceEvents, targetEvents)) errors.push("event log mismatch");
  if (!isDeepStrictEqual(source.meta, target.meta)) errors.push("metadata mismatch");
  if (!isDeepStrictEqual(source.quotes, target.quotes)) errors.push("quote history mismatch");
  return errors;
}

function eventKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

function parseEventKey(key: string): { txHash: string; logIndex: number } {
  const split = key.lastIndexOf(":");
  return { txHash: key.slice(0, split), logIndex: Number(key.slice(split + 1)) };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
