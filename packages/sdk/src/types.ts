import type { Address, Hex } from "viem";

export interface Order {
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  salt: bigint;
  epoch: bigint;
  expiry: bigint; // uint40, unix seconds
  allowedSender: Address; // zeroAddress = open
  flags: number; // uint8, MUST be 0 in V1
}

export interface Permit2Data {
  permitted: { token: Address; amount: bigint }; // == makerAsset / makingAmount
  nonce: bigint; // unordered nonce
  deadline: bigint; // == order.expiry
}

export interface SignedOrder {
  order: Order;
  permit: Permit2Data;
  signature: Hex;
}

export type OrderSide = "buy" | "sell";

export type OrderStatus = "resting" | "unfillable" | "filled" | "cancelled" | "expired";

/** Wire form of Order: bigints as decimal strings (SDK spec §2 serialization rule). */
export interface OrderJson {
  maker: string;
  receiver: string;
  makerAsset: string;
  takerAsset: string;
  makingAmount: string;
  takingAmount: string;
  salt: string;
  epoch: string;
  expiry: string;
  allowedSender: string;
  flags: number;
}

export interface Permit2DataJson {
  permitted: { token: string; amount: string };
  nonce: string;
  deadline: string;
}

export interface SignedOrderJson {
  order: OrderJson;
  permit: Permit2DataJson;
  signature: Hex;
}

/** On-chain fill enrichment, written by the indexer from settlement events. */
export interface FillInfo {
  path: "dex" | "p2p";
  txHash: Hex;
  blockNumber: number;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  /** Extra received above the limit, in the maker's receive-asset units (decimal string). */
  makerImprovement: string;
  keeperReward: string;
  amountOut?: string;
}

/** An order as stored and served by the orderbook API. */
export interface OrderRecord extends SignedOrderJson {
  orderHash: Hex;
  chainId: number;
  pair: string;
  side: OrderSide;
  /** Quote per base, decimal string. */
  price: string;
  /** Base amount, decimal string. */
  baseAmount: string;
  status: OrderStatus;
  softCancelled: boolean;
  createdAt: number;
  updatedAt: number;
  fill?: FillInfo;
}

export interface BookLevel {
  price: number;
  size: number;
  total: number;
}

export interface BookSnapshot {
  pair: string;
  /** Best bid first (descending price), cumulative totals from best. */
  bids: BookLevel[];
  /** Best ask first (ascending price), cumulative totals from best. */
  asks: BookLevel[];
  ts: number;
}

/** One OHLCV bucket aggregated from enriched fill events — never synthesized. */
export interface Candle {
  /** Bucket start, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume. */
  volume: number;
}

/** One settled fill on the venue tape, derived from fill enrichment. */
export interface TradePrint {
  /** Fill block timestamp, unix seconds. */
  time: number;
  /** Effective price (improvement included), quote per base. */
  price: number;
  /** Base-asset size. */
  size: number;
  /** The maker's side of the settled order. */
  side: OrderSide;
  path: "dex" | "p2p";
  txHash: Hex;
  orderHash: Hex;
}

/** One observed router-quote sample (ms timestamp). Gaps are real — never interpolated. */
export interface QuotePoint {
  t: number;
  price: number;
}

/** Live executable price from the aggregation router, best across venues. */
export interface ExecutableQuote {
  pair: string;
  /** Quote per base for selling one base unit. */
  price: number;
  venue: string;
  venues: { name: string; price: number }[];
  ts: number;
}

export interface ProtocolStats {
  totalVolumeQuote: string;
  ordersFilled: number;
  ordersResting: number;
  avgImprovementBps: number | null;
  p2pMatchRateBps: number | null;
}

/** Absolute size now resting at a price level; size 0 removes the level. */
export interface LevelChange {
  price: number;
  size: number;
}

/**
 * Book messages as sent on the wire. Snapshots carry a per-pair sequence
 * number; diffs must arrive with seq = last + 1 or the client resubscribes
 * for a fresh snapshot. Cumulative totals are recomputed client-side.
 */
export type BookWireMsg =
  | { v: 1; type: "book.snapshot"; pair: string; seq: number; book: BookSnapshot }
  | { v: 1; type: "book.diff"; pair: string; seq: number; bids: LevelChange[]; asks: LevelChange[]; ts: number };

/** Book messages as delivered to subscribers: diffs are pre-applied into full snapshots. */
export type BookMsg =
  | { v: 1; type: "book.snapshot"; pair: string; book: BookSnapshot }
  | { v: 1; type: "book.update"; pair: string; book: BookSnapshot };

export type UserMsg = { v: 1; type: "user.order"; order: OrderRecord };

export type ServerMsg = BookWireMsg | UserMsg | { v: 1; type: "heartbeat"; ts: number };

export type ClientMsg =
  | { type: "subscribe"; channel: string }
  | { type: "unsubscribe"; channel: string };

export interface PairConfig {
  id: string; // e.g. "WAVAX-USDC"
  baseAsset: Address;
  quoteAsset: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  pricePrecision: number;
  amountPrecision: number;
}
