import { createPublicClient, decodeFunctionData, http, parseAbi, type Address, type Hex, type Log, type PublicClient } from "viem";
import {
  hashOrder,
  nonceToWordAndMask,
  pairForOrder,
  serializeSignedOrder,
  type FillInfo,
  type Order,
  type OrderRecord,
  type Permit2Data,
} from "@seltra/sdk";
import { priceAndSize } from "./book";
import { config } from "./config";
import type { OrderStore } from "./store";

export const settlementEvents = parseAbi([
  "event OrderFilledDEX(bytes32 indexed orderHash, address indexed maker, address indexed keeper, uint8 adapterId, uint256 makingAmount, uint256 amountOut, uint256 makerImprovement, uint256 keeperReward)",
  "event OrderFilledP2P(bytes32 indexed hashA, bytes32 indexed hashB, uint256 surplus, uint256 makerShareA, uint256 makerShareB, uint256 keeperReward)",
  "event EpochIncremented(address indexed maker, uint256 newEpoch)",
]);

const permit2Abi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"]);

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// Fill calldata carries the complete signed orders, so orders that never passed
// through this API (keeper scripts, other frontends) are recoverable from the tx.
const settlementFillAbi = parseAbi([
  "struct Order { address maker; address receiver; address makerAsset; address takerAsset; uint256 makingAmount; uint256 takingAmount; uint256 salt; uint256 epoch; uint40 expiry; address allowedSender; uint8 flags; }",
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct RouteData { uint8 adapterId; bytes extra; }",
  "function fillOrderDEX(Order order, PermitTransferFrom permit, bytes signature, RouteData route) returns (uint256)",
  "function fillOrderP2P(Order a, PermitTransferFrom permitA, bytes sigA, Order b, PermitTransferFrom permitB, bytes sigB)",
]);

type DecodedOrder = {
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  salt: bigint;
  epoch: bigint;
  expiry: number;
  allowedSender: Address;
  flags: number;
};

type DecodedPermit = { permitted: { token: Address; amount: bigint }; nonce: bigint; deadline: bigint };

type SettlementLog = Log<bigint, number, false, undefined, true, typeof settlementEvents>;

/**
 * Polls settlement events and reconciles order statuses: fills flip records to
 * `filled` with enrichment, EpochIncremented flips a maker's stale resting
 * orders to `cancelled`. Block checkpoint persists next to the order store so
 * restarts resume instead of re-scanning. The selected store persists both
 * event identities and the finalized checkpoint in SQLite or PostgreSQL.
 */
export class ChainIndexer {
  private client: PublicClient;
  private checkpoint: bigint;
  private stopped = false;
  private blockTimestamps = new Map<bigint, number>();

  constructor(
    private readonly store: OrderStore,
    private readonly notify: (record: OrderRecord) => void,
  ) {
    this.client = createPublicClient({ transport: http(config.rpcUrl) });
    this.checkpoint = store.getCheckpoint() ?? BigInt(config.startBlock) - 1n;
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.poll();
      } catch (error) {
        console.error("indexer poll failed", error instanceof Error ? error.message : error);
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }

