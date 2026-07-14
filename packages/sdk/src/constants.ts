import { keccak256, toBytes } from "viem";

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export const ORDER_TYPE =
  "Order(address maker,address receiver,address makerAsset,address takerAsset," +
  "uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch," +
  "uint40 expiry,address allowedSender,uint8 flags)";

export const ORDER_TYPEHASH = keccak256(toBytes(ORDER_TYPE));

// The witness suffix Permit2 hashes verbatim on-chain via permitWitnessTransferFrom.
// This hand-written constant is the source of truth; the wallet typed data in
// permit2.ts is assembled to match it, never the other way around (SDK spec §3).
// Subtypes alphabetical after the witness struct: Order, then TokenPermissions.
export const WITNESS_TYPE_STRING =
  "Order witness)" + ORDER_TYPE + "TokenPermissions(address token,uint256 amount)";

export const MAX_EXPIRY_SECONDS = 2_592_000;
