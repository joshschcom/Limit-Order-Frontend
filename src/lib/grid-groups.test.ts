import assert from "node:assert/strict";
import test from "node:test";

import type { GridManifest, OrderRecord } from "@seltra/sdk";
import { awaitingTakeProfit, buildActiveGridGroups, buildHistoryItems } from "./grid-groups";

const manifest = {
  gridId: "0xgrid",
  maker: "0x0000000000000000000000000000000000000001",
  pairId: "WAVAX-USDC",
  orderHashes: ["0x01", "0x02"],
  failedLevels: [],
  config: {},
} as unknown as GridManifest;

function order(orderHash: string, status: OrderRecord["status"]): OrderRecord {
  return { orderHash, status } as OrderRecord;
}

test("terminal grids are omitted from the active Grid section", () => {
  const groups = buildActiveGridGroups(
    [manifest],
    [order("0x01", "filled"), order("0x02", "cancelled")],
  );
  assert.deepEqual(groups, []);
});

test("a partially completed grid remains active while any child is open", () => {
  const [group] = buildActiveGridGroups(
    [manifest],
    [order("0x01", "filled"), order("0x02", "resting")],
  );
  assert.ok(group);
  assert.equal(group.openCount, 1);
  assert.equal(group.filledCount, 1);
});

test("closed grid children collapse into one history item; unrelated orders stay plain", () => {
  const items = buildHistoryItems(
    [manifest],
    [order("0x01", "filled"), order("0xaa", "cancelled"), order("0x02", "expired")],
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "grid");
  assert.deepEqual(
    items[0].kind === "grid" ? items[0].children.map((child) => child.orderHash) : [],
    ["0x01", "0x02"],
  );
  assert.deepEqual(items[1], { kind: "order", order: order("0xaa", "cancelled") });
});

test("a grid still has its open children kept out of history", () => {
  const items = buildHistoryItems([manifest], [order("0x01", "filled"), order("0x02", "resting")]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind === "grid" ? items[0].children.length : -1, 1);
});

test("a grid whose children the API no longer returns yields no history card", () => {
  assert.deepEqual(buildHistoryItems([manifest], [order("0xaa", "filled")]), [{ kind: "order", order: order("0xaa", "filled") }]);
});

// --- Martingale take-profit prompt ---------------------------------------

const ladder = {
  ...manifest,
  pairId: "WAVAX-USDC",
  createdAt: 1_000,
  config: { strategy: "martingale" },
} as unknown as GridManifest;

function buy(orderHash: string, status: OrderRecord["status"], making: string, taking: string, improvement?: string): OrderRecord {
  return {
    orderHash,
    status,
    side: "buy",
    pair: "WAVAX-USDC",
    createdAt: 1_000,
    order: { makingAmount: making, takingAmount: taking },
    fill: improvement === undefined ? undefined : { makerImprovement: improvement },
  } as unknown as OrderRecord;
}

function sell(orderHash: string, status: OrderRecord["status"], making: string, createdAt = 2_000, pair = "WAVAX-USDC"): OrderRecord {
  return { orderHash, status, side: "sell", pair, createdAt, order: { makingAmount: making } } as unknown as OrderRecord;
}

test("ladder position counts filled buys including improvement", () => {
  const orders = [buy("0x01", "filled", "50", "10", "2"), buy("0x02", "resting", "50", "9")];
  const [group] = buildActiveGridGroups([ladder], orders);
  assert.deepEqual(group.position, { spentQuote: 50n, receivedBase: 12n, soldBase: 0n, unsoldBase: 12n });
  assert.equal(awaitingTakeProfit(group), true);
});

test("a finished ladder stays active only while base is unsold", () => {
  const filled = [buy("0x01", "filled", "50", "10"), buy("0x02", "filled", "50", "9")];
  assert.equal(buildActiveGridGroups([ladder], filled).length, 1);
  // a resting sell for everything bought commits it; a cancelled one does not
  assert.equal(buildActiveGridGroups([ladder], [...filled, sell("0xs1", "resting", "19")]).length, 0);
  assert.equal(buildActiveGridGroups([ladder], [...filled, sell("0xs1", "cancelled", "19")]).length, 1);
});

test("sells from before the ladder or on another pair do not reduce the position", () => {
  const filled = [buy("0x01", "filled", "50", "10"), buy("0x02", "filled", "50", "9")];
  const [group] = buildActiveGridGroups(
    [ladder],
    [...filled, sell("0xs1", "filled", "5", 500), sell("0xs2", "filled", "5", 2_000, "BTC.b-USDC"), sell("0xs3", "filled", "4")],
  );
  assert.equal(group.position?.soldBase, 4n);
  assert.equal(group.position?.unsoldBase, 15n);
});

test("dismissing the take-profit prompt removes a finished ladder from the active view", () => {
  const filled = [buy("0x01", "filled", "50", "10"), buy("0x02", "filled", "50", "9")];
  assert.equal(buildActiveGridGroups([{ ...ladder, takeProfitDismissed: true }], filled).length, 0);
});

test("standard grids never get a take-profit prompt", () => {
  const [group] = buildActiveGridGroups([manifest], [order("0x01", "filled"), order("0x02", "resting")]);
  assert.equal(group.position, undefined);
  assert.equal(awaitingTakeProfit(group), false);
});
