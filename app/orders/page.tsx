"use client";

import { AppShell } from "@/components/app-shell";
import { defaultPairId, defaultTradePath } from "@/config/seltra.config";
import { OrdersTable } from "@/components/orders-table";
import { useMyOrders } from "@/lib/market-data";

export default function OrdersPage() {
  const ordersQuery = useMyOrders();

  return (
    <AppShell pairId={defaultPairId}>
      <main className="page-stack">
        <section className="page-heading">
          <div>
            <p className="eyebrow">Wallet</p>
            <h1>Orders</h1>
          </div>
          <a className="button accent" href={defaultTradePath}>
            Trade
          </a>
        </section>
        <OrdersTable
          orders={ordersQuery.data ?? []}
          isLoading={ordersQuery.isConnected && ordersQuery.isLoading}
          isOffline={ordersQuery.isError}
          isConnected={ordersQuery.isConnected}
          pro
        />
      </main>
    </AppShell>
  );
}
