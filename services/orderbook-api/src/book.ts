import { formatUnits } from "viem";
import type { BookLevel, BookSnapshot, LevelChange, OrderRecord, PairConfig } from "@seltra/sdk";

export function priceAndSize(record: OrderRecord, pair: PairConfig): { price: number; size: number } {
  const making = BigInt(record.order.makingAmount);
  const taking = BigInt(record.order.takingAmount);
  if (record.side === "sell") {
    // Maker sells base: price = quote taken / base given.
    const size = Number(formatUnits(making, pair.baseDecimals));
    const quote = Number(formatUnits(taking, pair.quoteDecimals));
    return { price: quote / size, size };
  }
  // Maker buys base with quote: price = quote given / base taken.
  const size = Number(formatUnits(taking, pair.baseDecimals));
  const quote = Number(formatUnits(making, pair.quoteDecimals));
  return { price: quote / size, size };
}

export function buildBook(records: OrderRecord[], pair: PairConfig): BookSnapshot {
  const bidLevels = new Map<number, number>();
  const askLevels = new Map<number, number>();
  for (const record of records) {
    const { price, size } = priceAndSize(record, pair);
    if (!Number.isFinite(price) || price <= 0 || size <= 0) continue;
    const level = Number(price.toFixed(pair.pricePrecision));
    const target = record.side === "buy" ? bidLevels : askLevels;
    target.set(level, (target.get(level) ?? 0) + size);
  }
  const toLevels = (map: Map<number, number>, descending: boolean): BookLevel[] => {
    const sorted = [...map.entries()].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
    let total = 0;
    return sorted.map(([price, size]) => {
      total += size;
      return { price, size, total };
    });
  };
  return {
    pair: pair.id,
    bids: toLevels(bidLevels, true),
    asks: toLevels(askLevels, false),
    ts: Date.now(),
  };
}

/** Levels that changed between two books: new absolute size, or size 0 for removed. */
export function diffBookLevels(prev: BookSnapshot, next: BookSnapshot): { bids: LevelChange[]; asks: LevelChange[] } {
  const side = (before: BookLevel[], after: BookLevel[]): LevelChange[] => {
    const remaining = new Map(before.map((level) => [level.price, level.size]));
    const changes: LevelChange[] = [];
    for (const level of after) {
      if (remaining.get(level.price) !== level.size) changes.push({ price: level.price, size: level.size });
      remaining.delete(level.price);
    }
    for (const price of remaining.keys()) changes.push({ price, size: 0 });
    return changes;
  };
  return { bids: side(prev.bids, next.bids), asks: side(prev.asks, next.asks) };
}
