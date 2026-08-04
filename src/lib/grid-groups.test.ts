import assert from "node:assert/strict";
import test from "node:test";

import type { GridManifest, OrderRecord } from "@seltra/sdk";
import { buildActiveGridGroups } from "./grid-groups";

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
