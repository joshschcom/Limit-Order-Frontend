import type { GridManifest, OrderRecord } from "@seltra/sdk";

export const OPEN_ORDER_STATUSES = new Set(["resting", "unfillable"]);

export interface ActiveGridGroup {
  manifest: GridManifest;
  members: OrderRecord[];
  openCount: number;
  filledCount: number;
}

/**
 * Joins local Grid manifests to API order records for the active-orders view.
 * A terminal Grid is deliberately omitted: its child orders remain available
 * individually in History, while the unactionable Grid card no longer sticks
 * around after its last child is filled, cancelled, or expired.
 */
export function buildActiveGridGroups(
  manifests: GridManifest[],
  orders: OrderRecord[],
): ActiveGridGroup[] {
  if (manifests.length === 0) return [];
  const byHash = new Map(orders.map((order) => [order.orderHash.toLowerCase(), order]));
  return manifests
    .map((manifest) => {
      const members = manifest.orderHashes
        .map((hash) => byHash.get(hash.toLowerCase()))
        .filter((order): order is OrderRecord => Boolean(order));
      return {
        manifest,
        members,
        openCount: members.filter((order) => OPEN_ORDER_STATUSES.has(order.status)).length,
        filledCount: members.filter((order) => order.status === "filled").length,
      };
    })
    .filter((group) => group.members.length > 0 && group.openCount > 0);
}
