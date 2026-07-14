import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address } from "viem";
import type { ExecutableQuote, PairConfig, QuotePoint } from "@seltra/sdk";
import { config } from "./config";

const routerAbi = parseAbi([
  "function quote(uint8 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes extra) view returns (uint256 amountOut)",
]);

export interface VenueConfig {
  adapterId: number;
  name: string;
  extra: `0x${string}`;
}

/**
 * Polls the aggregation router for the executable sell-one-base price on every
 * configured venue and keeps the best. Venues whose quote reverts (no
 * liquidity, paused adapter) are skipped — absence of a quote is shown as
 * absence, never a made-up number.
 */
export class QuoteService {
  private client = createPublicClient({ transport: http(config.rpcUrl) });
  private quotes = new Map<string, ExecutableQuote>();
  private history = new Map<string, QuotePoint[]>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly venues: VenueConfig[]) {
    try {
      const raw = JSON.parse(readFileSync(config.quoteHistoryFile, "utf8")) as Record<string, QuotePoint[]>;
      for (const [pairId, points] of Object.entries(raw)) this.history.set(pairId, points);
    } catch {
      // First boot: no history yet.
    }
  }

  start() {
    if (this.venues.length === 0 || config.router === "0x0000000000000000000000000000000000000000") {
      console.warn("quote service disabled: no venues or router not configured");
      return;
    }
    void this.poll();
    setInterval(() => void this.poll(), config.quotePollMs).unref();
  }

  get(pairId: string): ExecutableQuote | null {
    return this.quotes.get(pairId) ?? null;
  }

  /** Observed quote samples, oldest first. Gaps mean no venue quoted — never interpolated. */
  getHistory(pairId: string, fromMs?: number): QuotePoint[] {
    const points = this.history.get(pairId) ?? [];
    return fromMs ? points.filter((point) => point.t >= fromMs) : points;
  }

  private record(pairId: string, quote: ExecutableQuote) {
    let points = this.history.get(pairId);
    if (!points) {
      points = [];
      this.history.set(pairId, points);
    }
    points.push({ t: quote.ts, price: quote.price });
    // Ring buffer: ~2 days at the 10s cadence. Durable market-data storage is item 8.
    if (points.length > config.quoteHistoryMax) points.splice(0, points.length - config.quoteHistoryMax);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        mkdirSync(dirname(config.quoteHistoryFile), { recursive: true });
        writeFileSync(config.quoteHistoryFile, JSON.stringify(Object.fromEntries(this.history)));
      } catch (error) {
        console.error("quote history persist failed", error);
      }
    }, 5_000);
  }

  private async poll() {
    for (const pair of config.pairs) {
      try {
        const quote = await this.quotePair(pair);
        if (quote) {
          this.quotes.set(pair.id, quote);
          this.record(pair.id, quote);
        } else {
          this.quotes.delete(pair.id);
        }
      } catch (error) {
        console.error(`quote poll failed for ${pair.id}`, error instanceof Error ? error.message : error);
      }
    }
  }

  private async quotePair(pair: PairConfig): Promise<ExecutableQuote | null> {
    const oneBase = parseUnits("1", pair.baseDecimals);
    const venues: { name: string; price: number }[] = [];
    for (const venue of this.venues) {
      try {
        const amountOut = await this.client.readContract({
          address: config.router as Address,
          abi: routerAbi,
          functionName: "quote",
          args: [venue.adapterId, pair.baseAsset, pair.quoteAsset, oneBase, venue.extra],
        });
        const price = Number(formatUnits(amountOut, pair.quoteDecimals));
        if (price > 0) venues.push({ name: venue.name, price });
      } catch {
        // No liquidity / paused adapter on this venue — skip it.
      }
    }
    if (venues.length === 0) return null;
    const best = venues.reduce((a, b) => (b.price > a.price ? b : a));
    return { pair: pair.id, price: best.price, venue: best.name, venues, ts: Date.now() };
  }
}

/** VENUES env format: "adapterId:Name" comma-separated, e.g. "0:Demo DEX,1:LFJ". */
export function parseVenues(raw: string): VenueConfig[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...name] = entry.split(":");
      return { adapterId: Number(id), name: name.join(":") || `Adapter ${id}`, extra: "0x" as const };
    })
    .filter((venue) => Number.isInteger(venue.adapterId));
}
