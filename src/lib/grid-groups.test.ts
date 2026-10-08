import assert from "node:assert/strict";
import test from "node:test";

import type { GridManifest, OrderRecord } from "@seltra/sdk";
import { buildActiveGridGroups, buildHistoryItems } from "./grid-groups";

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
