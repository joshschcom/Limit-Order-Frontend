import type { Address, Hex } from "viem";
import type { Order, OrderJson, Permit2Data, Permit2DataJson, SignedOrder, SignedOrderJson } from "./types";

// The only wire codecs any Seltra service may use (SDK spec §2):
// bigints as decimal strings, addresses lowercase hex, hashes 0x-prefixed.

export function serializeOrder(order: Order): OrderJson {
  return {
    maker: order.maker.toLowerCase(),
    receiver: order.receiver.toLowerCase(),
    makerAsset: order.makerAsset.toLowerCase(),
    takerAsset: order.takerAsset.toLowerCase(),
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    salt: order.salt.toString(),
    epoch: order.epoch.toString(),
    expiry: order.expiry.toString(),
    allowedSender: order.allowedSender.toLowerCase(),
    flags: order.flags,
  };
}

export function deserializeOrder(json: OrderJson): Order {
  return {
    maker: json.maker as Address,
    receiver: json.receiver as Address,
    makerAsset: json.makerAsset as Address,
    takerAsset: json.takerAsset as Address,
    makingAmount: BigInt(json.makingAmount),
    takingAmount: BigInt(json.takingAmount),
    salt: BigInt(json.salt),
    epoch: BigInt(json.epoch),
    expiry: BigInt(json.expiry),
    allowedSender: json.allowedSender as Address,
    flags: json.flags,
  };
}

export function serializePermit(permit: Permit2Data): Permit2DataJson {
  return {
    permitted: {
      token: permit.permitted.token.toLowerCase(),
      amount: permit.permitted.amount.toString(),
    },
    nonce: permit.nonce.toString(),
    deadline: permit.deadline.toString(),
  };
}

export function deserializePermit(json: Permit2DataJson): Permit2Data {
  return {
    permitted: { token: json.permitted.token as Address, amount: BigInt(json.permitted.amount) },
    nonce: BigInt(json.nonce),
    deadline: BigInt(json.deadline),
  };
}

export function serializeSignedOrder(signed: SignedOrder): SignedOrderJson {
  return {
    order: serializeOrder(signed.order),
    permit: serializePermit(signed.permit),
    signature: signed.signature,
  };
}

export function deserializeSignedOrder(json: SignedOrderJson): SignedOrder {
  return {
    order: deserializeOrder(json.order),
    permit: deserializePermit(json.permit),
    signature: json.signature as Hex,
  };
}
