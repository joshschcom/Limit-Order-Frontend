import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { buildOrder } from "./order";
import type { Order, Permit2Data, SignedOrder } from "./types";

// Finite pre-signed grids: a ladder of ordinary V1 limit orders planned with
// exact integer arithmetic. Nothing here is a bot — every level is a one-shot,
// all-or-nothing order that never replenishes. All amount math is bigint on
// scaled integers; JS floats never touch a token amount.

export const GRID_MIN_LEVELS = 4;
export const GRID_MAX_LEVELS = 20;
export const GRID_SUBMIT_CONCURRENCY = 3;

/** Shown before any epoch-based grid cancel; incrementEpoch is wallet-wide, not per-grid. */
export const GRID_CANCEL_ALL_WARNING =
  "Cancelling the entire grid calls incrementEpoch on the Settlement contract, which cancels every outstanding Seltra order from this wallet — not only this grid. Already-filled orders are unaffected.";

export class GridPlanError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "GridPlanError";
  }
}

export interface GridPairMeta {
  baseDecimals: number;
  quoteDecimals: number;
  pricePrecision: number;
}

export interface GridConfig {
  pairId: string;
  lowerPrice: string;
  upperPrice: string;
  referencePrice: string;
  levels: number;
  baseBudget: string;
  quoteBudget: string;
  expirySeconds: number;
}

export interface GridLevel {
  /** Position in the generated ladder (0..levels-1); stable across neutral omission. */
  index: number;
  side: "buy" | "sell";
  price: string;
  makingAmount: bigint;
  takingAmount: bigint;
}

export interface GridPlan {
  /** Deterministic local UI id. Never part of any signed Order or Permit2 witness. */
  gridId: string;
  config: GridConfig;
  levels: GridLevel[];
  /** A ladder price that rounded onto the reference; shown as a line, never an order. */
  neutralPrice?: string;
  requiredBase: bigint;
  requiredQuote: bigint;
}

export interface GridBuiltOrder {
  levelIndex: number;
  side: "buy" | "sell";
  order: Order;
  permit: Permit2Data;
}

export type GridSignedOrder = GridBuiltOrder & { signature: Hex };

export interface GridSubmitResult {
  accepted: { levelIndex: number; orderHash: Hex }[];
  failed: { index: number; reason: string }[];
}

/** Local record of a submitted grid. Deliberately has no field for signatures. */
export interface GridManifest {
  gridId: string;
  maker: Address;
  pairId: string;
  createdAt: number;
  /** Common child expiry, unix seconds (decimal string). */
  expiry: string;
  orderHashes: Hex[];
  failedLevels: { index: number; reason: string }[];
  config: GridConfig;
}

/**
 * Exact decimal-string → scaled-bigint parse. Rejects malformed input and
 * precision beyond `scale` instead of silently truncating.
 */
