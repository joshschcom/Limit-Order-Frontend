import type { GridManifest, OrderRecord } from "@seltra/sdk";

export const OPEN_ORDER_STATUSES = new Set(["resting", "unfillable"]);

export interface ActiveGridGroup {
  manifest: GridManifest;
  members: OrderRecord[];
  openCount: number;
  filledCount: number;
}

/**
 * Joins local Grid manifests to API order records. A manifest only becomes a
 * group when at least one of its child orders is known to the API.
 */
export function buildGridGroups(manifests: GridManifest[], orders: OrderRecord[]): ActiveGridGroup[] {
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
    .filter((group) => group.members.length > 0);
}

/**
 * The active-orders view. A terminal Grid is deliberately omitted: its child
 * orders remain available in History, while the unactionable Grid card no
 * longer sticks around after its last child is filled, cancelled, or expired.
 */
export function buildActiveGridGroups(manifests: GridManifest[], orders: OrderRecord[]): ActiveGridGroup[] {
  return buildGridGroups(manifests, orders).filter((group) => group.openCount > 0);
}

export type HistoryItem =
  | { kind: "grid"; group: ActiveGridGroup; children: OrderRecord[] }
  | { kind: "order"; order: OrderRecord };

/**
 * Collapses finished Grid children into one item per Grid so History is not
 * flooded with up to a ladder's worth of rows per Grid. Nothing is hidden or
 * removed: every closed order is still reachable, either as a plain row or as a
 * child of its Grid. Items keep the position of the first member encountered,
 * so the incoming (newest-first) order is preserved. Orders that belong to no
 * stored manifest stay ungrouped.
 */
export function buildHistoryItems(manifests: GridManifest[], orders: OrderRecord[]): HistoryItem[] {
  const closed = orders.filter((order) => !OPEN_ORDER_STATUSES.has(order.status));
  const groupByHash = new Map<string, ActiveGridGroup>();
  for (const group of buildGridGroups(manifests, orders)) {
    for (const member of group.members) groupByHash.set(member.orderHash.toLowerCase(), group);
  }

  const items: HistoryItem[] = [];
  const placed = new Map<string, Extract<HistoryItem, { kind: "grid" }>>();
  for (const order of closed) {
    const group = groupByHash.get(order.orderHash.toLowerCase());
    if (!group) {
      items.push({ kind: "order", order });
      continue;
    }
    const existing = placed.get(group.manifest.gridId);
    if (existing) {
      existing.children.push(order);
    } else {
      const item: Extract<HistoryItem, { kind: "grid" }> = { kind: "grid", group, children: [order] };
      placed.set(group.manifest.gridId, item);
      items.push(item);
    }
  }
  return items;
}
