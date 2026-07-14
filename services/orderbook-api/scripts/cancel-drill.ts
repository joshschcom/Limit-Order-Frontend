/**
 * On-chain single-cancel drill, step 1: sign a small real order with the key in
 * $PRIVATE_KEY, POST it to the local API, and print the nonce word/mask needed
 * for Permit2 invalidateUnorderedNonces. Steps 2–3 (cast send + reconcile) run
 * from the shell. Fuji only.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildAmounts,
  buildOrder,
  hashOrder,
  nonceToWordAndMask,
  serializeSignedOrder,
  typedDataForSigning,
} from "@seltra/sdk";
import { config } from "../src/config";

const REST = process.env.SMOKE_REST ?? "http://localhost:8080";
const pk = process.env.PRIVATE_KEY;
if (!pk) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(pk as `0x${string}`);
const pair = config.pairs[0];

async function main() {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const epoch = await client.readContract({
    address: config.settlement,
    abi: parseAbi(["function currentEpoch(address maker) view returns (uint256)"]),
    functionName: "currentEpoch",
    args: [account.address],
  });

  const { makingAmount, takingAmount } = buildAmounts("sell", "0.5", "41.00", pair.baseDecimals, pair.quoteDecimals);
  const { order, permit } = buildOrder({
    maker: account.address,
    makerAsset: pair.baseAsset,
    takerAsset: pair.quoteAsset,
    makingAmount,
    takingAmount,
    epoch,
    expirySeconds: 3600,
  });
  const typedData = typedDataForSigning({
    chainId: config.chainId,
    permit2: config.permit2,
    settlement: config.settlement,
    order,
    permit,
  });
  const signature = await account.signTypedData(typedData);

  const response = await fetch(`${REST}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeSignedOrder({ order, permit, signature })),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`submit failed: ${JSON.stringify(body)}`);

  const { wordPos, mask } = nonceToWordAndMask(permit.nonce);
  console.log(
    JSON.stringify({
      orderHash: hashOrder(order),
      maker: account.address,
      status: body.status,
      wordPos: wordPos.toString(),
      mask: mask.toString(),
    }),
  );
}

void main();
