import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatUnits } from "viem";
import type { OrderRecord, OrderStatus } from "@seltra/sdk";
import { dedupeSettlements } from "./candles";
import { config } from "./config";

/**
 * SQLite-backed store (node:sqlite, WAL): orders, an event log for idempotent
 * ingestion, and indexer metadata. All reads serve from an in-memory cache;
 * every write lands in SQLite synchronously. Postgres replaces this at deploy
 * time behind the same interface (readiness plan §8).
 */
export class OrderStore {
  private db: DatabaseSync;
  private orders = new Map<string, OrderRecord>();

  constructor(dbFile: string, legacy?: { ordersJson?: string; checkpointJson?: string }) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        order_hash TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_log (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const row of this.db.prepare("SELECT record FROM orders").all() as { record: string }[]) {
      const record = JSON.parse(row.record) as OrderRecord;
      this.orders.set(record.orderHash.toLowerCase(), record);
    }
    this.importLegacy(legacy);
  }

  /** One-time migration from the file-store era. */
  private importLegacy(legacy?: { ordersJson?: string; checkpointJson?: string }) {
    if (legacy?.ordersJson && this.orders.size === 0 && existsSync(legacy.ordersJson)) {
      try {
        const records = JSON.parse(readFileSync(legacy.ordersJson, "utf8")) as OrderRecord[];
        for (const record of records) this.upsert(record);
        console.log(`migrated ${records.length} order(s) from ${legacy.ordersJson}`);
      } catch (error) {
        console.error("legacy order import failed", error);
      }
    }
    if (legacy?.checkpointJson && this.getMeta("checkpoint") === null && existsSync(legacy.checkpointJson)) {
      try {
        const { block } = JSON.parse(readFileSync(legacy.checkpointJson, "utf8")) as { block: string };
        this.setMeta("checkpoint", block);
        console.log(`migrated checkpoint ${block} from ${legacy.checkpointJson}`);
      } catch (error) {
        console.error("legacy checkpoint import failed", error);
      }
    }
  }

  // --- meta / indexer state ---

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getCheckpoint(): bigint | null {
    const value = this.getMeta("checkpoint");
    return value === null ? null : BigInt(value);
  }

  setCheckpoint(block: bigint) {
    this.setMeta("checkpoint", block.toString());
  }

  /** Idempotent ingestion: true when this exact log was already applied. */
  isEventApplied(txHash: string, logIndex: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM event_log WHERE tx_hash = ? AND log_index = ?").get(txHash.toLowerCase(), logIndex) !==
      undefined
    );
  }

  markEventApplied(txHash: string, logIndex: number) {
    this.db.prepare("INSERT OR IGNORE INTO event_log (tx_hash, log_index) VALUES (?, ?)").run(txHash.toLowerCase(), logIndex);
  }

  eventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number };
    return row.n;
  }

  // --- orders ---

  get(orderHash: string): OrderRecord | undefined {
    return this.orders.get(orderHash.toLowerCase());
  }

  upsert(record: OrderRecord) {
    const key = record.orderHash.toLowerCase();
    this.orders.set(key, record);
    this.db.prepare("INSERT OR REPLACE INTO orders (order_hash, record) VALUES (?, ?)").run(key, JSON.stringify(record));
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

  /** Resting, not soft-hidden: what the public book is built from. */
  restingForPair(pair: string): OrderRecord[] {
    return [...this.orders.values()].filter(
      (record) => record.pair === pair && record.status === "resting" && !record.softCancelled,
    );
  }

  /** Flip resting orders past expiry; returns the changed records. */
  sweepExpired(nowSeconds: number): OrderRecord[] {
    const changed: OrderRecord[] = [];
    for (const record of this.orders.values()) {
      if (record.status === "resting" && Number(record.order.expiry) <= nowSeconds) {
        record.status = "expired";
        record.updatedAt = Date.now();
        this.upsert(record);
        changed.push(record);
      }
    }
    return changed;
  }

  /** On-chain cancel-all: EpochIncremented invalidates all orders signed under older epochs. */
  cancelBelowEpoch(maker: string, newEpoch: bigint): OrderRecord[] {
    const changed: OrderRecord[] = [];
    for (const record of this.orders.values()) {
      if (
        record.order.maker === maker.toLowerCase() &&
        (record.status === "resting" || record.status === "unfillable") &&
        BigInt(record.order.epoch) < newEpoch
      ) {
        record.status = "cancelled";
        record.updatedAt = Date.now();
        this.upsert(record);
        changed.push(record);
      }
    }
    return changed;
  }

  stats() {
    const records = [...this.orders.values()];
    const filled = records.filter((record) => record.status === "filled");
    // Quote-side notional per settlement (P2P counted once, not per leg).
    const volume = dedupeSettlements(filled).reduce((sum, record) => {
      const quoteAmount = record.side === "buy" ? record.order.makingAmount : record.order.takingAmount;
      return sum + BigInt(quoteAmount);
    }, 0n);
    const improvements = filled
      .filter((record) => record.fill)
      .map((record) => {
        // Improvement is denominated in the maker's receive asset == takingAmount units.
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
}
