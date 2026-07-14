import { encodeAbiParameters, keccak256, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { ORDER_TYPEHASH } from "./constants";
import type { Order, OrderSide, Permit2Data } from "./types";
import { generateNonce, randomSalt } from "./nonce";

export function hashOrder(order: Order): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint40" },
        { type: "address" },
        { type: "uint8" },
      ],
      [
        ORDER_TYPEHASH,
        order.maker,
        order.receiver,
        order.makerAsset,
        order.takerAsset,
        order.makingAmount,
        order.takingAmount,
        order.salt,
        order.epoch,
        Number(order.expiry),
        order.allowedSender,
        order.flags,
      ],
    ),
  );
}

export function buildOrder(params: {
  maker: Address;
  receiver?: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  epoch: bigint;
  expirySeconds: number;
  allowedSender?: Address;
}): { order: Order; permit: Permit2Data } {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now + BigInt(params.expirySeconds);
  const order: Order = {
    maker: params.maker,
    receiver: params.receiver ?? params.maker,
    makerAsset: params.makerAsset,
    takerAsset: params.takerAsset,
    makingAmount: params.makingAmount,
    takingAmount: params.takingAmount,
    salt: randomSalt(),
    epoch: params.epoch,
    expiry,
    allowedSender: params.allowedSender ?? zeroAddress,
    flags: 0,
  };
  const permit: Permit2Data = {
    permitted: { token: order.makerAsset, amount: order.makingAmount },
    nonce: generateNonce(),
    deadline: order.expiry,
  };
  return { order, permit };
}

export function buildAmounts(
  side: OrderSide,
  amount: string,
  price: string,
  baseDecimals: number,
  quoteDecimals: number,
): { makingAmount: bigint; takingAmount: bigint } {
  const cleanAmount = amount && Number(amount) > 0 ? amount : "0";
  const cleanPrice = price && Number(price) > 0 ? price : "0";
  if (side === "sell") {
    return {
      makingAmount: parseUnits(cleanAmount, baseDecimals),
      takingAmount: parseUnits((Number(cleanAmount) * Number(cleanPrice)).toFixed(quoteDecimals), quoteDecimals),
    };
  }
  return {
    makingAmount: parseUnits((Number(cleanAmount) * Number(cleanPrice)).toFixed(quoteDecimals), quoteDecimals),
    takingAmount: parseUnits(cleanAmount, baseDecimals),
  };
}
