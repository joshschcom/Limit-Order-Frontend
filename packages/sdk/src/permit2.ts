import type { Address } from "viem";
import type { Order, Permit2Data } from "./types";

// Field lists mirror ORDER_TYPE / WITNESS_TYPE_STRING in constants.ts exactly.
// Permit2 hashes the raw witness string on-chain; the wallet-side object below
// must stay byte-equivalent to those constants (SDK spec §3). Foundry
// sign-vectors are the referee once the contracts package publishes them.
export const permitWitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Order" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Order: [
    { name: "maker", type: "address" },
    { name: "receiver", type: "address" },
    { name: "makerAsset", type: "address" },
    { name: "takerAsset", type: "address" },
    { name: "makingAmount", type: "uint256" },
    { name: "takingAmount", type: "uint256" },
    { name: "salt", type: "uint256" },
    { name: "epoch", type: "uint256" },
    { name: "expiry", type: "uint40" },
    { name: "allowedSender", type: "address" },
    { name: "flags", type: "uint8" },
  ],
} as const;

export function typedDataForSigning(params: {
  chainId: number;
  permit2: Address;
  settlement: Address;
  order: Order;
  permit: Permit2Data;
}) {
  return {
    domain: {
      name: "Permit2",
      chainId: params.chainId,
      verifyingContract: params.permit2,
    },
    types: permitWitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: params.permit.permitted,
      spender: params.settlement,
      nonce: params.permit.nonce,
      deadline: params.permit.deadline,
      witness: { ...params.order, expiry: Number(params.order.expiry) },
    },
  } as const;
}
