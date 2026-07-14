import { recoverTypedDataAddress, type Address } from "viem";
import { MAX_EXPIRY_SECONDS } from "./constants";
import { typedDataForSigning } from "./permit2";
import type { PairConfig, SignedOrder } from "./types";

export interface ValidationConfig {
  chainId: number;
  permit2: Address;
  settlement: Address;
  maxExpirySeconds?: number;
}

export class SeltraValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "SeltraValidationError";
  }
}

export function pairForOrder(pairs: PairConfig[], makerAsset: string, takerAsset: string): { pair: PairConfig; side: "buy" | "sell" } | null {
  const maker = makerAsset.toLowerCase();
  const taker = takerAsset.toLowerCase();
  for (const pair of pairs) {
    const base = pair.baseAsset.toLowerCase();
    const quote = pair.quoteAsset.toLowerCase();
    if (maker === base && taker === quote) return { pair, side: "sell" };
    if (maker === quote && taker === base) return { pair, side: "buy" };
  }
  return null;
}

/**
 * Structural validation + EOA recovery (SDK spec §4). No network access.
 * ERC-1271 signatures are NOT ECDSA-recoverable, so a failed recovery on a
 * non-65-byte signature does not reject here; on-chain verification is the
 * final signature authority and is layered on separately.
 */
export async function verifySignedOrderPure(
  cfg: ValidationConfig,
  signed: SignedOrder,
  opts: { allowedPairs: PairConfig[]; now?: bigint },
): Promise<true | SeltraValidationError> {
  const { order, permit, signature } = signed;
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  const maxExpiry = BigInt(cfg.maxExpirySeconds ?? MAX_EXPIRY_SECONDS);

  if (order.flags !== 0) return new SeltraValidationError("BadFlags", "Order flags must be 0");
  if (order.makingAmount <= 0n || order.takingAmount <= 0n)
    return new SeltraValidationError("BadAmounts", "Order amounts must be above zero");
  if (order.receiver.toLowerCase() === "0x0000000000000000000000000000000000000000")
    return new SeltraValidationError("BadReceiver", "Receiver cannot be the zero address");
  if (order.expiry <= now) return new SeltraValidationError("OrderExpired", "Order is already expired");
  if (order.expiry > now + maxExpiry)
    return new SeltraValidationError("ExpiryTooFar", "Expiry exceeds 30 days");

  if (permit.permitted.token.toLowerCase() !== order.makerAsset.toLowerCase())
    return new SeltraValidationError("BadPermitConsistency", "Permit token does not match maker asset");
  if (permit.permitted.amount !== order.makingAmount)
    return new SeltraValidationError("BadPermitConsistency", "Permit amount does not match making amount");
  if (permit.deadline !== order.expiry)
    return new SeltraValidationError("BadPermitConsistency", "Permit deadline does not match order expiry");

  if (!pairForOrder(opts.allowedPairs, order.makerAsset, order.takerAsset))
    return new SeltraValidationError("PairNotSupported", "Pair not supported");

  // 65-byte r,s,v signature: recover and require the maker.
  const isEoaStyle = /^0x[0-9a-fA-F]{130}$/.test(signature);
  if (isEoaStyle) {
    try {
      const typedData = typedDataForSigning({
        chainId: cfg.chainId,
        permit2: cfg.permit2,
        settlement: cfg.settlement,
        order,
        permit,
      });
      const recovered = await recoverTypedDataAddress({ ...typedData, signature });
      if (recovered.toLowerCase() !== order.maker.toLowerCase())
        return new SeltraValidationError("InvalidSignature", "Signature invalid");
    } catch {
      return new SeltraValidationError("InvalidSignature", "Signature invalid");
    }
  }

  return true;
}