  private async poll() {
    // Confirmation buffer: never index the newest blocks, so an accepted-then-
    // reorged block can't leave phantom state behind.
    const head = (await this.client.getBlockNumber()) - BigInt(config.confirmations);
    if (head <= this.checkpoint) return;
    let from = this.checkpoint + 1n;
    while (from <= head) {
      const to = from + BigInt(config.logChunk) - 1n > head ? head : from + BigInt(config.logChunk) - 1n;
      const logs = await this.client.getLogs({
        address: config.settlement,
        events: settlementEvents,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        // (txHash, logIndex) event log makes re-application a no-op, so replays
        // (deleted checkpoint, overlapping scans) are always safe.
        if (log.logIndex !== null && this.store.isEventApplied(log.transactionHash, log.logIndex)) continue;
        await this.handle(log as SettlementLog);
        if (log.logIndex !== null) await this.store.markEventApplied(log.transactionHash, log.logIndex);
      }
      this.checkpoint = to;
      await this.store.setCheckpoint(to);
      from = to + 1n;
    }
  }

  private async blockTimestamp(blockNumber: bigint): Promise<number> {
    const cached = this.blockTimestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.client.getBlock({ blockNumber });
    const ts = Number(block.timestamp);
    this.blockTimestamps.set(blockNumber, ts);
    if (this.blockTimestamps.size > 256) {
      const oldest = this.blockTimestamps.keys().next().value;
      if (oldest !== undefined) this.blockTimestamps.delete(oldest);
    }
    return ts;
  }

  private async handle(log: SettlementLog) {
    if (log.eventName === "OrderFilledDEX") {
      const { orderHash, adapterId, amountOut, makerImprovement, keeperReward } = log.args;
      await this.markFilled(orderHash, {
        path: "dex",
        adapterId: Number(adapterId),
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        timestamp: await this.blockTimestamp(log.blockNumber),
        makerImprovement: makerImprovement.toString(),
        keeperReward: keeperReward.toString(),
        amountOut: amountOut.toString(),
      });
    } else if (log.eventName === "OrderFilledP2P") {
      const { hashA, hashB, makerShareA, makerShareB, keeperReward } = log.args;
      const common = {
        path: "p2p" as const,
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        timestamp: await this.blockTimestamp(log.blockNumber),
        keeperReward: keeperReward.toString(),
      };
      await this.markFilled(hashA, { ...common, makerImprovement: makerShareA.toString() });
      await this.markFilled(hashB, { ...common, makerImprovement: makerShareB.toString() });
    } else if (log.eventName === "EpochIncremented") {
      const { maker, newEpoch } = log.args;
      const cancelled = await this.store.cancelBelowEpoch(maker, newEpoch);
      for (const record of cancelled) this.notify(record);
      if (cancelled.length > 0) {
        console.log(`epoch ${newEpoch} for ${maker}: cancelled ${cancelled.length} order(s)`);
      }
    }
  }

  /** Permit2 single-order cancel leaves no settlement event; the nonce bitmap is the truth. */
  async isNonceUsed(maker: Address, nonce: bigint): Promise<boolean> {
    const { wordPos, mask } = nonceToWordAndMask(nonce);
    const bitmap = await this.client.readContract({
      address: config.permit2,
      abi: permit2Abi,
      functionName: "nonceBitmap",
      args: [maker, wordPos],
    });
    return (bitmap & mask) !== 0n;
  }

  /** Re-derives one open order's status from the nonce bitmap. Returns the (possibly updated) record. */
  async reconcileOrder(record: OrderRecord): Promise<OrderRecord> {
    if (record.status !== "resting" && record.status !== "unfillable") return record;
    const used = await this.isNonceUsed(record.order.maker as Address, BigInt(record.permit.nonce));
    if (!used) return record;
    record.status = "cancelled";
    record.updatedAt = Date.now();
    await this.store.upsert(record);
    this.notify(record);
    console.log(`order ${record.orderHash} cancelled (nonce invalidated on-chain)`);
    return record;
  }

  /**
   * Unfillable watching (design spec §9): a resting order whose maker no longer
   * holds `makingAmount` (or dropped the Permit2 allowance) is NOT cancelled —
   * it degrades to `unfillable` so keepers skip it, and recovers to `resting`
   * on its own when the balance returns.
   */
  async reconcileFillability(record: OrderRecord): Promise<void> {
    if (record.status !== "resting" && record.status !== "unfillable") return;
    const maker = record.order.maker as Address;
    const token = record.order.makerAsset as Address;
    const needed = BigInt(record.order.makingAmount);
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [maker] }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [maker, config.permit2] }),
    ]);
    const fillable = balance >= needed && allowance >= needed;
    const nextStatus = fillable ? "resting" : "unfillable";
    if (record.status === nextStatus) return;
    record.status = nextStatus;
    record.updatedAt = Date.now();
    await this.store.upsert(record);
    this.notify(record);
    console.log(`order ${record.orderHash} → ${nextStatus} (balance ${balance}, allowance ${allowance}, needs ${needed})`);
  }

  /** Periodic sweep so cancels made outside this app's UI still reconcile, plus fillability. */
  async sweepNonces(records: OrderRecord[]) {
    for (const record of records) {
      try {
        const reconciled = await this.reconcileOrder(record);
        if (reconciled.status === "resting" || reconciled.status === "unfillable") {
          await this.reconcileFillability(reconciled);
        }
      } catch (error) {
        console.error(`nonce sweep failed for ${record.orderHash}`, error instanceof Error ? error.message : error);
      }
    }
  }

  /** Rebuild an OrderRecord for `wantedHash` from the fill transaction's calldata. */
  private async recoverFromCalldata(txHash: Hex, wantedHash: Hex, timestamp: number): Promise<OrderRecord | null> {
    const tx = await this.client.getTransaction({ hash: txHash });
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: settlementFillAbi, data: tx.input });
    } catch {
      return null;
    }
    const candidates: { order: DecodedOrder; permit: DecodedPermit; signature: Hex }[] =
      decoded.functionName === "fillOrderDEX"
        ? [{ order: decoded.args[0] as DecodedOrder, permit: decoded.args[1] as DecodedPermit, signature: decoded.args[2] as Hex }]
        : [
            { order: decoded.args[0] as DecodedOrder, permit: decoded.args[1] as DecodedPermit, signature: decoded.args[2] as Hex },
            { order: decoded.args[3] as DecodedOrder, permit: decoded.args[4] as DecodedPermit, signature: decoded.args[5] as Hex },
          ];
    for (const candidate of candidates) {
      const order: Order = { ...candidate.order, expiry: BigInt(candidate.order.expiry) };
      if (hashOrder(order).toLowerCase() !== wantedHash.toLowerCase()) continue;
      const match = pairForOrder(config.pairs, order.makerAsset, order.takerAsset);
      if (!match) {
        console.log(`recovered order ${wantedHash} is for an unregistered pair — skipped`);
        return null;
      }
      const permit: Permit2Data = candidate.permit;
      const record: OrderRecord = {
        ...serializeSignedOrder({ order, permit, signature: candidate.signature }),
        orderHash: wantedHash,
        chainId: config.chainId,
        pair: match.pair.id,
        side: match.side,
        price: "0",
        baseAmount: "0",
        status: "resting",
        softCancelled: false,
        createdAt: timestamp * 1000,
        updatedAt: Date.now(),
      };
      const { price, size } = priceAndSize(record, match.pair);
      record.price = price.toFixed(Math.max(match.pair.pricePrecision, 6));
      record.baseAmount = size.toString();
      console.log(`recovered order ${wantedHash} from calldata of ${txHash}`);
      return record;
    }
    return null;
  }

  private async markFilled(orderHash: `0x${string}`, fill: FillInfo) {
    let record = this.store.get(orderHash);
    if (!record) {
      record = (await this.recoverFromCalldata(fill.txHash, orderHash, fill.timestamp)) ?? undefined;
      if (!record) {
        console.log(`fill for unknown, unrecoverable order ${orderHash} (tx ${fill.txHash})`);
        return;
      }
      await this.store.upsert(record);
    }
    if (record.status === "filled") return;
    record.status = "filled";
    record.fill = fill;
    record.updatedAt = Date.now();
    await this.store.upsert(record);
    this.notify(record);
    console.log(`order ${orderHash} filled via ${fill.path} (tx ${fill.txHash})`);
  }
}
