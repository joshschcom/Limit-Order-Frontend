"use client";

import { AlertTriangle, ExternalLink, ListFilter, Loader2, WalletMinimal, WifiOff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import type { OrderRecord } from "@seltra/sdk";
import { pairById, defaultTradePath, tokenBySymbol } from "@/config/seltra.config";
import { CANCEL_ALL, useCancelOrders } from "@/hooks/use-cancel-orders";
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

type ConfirmState = { kind: "single"; record: OrderRecord } | { kind: "all" } | null;

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
    if (confirm.kind === "all") void cancels.cancelAll();
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
