/**
 * End-to-end smoke test against a running orderbook-api (default :8080).
 * Signs real orders with a throwaway key via @seltra/sdk, then checks:
 * submit → 201, idempotent resubmit → 200, book aggregation, user query,
 * tampered-order rejection, and WS snapshot + update. Run: npx tsx scripts/smoke.ts
 */
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import {
  buildAmounts,
  buildOrder,
  hashOrder,
  serializeSignedOrder,
  typedDataForSigning,
  PERMIT2_ADDRESS,
  SeltraApi,
  type BookMsg,
  type BookSnapshot,
  type BookWireMsg,
  type SignedOrder,
} from "@seltra/sdk";
import { config } from "../src/config";

const REST = process.env.SMOKE_REST ?? "http://localhost:8080";
const WS_URL = process.env.SMOKE_WS ?? "ws://localhost:8080/stream";
// Well-known junk key (hardhat account #0) — never fund on a real network.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const pair = config.pairs[0];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function signOrder(side: "buy" | "sell", amount: string, price: string): Promise<SignedOrder> {
  const { makingAmount, takingAmount } = buildAmounts(side, amount, price, pair.baseDecimals, pair.quoteDecimals);
  const { order, permit } = buildOrder({
    maker: account.address,
    makerAsset: side === "sell" ? pair.baseAsset : pair.quoteAsset,
    takerAsset: side === "sell" ? pair.quoteAsset : pair.baseAsset,
    makingAmount,
    takingAmount,
    epoch: 0n,
    expirySeconds: 86_400,
  });
  const typedData = typedDataForSigning({
    chainId: config.chainId,
    permit2: PERMIT2_ADDRESS,
    settlement: config.settlement,
    order,
    permit,
  });
  const signature = await account.signTypedData(typedData);
  return { order, permit, signature };
}

async function post(signed: SignedOrder) {
  const response = await fetch(`${REST}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeSignedOrder(signed)),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main() {
  // Raw WS: subscribe before placing so we see snapshot then diffs on the wire.
  const wire: BookWireMsg[] = [];
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", channel: `book:${pair.id}` }));
      resolve();
    });
    ws.on("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as BookWireMsg | { type: string };
    if (msg.type === "book.snapshot" || msg.type === "book.diff") wire.push(msg as BookWireMsg);
  });

  // Real SDK client in parallel: diffs must reassemble into the exact book.
  const api = new SeltraApi({ restUrl: REST, wsUrl: WS_URL });
  const assembled: BookMsg[] = [];
  const unsubscribe = api.subscribeBook(pair.id, (msg) => assembled.push(msg));

  const sell = await signOrder("sell", "12.5", "40.50");
  const sellHash = hashOrder(sell.order);
  const first = await post(sell);
  check("submit sell → 201 with matching hash", first.status === 201 && first.body.orderHash === sellHash, first);

  const again = await post(sell);
  check("resubmit → 200 idempotent", again.status === 200 && again.body.orderHash === sellHash, again);

  const buy = await signOrder("buy", "8", "39.90");
  const buyRes = await post(buy);
  check("submit buy → 201", buyRes.status === 201, buyRes);

  const book = (await (await fetch(`${REST}/orderbook/${pair.id}`)).json()) as BookSnapshot;
  const ask = book.asks[0];
  const bid = book.bids[0];
  check("book has ask 40.50 × 12.5", ask?.price === 40.5 && ask?.size === 12.5, book.asks);
  check("book has bid 39.90 × 8", bid?.price === 39.9 && bid?.size === 8, book.bids);

  const mine = (await (await fetch(`${REST}/orders?maker=${account.address}`)).json()) as unknown[];
  check("orders query returns both", mine.length >= 2, mine.length);

  const detail = await fetch(`${REST}/orders/${sellHash}`);
  check("order detail by hash → 200", detail.status === 200);

  // Tamper takingAmount after signing: permit consistency still holds, so this
  // must fall through to signature recovery and fail there.
  const tampered: SignedOrder = { ...sell, order: { ...sell.order, takingAmount: sell.order.takingAmount + 1n } };
  const reject = await post(tampered);
  check("tampered order → 400 InvalidSignature", reject.status === 400 && reject.body.code === "InvalidSignature", reject);

  // Tamper the permit side: caught by the consistency layer before recovery.
  const inconsistent: SignedOrder = { ...sell, order: { ...sell.order, makingAmount: sell.order.makingAmount + 1n } };
  const rejectPermit = await post(inconsistent);
  check("permit mismatch → 400 BadPermitConsistency", rejectPermit.status === 400 && rejectPermit.body.code === "BadPermitConsistency", rejectPermit);

  const badPair = await signOrder("sell", "1", "40");
  badPair.order.takerAsset = "0x0000000000000000000000000000000000000001";
  const rejectPair = await post(badPair);
  check("unknown pair → 400 PairNotSupported", rejectPair.status === 400 && rejectPair.body.code === "PairNotSupported", rejectPair);

  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    "WS wire: snapshot with seq first",
    wire[0]?.type === "book.snapshot" && typeof wire[0].seq === "number",
    wire[0],
  );
  const diffs = wire.filter((msg) => msg.type === "book.diff");
  check("WS wire: updates arrive as book.diff", diffs.length >= 2, wire.map((msg) => msg.type));
  check(
    "WS wire: seqs are consecutive",
    wire.every((msg, i) => i === 0 || msg.seq === wire[i - 1].seq + 1),
    wire.map((msg) => msg.seq),
  );
  const diffLevels = diffs.flatMap((msg) => (msg.type === "book.diff" ? [...msg.bids, ...msg.asks] : []));
  check(
    "WS wire: diff carries the new ask level",
    diffLevels.some((level) => level.price === 40.5 && level.size === 12.5),
    diffLevels,
  );
  const lastAssembled = assembled[assembled.length - 1];
  check(
    "SDK client: diff-assembled book equals REST book",
    lastAssembled?.type === "book.update" &&
      JSON.stringify({ bids: lastAssembled.book.bids, asks: lastAssembled.book.asks }) ===
        JSON.stringify({ bids: book.bids, asks: book.asks }),
    { assembled: lastAssembled?.book, rest: book },
  );

  unsubscribe();
  api.dispose();
  ws.close();
  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
