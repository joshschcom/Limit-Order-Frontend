import type { GridManifest, OrderRecord } from "@seltra/sdk";

export const OPEN_ORDER_STATUSES = new Set(["resting", "unfillable"]);

/** Base a Martingale ladder has bought and not yet sold, derived from API order records. */
export interface LadderPosition {
  /** Quote spent by filled levels (their exact making amounts). */
  spentQuote: bigint;
  /** Base received by filled levels, including any price improvement. */
  receivedBase: bigint;
  /** Base committed to sells on this pair placed since the ladder was created. */
  soldBase: bigint;
  /** receivedBase less soldBase, never negative. */
  unsoldBase: bigint;
}

export interface ActiveGridGroup {
  manifest: GridManifest;
  members: OrderRecord[];
  openCount: number;
  filledCount: number;
  /** Martingale ladders only. */
  position?: LadderPosition;
}

/**
 * What a Martingale ladder still holds. Sells count against it when they are
 * resting, unfillable, or filled, were placed after the ladder, and are on the
 * same pair — a manual sell therefore reduces the suggestion rather than
 * letting the app offer to sell base that is already committed. The result is
 * a suggestion only: the order form still validates the wallet balance.
 */
export function ladderPosition(members: OrderRecord[], manifest: GridManifest, orders: OrderRecord[]): LadderPosition {
  let spentQuote = 0n;
  let receivedBase = 0n;
  for (const order of members) {
    if (order.status !== "filled") continue;
    spentQuote += BigInt(order.order.makingAmount);
    receivedBase += BigInt(order.order.takingAmount) + BigInt(order.fill?.makerImprovement ?? "0");
  }
  let soldBase = 0n;
  for (const order of orders) {
    if (order.side !== "sell" || order.pair !== manifest.pairId) continue;
    if (order.status === "cancelled" || order.status === "expired") continue;
    if (order.createdAt < manifest.createdAt) continue;
    soldBase += BigInt(order.order.makingAmount);
  }
  return { spentQuote, receivedBase, soldBase, unsoldBase: receivedBase > soldBase ? receivedBase - soldBase : 0n };
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
        position: manifest.config.strategy === "martingale" ? ladderPosition(members, manifest, orders) : undefined,
      };
    })
    .filter((group) => group.members.length > 0);
}

/** A Martingale ladder with bought-but-unsold base still has something to act on. */
export function awaitingTakeProfit(group: ActiveGridGroup): boolean {
  return (
    group.manifest.config.strategy === "martingale" &&
    !group.manifest.takeProfitDismissed &&
    (group.position?.unsoldBase ?? 0n) > 0n
  );
}

/**
 * The active-orders view. A terminal Grid is deliberately omitted: its child
 * orders remain available in History, while the unactionable Grid card no
 * longer sticks around after its last child is filled, cancelled, or expired.
 * A Martingale ladder stays until its bought base is sold or the user
 * dismisses the take-profit prompt, because that is still actionable.
 */
export function buildActiveGridGroups(manifests: GridManifest[], orders: OrderRecord[]): ActiveGridGroup[] {
  return buildGridGroups(manifests, orders).filter((group) => group.openCount > 0 || awaitingTakeProfit(group));
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
