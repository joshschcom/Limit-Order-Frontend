import { formatUnits } from "viem";
import type { Candle, OrderRecord, PairConfig, TradePrint } from "@seltra/sdk";

export const ALLOWED_INTERVALS = new Set([60, 300, 900, 3600, 14_400, 86_400]);

/**
 * Effective fill price in quote-per-base, improvement included: what actually
 * changed hands, not the limit. Sellers receive taking + improvement (quote);
 * buyers receive taking + improvement (base) for their making (quote).
 */
export function effectiveFillPrice(record: OrderRecord, pair: PairConfig): { price: number; baseVolume: number } | null {
  if (!record.fill) return null;
  const improvement = BigInt(record.fill.makerImprovement);
  if (record.side === "sell") {
    const base = Number(formatUnits(BigInt(record.order.makingAmount), pair.baseDecimals));
    const quote = Number(formatUnits(BigInt(record.order.takingAmount) + improvement, pair.quoteDecimals));
    if (base <= 0) return null;
    return { price: quote / base, baseVolume: base };
  }
  const quote = Number(formatUnits(BigInt(record.order.makingAmount), pair.quoteDecimals));
  const base = Number(formatUnits(BigInt(record.order.takingAmount) + improvement, pair.baseDecimals));
  if (base <= 0) return null;
  return { price: quote / base, baseVolume: base };
}

/**
 * A P2P settlement fills two maker orders in one trade; counting both legs
 * would double the tape and the volume. Keep one record per settlement tx,
 * preferring the sell leg so prints read in quote-per-base seller terms.
 * (Assumes one P2P event per tx, which holds for the current settlement.)
 */
export function dedupeSettlements(records: OrderRecord[]): OrderRecord[] {
  const byTx = new Map<string, OrderRecord>();
  const out: OrderRecord[] = [];
  for (const record of records) {
    if (record.fill?.path !== "p2p") {
      out.push(record);
      continue;
    }
    const existing = byTx.get(record.fill.txHash);
    if (!existing) {
      byTx.set(record.fill.txHash, record);
      out.push(record);
    } else if (existing.side !== "sell" && record.side === "sell") {
      out[out.indexOf(existing)] = record;
      byTx.set(record.fill.txHash, record);
    }
  }
  return out;
}

/** Venue tape: one print per settlement, newest first. */
export function buildTrades(records: OrderRecord[], pair: PairConfig, limit: number): TradePrint[] {
  return dedupeSettlements(records)
    .filter((record) => record.fill)
    .map((record): TradePrint | null => {
      const priced = effectiveFillPrice(record, pair);
      if (!priced) return null;
      return {
        time: record.fill!.timestamp,
        price: priced.price,
        size: priced.baseVolume,
        side: record.side,
        path: record.fill!.path,
        txHash: record.fill!.txHash,
        orderHash: record.orderHash,
      };
    })
    .filter((print): print is TradePrint => print !== null)
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

/** Aggregates enriched fills into OHLCV buckets. Fills only — no synthetic candles. */
export function buildCandles(records: OrderRecord[], pair: PairConfig, intervalSeconds: number): Candle[] {
  const fills = dedupeSettlements(records)
    .filter((record) => record.fill)
    .map((record) => ({ record, priced: effectiveFillPrice(record, pair) }))
    .filter((entry): entry is { record: OrderRecord & { fill: NonNullable<OrderRecord["fill"]> }; priced: NonNullable<ReturnType<typeof effectiveFillPrice>> } => entry.priced !== null)
    .sort((a, b) => a.record.fill.timestamp - b.record.fill.timestamp);

  const buckets = new Map<number, Candle>();
  for (const { record, priced } of fills) {
    const bucket = Math.floor(record.fill.timestamp / intervalSeconds) * intervalSeconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        open: priced.price,
        high: priced.price,
        low: priced.price,
        close: priced.price,
        volume: priced.baseVolume,
      });
    } else {
      existing.high = Math.max(existing.high, priced.price);
      existing.low = Math.min(existing.low, priced.price);
      existing.close = priced.price;
      existing.volume += priced.baseVolume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