export function parseDecimal(value: string, scale: number, label = "value"): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new GridPlanError("bad-number", `${label} must be a plain decimal number`);
  const [, whole, fracRaw = ""] = match;
  if (fracRaw.length > scale && !/^0*$/.test(fracRaw.slice(scale))) {
    throw new GridPlanError("too-precise", `${label} supports at most ${scale} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fracRaw.slice(0, scale).padEnd(scale, "0") || "0");
}

/** Scaled-bigint → fixed-precision decimal string (inverse of parseDecimal). */
export function formatScaled(value: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  const whole = value / unit;
  if (scale === 0) return whole.toString();
  return `${whole}.${(value % unit).toString().padStart(scale, "0")}`;
}

/**
 * Deterministic linear ladder: price[i] = L + floor((U - L) * i / (N - 1)) at
 * the pair's price precision, endpoints included. Throws GridPlanError on any
 * invalid configuration — nothing is silently dropped or resized.
 */
export function planGrid(config: GridConfig, pair: GridPairMeta): GridPlan {
  const pp = pair.pricePrecision;
  const lower = parseDecimal(config.lowerPrice, pp, "Lower price");
  const upper = parseDecimal(config.upperPrice, pp, "Upper price");
  const reference = parseDecimal(config.referencePrice, pp, "Reference price");
  const n = config.levels;

  if (!Number.isInteger(n) || n < GRID_MIN_LEVELS || n > GRID_MAX_LEVELS) {
    throw new GridPlanError("bad-levels", `Levels must be a whole number between ${GRID_MIN_LEVELS} and ${GRID_MAX_LEVELS}`);
  }
  if (lower <= 0n) throw new GridPlanError("bad-range", "Lower price must be above zero");
  if (lower >= reference) throw new GridPlanError("bad-range", "Lower price must be below the reference price");
  if (reference >= upper) throw new GridPlanError("bad-range", "Upper price must be above the reference price");

  const span = upper - lower;
  const prices: bigint[] = [];
  for (let i = 0; i < n; i++) {
    prices.push(lower + (span * BigInt(i)) / BigInt(n - 1));
  }
  for (let i = 1; i < n; i++) {
    if (prices[i] <= prices[i - 1]) {
      throw new GridPlanError("duplicate-levels", "Price range is too narrow for this many levels at the pair's price precision — levels would collide");
    }
  }

  let neutralPrice: string | undefined;
  const buyIdx: number[] = [];
  const sellIdx: number[] = [];
  prices.forEach((price, i) => {
    if (price < reference) buyIdx.push(i);
    else if (price > reference) sellIdx.push(i);
    // Equal to reference after rounding: neutral line, never a marketable order.
    else neutralPrice = formatScaled(price, pp);
  });
  if (buyIdx.length === 0) throw new GridPlanError("no-buys", "Grid needs at least one buy level below the reference price");
  if (sellIdx.length === 0) throw new GridPlanError("no-sells", "Grid needs at least one sell level above the reference price");

  const baseBudget = parseDecimal(config.baseBudget, pair.baseDecimals, "Base budget");
  const quoteBudget = parseDecimal(config.quoteBudget, pair.quoteDecimals, "Quote budget");
  if (sellIdx.length > 0 && baseBudget <= 0n) throw new GridPlanError("bad-budget", "Base budget must be above zero for the sell levels");
  if (buyIdx.length > 0 && quoteBudget <= 0n) throw new GridPlanError("bad-budget", "Quote budget must be above zero for the buy levels");

  // Equal split per side; the division remainder goes one smallest unit at a
  // time to the earliest levels of that side, so allocations sum to the budget
  // exactly and never exceed it.
  const allocate = (budget: bigint, count: number): bigint[] => {
    const share = budget / BigInt(count);
    const remainder = budget % BigInt(count);
    return Array.from({ length: count }, (_, i) => share + (BigInt(i) < remainder ? 1n : 0n));
  };
  const quoteAlloc = allocate(quoteBudget, buyIdx.length);
  const baseAlloc = allocate(baseBudget, sellIdx.length);

  const priceUnit = 10n ** BigInt(pp);
  const baseUnit = 10n ** BigInt(pair.baseDecimals);
  const quoteUnit = 10n ** BigInt(pair.quoteDecimals);

  const levels: GridLevel[] = [];
  buyIdx.forEach((index, k) => {
    const price = prices[index];
    const makingAmount = quoteAlloc[k]; // maker pays quote
    const takingAmount = (makingAmount * baseUnit * priceUnit) / (price * quoteUnit); // floor base out
    levels.push({ index, side: "buy", price: formatScaled(price, pp), makingAmount, takingAmount });
  });
  sellIdx.forEach((index, k) => {
    const price = prices[index];
    const makingAmount = baseAlloc[k]; // maker pays base
    const takingAmount = (makingAmount * price * quoteUnit) / (priceUnit * baseUnit); // floor quote out
    levels.push({ index, side: "sell", price: formatScaled(price, pp), makingAmount, takingAmount });
  });
  levels.sort((a, b) => a.index - b.index);

  for (const level of levels) {
    if (level.makingAmount <= 0n || level.takingAmount <= 0n) {
      throw new GridPlanError("zero-amount-level", `The budget spreads too thin: level at ${level.price} would round to zero. Raise the budget or reduce levels`);
    }
  }

  const requiredBase = levels.reduce((sum, l) => (l.side === "sell" ? sum + l.makingAmount : sum), 0n);
  const requiredQuote = levels.reduce((sum, l) => (l.side === "buy" ? sum + l.makingAmount : sum), 0n);

  const gridId = keccak256(
    stringToHex(
      ["grid", config.pairId, lower, upper, reference, n, baseBudget, quoteBudget, config.expirySeconds].join("|"),
    ),
  ).slice(0, 18);

  return { gridId, config, levels, neutralPrice, requiredBase, requiredQuote };
}

/** Which Permit2 allowances fall short of the plan's aggregate budgets. */
export function requiredGridApprovals(
  plan: GridPlan,
  allowances: { base: bigint; quote: bigint },
): { base: boolean; quote: boolean } {
  return { base: allowances.base < plan.requiredBase, quote: allowances.quote < plan.requiredQuote };
}

/**
 * Builds every child as a normal V1 order: unique salt and Permit2 nonce per
 * child (from buildOrder), one shared epoch, one shared absolute expiry.
 */
export function buildGridOrders(
  plan: GridPlan,
  params: {
    maker: Address;
    baseAsset: Address;
    quoteAsset: Address;
    epoch: bigint;
    /** Unix seconds "now"; injectable for tests. */
    nowSeconds?: number;
  },
): { built: GridBuiltOrder[]; expiryAt: bigint } {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiryAt = BigInt(now + plan.config.expirySeconds);
  const built = plan.levels.map((level) => {
    const { order, permit } = buildOrder({
      maker: params.maker,
      makerAsset: level.side === "sell" ? params.baseAsset : params.quoteAsset,
      takerAsset: level.side === "sell" ? params.quoteAsset : params.baseAsset,
      makingAmount: level.makingAmount,
      takingAmount: level.takingAmount,
      epoch: params.epoch,
      expirySeconds: plan.config.expirySeconds,
      expiryAt,
    });
    return { levelIndex: level.index, side: level.side, order, permit };
  });
  return { built, expiryAt };
}

/**
 * Sequential signature collection. Signatures live only in the returned array.
 * Stop (or a wallet rejection, which throws) yields no partial result — the
 * caller must discard the batch and submit nothing.
 */
export async function collectGridSignatures(
  built: GridBuiltOrder[],
  sign: (item: GridBuiltOrder) => Promise<Hex>,
  opts: { onProgress?: (current: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<{ stopped: true } | { stopped: false; signed: GridSignedOrder[] }> {
  const total = built.length;
  const signed: GridSignedOrder[] = [];
  for (let i = 0; i < total; i++) {
    if (opts.shouldStop?.()) return { stopped: true };
    opts.onProgress?.(i + 1, total);
    const signature = await sign(built[i]);
    signed.push({ ...built[i], signature });
  }
  if (opts.shouldStop?.()) return { stopped: true };
  return { stopped: false, signed };
}

/**
 * Submits every signed child with bounded concurrency and allSettled
 * semantics: every acceptance and every failure is reported; a partial grid is
 * never mistaken for a complete one.
 */
export async function submitGridOrders(
  signed: GridSignedOrder[],
  submit: (order: SignedOrder) => Promise<{ orderHash: Hex }>,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<GridSubmitResult> {
  const concurrency = opts.concurrency ?? GRID_SUBMIT_CONCURRENCY;
  const total = signed.length;
  const accepted: GridSubmitResult["accepted"] = [];
  const failed: GridSubmitResult["failed"] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < total) {
      const item = signed[next];
      next += 1;
      try {
        const { orderHash } = await submit({ order: item.order, permit: item.permit, signature: item.signature });
        accepted.push({ levelIndex: item.levelIndex, orderHash });
      } catch (cause) {
        failed.push({ index: item.levelIndex, reason: normalizeGridReason(cause) });
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  accepted.sort((a, b) => a.levelIndex - b.levelIndex);
  failed.sort((a, b) => a.index - b.index);
  return { accepted, failed };
}

/** The only grid state that may be persisted: hashes and config, never signatures. */
export function buildGridManifest(params: {
  plan: GridPlan;
  maker: Address;
  expiryAt: bigint;
  result: GridSubmitResult;
  createdAt?: number;
}): GridManifest {
  return {
    gridId: params.plan.gridId,
    maker: params.maker,
    pairId: params.plan.config.pairId,
    createdAt: params.createdAt ?? Date.now(),
    expiry: params.expiryAt.toString(),
    orderHashes: params.result.accepted.map((a) => a.orderHash),
    failedLevels: params.result.failed,
    config: params.plan.config,
  };
}

/** One display-safe line: control characters stripped, length bounded. */
export function normalizeGridReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Submission failed";
  // eslint-disable-next-line no-control-regex
  const firstLine = message.split("\n")[0].replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine || "Submission failed";
}
