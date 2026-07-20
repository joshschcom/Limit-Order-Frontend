"use client";

import { AlertTriangle, ExternalLink, Grid3x3, ListFilter, Loader2, WalletMinimal, WifiOff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { GRID_CANCEL_ALL_WARNING, type GridManifest, type OrderRecord } from "@seltra/sdk";
import { pairById, defaultTradePath, tokenBySymbol } from "@/config/seltra.config";
import { CANCEL_ALL, useCancelOrders } from "@/hooks/use-cancel-orders";
import { useGridManifests } from "@/lib/grid-manifests";
import { formatCountdown, useNowSeconds } from "@/lib/market-data";
import { NumberText } from "@/components/number-text";

const OPEN_STATUSES = new Set(["resting", "unfillable"]);

/** The maker's improvement is paid in their receive asset (quote when selling base, base when buying). */
export function fillImprovement(order: OrderRecord): { amount: number; symbol: string } | null {
  if (!order.fill) return null;
  const pair = pairById(order.pair);
  const receiveSymbol = order.side === "sell" ? pair.quote : pair.base;
  const token = tokenBySymbol(receiveSymbol);
  const amount = Number(formatUnits(BigInt(order.fill.makerImprovement), token.decimals));
  return amount > 0 ? { amount, symbol: receiveSymbol } : null;
}

type ConfirmState = { kind: "single"; record: OrderRecord } | { kind: "all" } | { kind: "grid"; gridId: string } | null;

interface GridGroup {
  manifest: GridManifest;
  members: OrderRecord[];
  openCount: number;
  filledCount: number;
}

export function OrdersTable({
  orders,
  isLoading = false,
  isOffline = false,
  isConnected = false,
  pro = false,
}: {
  orders: OrderRecord[];
  isLoading?: boolean;
  isOffline?: boolean;
  isConnected?: boolean;
  pro?: boolean;
}) {
  const [view, setView] = useState<"open" | "history" | "balances">("open");
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const now = useNowSeconds();
  const cancels = useCancelOrders();
  const visibleOrders = useMemo(() => {
    if (view === "open") return orders.filter((order) => OPEN_STATUSES.has(order.status));
    if (view === "history") return orders.filter((order) => !OPEN_STATUSES.has(order.status));
    return [];
  }, [orders, view]);
  const openCount = useMemo(() => orders.filter((order) => OPEN_STATUSES.has(order.status)).length, [orders]);
  const cancelAllPhase = cancels.pending[CANCEL_ALL];
  const manifests = useGridManifests();
  // Grids are local manifests joined against the API's order records; only
  // grids with at least one known order are shown.
  const gridGroups: GridGroup[] = useMemo(() => {
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
          openCount: members.filter((order) => OPEN_STATUSES.has(order.status)).length,
          filledCount: members.filter((order) => order.status === "filled").length,
        };
      })
      .filter((group) => group.members.length > 0);
  }, [orders, manifests]);

  function requestCancelAll() {
    cancels.clearError();
    setConfirm({ kind: "all" });
  }

  function requestCancel(record: OrderRecord) {
    cancels.clearError();
    setConfirm({ kind: "single", record });
  }

  function confirmed() {
    if (!confirm) return;
    // "grid" also uses incrementEpoch — the on-chain primitive is wallet-wide,
    // which is exactly what the confirm dialog warns about.
    if (confirm.kind === "all" || confirm.kind === "grid") void cancels.cancelAll();
    else void cancels.cancelOrder(confirm.record);
    setConfirm(null);
  }

  return (
    <section className="panel orders-panel">
      <div className="panel-head orders-heading">
        <div>
          <p className="eyebrow">Orders</p>
          <h2>Open orders and history</h2>
        </div>
        <div className="orders-actions">
          {isOffline ? <span className="chip stale-chip" title="Live connection lost. Showing the last known orders."><WifiOff size={11} /> stale</span> : null}
          <span className="table-count">{visibleOrders.length} shown</span>
          {view === "open" ? (
            <button
              className="button outline"
              type="button"
              disabled={openCount === 0 || !cancels.canCancel || cancelAllPhase !== undefined}
              title={!isConnected ? "Connect a wallet to cancel orders" : openCount === 0 ? "No open orders" : undefined}
              onClick={requestCancelAll}
            >
              {cancelAllPhase ? <Loader2 className="spin" size={13} /> : null}
              {cancelAllPhase === "wallet" ? "Confirm in wallet" : cancelAllPhase === "mining" ? "Cancelling all" : "Cancel all"}
            </button>
          ) : null}
        </div>
      </div>
      <div className="orders-tabs" role="tablist" aria-label="Orders view"><button className={view === "open" ? "active" : ""} type="button" role="tab" aria-selected={view === "open"} onClick={() => setView("open")}>Open orders</button><button className={view === "history" ? "active" : ""} type="button" role="tab" aria-selected={view === "history"} onClick={() => setView("history")}>History</button><button className={view === "balances" ? "active" : ""} type="button" role="tab" aria-selected={view === "balances"} onClick={() => setView("balances")}>Balances</button></div>
      {cancels.error ? <p className="form-error"><AlertTriangle size={14} /> {cancels.error}</p> : null}
      {view === "open" && gridGroups.length > 0 ? (
        <div className="grid-groups" aria-label="Grids">
          {gridGroups.map((group) => (
            <div key={group.manifest.gridId} className="grid-group">
              <Grid3x3 size={15} />
              <div className="grid-group-info">
                <strong>Grid {group.manifest.gridId.slice(2, 8)} · {group.manifest.pairId}</strong>
                <span>
                  {group.manifest.config.lowerPrice}–{group.manifest.config.upperPrice} · {group.members.length} orders
                  {" · "}{group.openCount} open · {group.filledCount} filled
                  {group.manifest.failedLevels.length > 0 ? ` · ${group.manifest.failedLevels.length} never placed` : ""}
                </span>
              </div>
              {group.openCount > 0 ? (
                <button
                  className="button outline"
                  type="button"
                  disabled={!cancels.canCancel || cancelAllPhase !== undefined}
                  onClick={() => {
                    cancels.clearError();
                    setConfirm({ kind: "grid", gridId: group.manifest.gridId });
                  }}
                >
                  {cancelAllPhase ? <Loader2 className="spin" size={13} /> : null}
                  Cancel entire grid
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {view === "balances" ? <BalancesEmpty /> : null}
      {view !== "balances" && isLoading ? <OrdersLoading /> : null}
      {view !== "balances" && !isLoading && visibleOrders.length === 0 ? <OrdersEmpty isConnected={isConnected} /> : null}
      {view !== "balances" && !isLoading && visibleOrders.length > 0 ? <div className={`orders-table ${pro ? "pro" : ""}`}>
        <div className="orders-row header">
          <span>Pair</span>
          <span>Side</span>
          <span>Amount</span>
          <span>Limit</span>
          <span>Filled at</span>
          <span>Expires</span>
          <span>Status</span>
          {pro ? <span>Hash</span> : null}
          <span />
        </div>
        {visibleOrders.map((order) => (
          <OrderRow
            key={order.orderHash}
            order={order}
            now={now}
            pro={pro}
            cancelPhase={cancels.pending[order.orderHash]}
            canCancel={cancels.canCancel}
            onCancel={() => requestCancel(order)}
          />
        ))}
      </div> : null}
      {confirm ? (
        <ConfirmCancelDialog
          message={
            confirm.kind === "all"
              ? "One transaction. Invalidates every open Seltra order from this wallet."
              : confirm.kind === "grid"
                ? GRID_CANCEL_ALL_WARNING
                : "Cancels this order on-chain. Costs one transaction."
          }
          onConfirm={confirmed}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}

function OrderRow({
  order,
  now,
  pro,
  cancelPhase,
  canCancel,
  onCancel,
}: {
  order: OrderRecord;
  now: number;
  pro: boolean;
  cancelPhase?: "wallet" | "mining";
  canCancel: boolean;
  onCancel: () => void;
}) {
  const pair = pairById(order.pair);
  const isOpen = OPEN_STATUSES.has(order.status);
  const countdown = isOpen ? formatCountdown(Number(order.order.expiry), now) : { label: order.status, warn: false };
  const improvement = fillImprovement(order);
  return (
    <div className="orders-row">
      <span data-label="Pair" className="pair-cell">{order.pair}</span>
      <span data-label="Side" className={`side-cell ${order.side === "buy" ? "buy" : "sell"}`}>{order.side.toUpperCase()}</span>
      <span data-label="Amount"><NumberText value={Number(order.baseAmount)} precision={pair.amountPrecision} /></span>
      <span data-label="Limit"><NumberText value={Number(order.price)} precision={pair.pricePrecision} suffix={` ${pair.quote}`} /></span>
      <span data-label="Filled at" className="fill-cell">
        {order.fill ? <NumberText value={Number(order.price)} precision={pair.pricePrecision} suffix={` ${pair.quote}`} /> : "-"}
        {improvement ? <NumberText value={improvement.amount} precision={4} suffix={` ${improvement.symbol}`} signed tone="buy" /> : null}
      </span>
      <span data-label="Expires" className={`expiry-countdown ${countdown.warn ? "warn" : ""}`}>{countdown.label}</span>
      <span
        data-label="Status"
        className={`chip status-chip ${order.status}`}
        title={order.status === "unfillable" ? "Current balance is below the order amount. The order becomes fillable again if the balance returns, or you can cancel it." : undefined}
      ><i />{order.softCancelled && isOpen ? "hidden" : order.status}</span>
      {pro ? <span data-label="Order hash" className="mono hash-cell">{order.orderHash}</span> : null}
      <span className="row-actions">
        {isOpen ? (
          <button
            className="button outline row-cancel"
            type="button"
            disabled={!canCancel || cancelPhase !== undefined}
            title={canCancel ? "Cancel this order on-chain" : "Connect a wallet on Avalanche to cancel"}
            onClick={onCancel}
          >
            {cancelPhase ? <Loader2 className="spin" size={12} /> : null}
            {cancelPhase === "wallet" ? "Confirm" : cancelPhase === "mining" ? "Cancelling" : "Cancel"}
          </button>
        ) : null}
        <a className="icon-button table-action" href={`/order/${order.orderHash}`} aria-label={`View ${order.pair} order`} title="View order">
          <ExternalLink size={14} />
        </a>
      </span>
    </div>
  );
}

function ConfirmCancelDialog({ message, onConfirm, onClose }: { message: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 id="cancel-dialog-title">Cancel order</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" title="Close">
            <X size={17} />
          </button>
        </div>
        <p className="modal-note">{message}</p>
        <div className="modal-actions">
          <button className="button outline" type="button" onClick={onClose}>Keep order</button>
          <button className="button accent" type="button" onClick={onConfirm}>Cancel on-chain</button>
        </div>
      </div>
    </div>
  );
}

function OrdersLoading() {
  return (
    <div className="orders-empty">
      <Loader2 className="spin" size={22} />
      <div><strong>Loading orders</strong><span>Fetching signed orders from the Seltra orderbook.</span></div>
    </div>
  );
}

function OrdersEmpty({ isConnected }: { isConnected: boolean }) {
  return (
    <div className="orders-empty">
      <WalletMinimal size={22} />
      {isConnected ? (
        <div><strong>No orders to show</strong><span>Place a limit order and it will rest here until it fills or expires.</span></div>
      ) : (
        <div><strong>No orders to show</strong><span>Connect a wallet to view signed orders, fills, and expiry updates.</span></div>
      )}
      <a className="button outline" href={defaultTradePath}><ListFilter size={15} /> Open terminal</a>
    </div>
  );
}

function BalancesEmpty() {
  return <div className="orders-empty balances-empty"><WalletMinimal size={22} /><div><strong>Wallet balances</strong><span>Connect a wallet to view balances available for new Seltra orders.</span></div><a className="button outline" href={defaultTradePath}><ListFilter size={15} /> Trade</a></div>;
}
