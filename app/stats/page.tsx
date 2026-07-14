"use client";

import { Loader2, WifiOff } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { defaultPairId } from "@/config/seltra.config";
import { NumberText } from "@/components/number-text";
import { useStats } from "@/lib/market-data";

export default function StatsPage() {
  const { data: stats, isLoading, isError } = useStats();

  return (
    <AppShell pairId={defaultPairId}>
      <main className="page-stack">
        <section className="page-heading">
          <div>
            <p className="eyebrow">Protocol</p>
            <h1>Stats</h1>
          </div>
        </section>
        {isLoading ? (
          <section className="panel orders-empty">
            <Loader2 className="spin" size={22} />
            <div><strong>Loading stats</strong><span>Fetching protocol totals from the Seltra orderbook.</span></div>
          </section>
        ) : null}
        {isError ? (
          <section className="panel orders-empty">
            <WifiOff size={22} />
            <div><strong>Stats unavailable</strong><span>Cannot reach the Seltra orderbook service. Retrying automatically.</span></div>
          </section>
        ) : null}
        {stats ? (
          <section className="panel detail-grid">
            <div>
              <span className="label">Total volume</span>
              <NumberText value={Number(stats.totalVolumeQuote)} suffix=" USDC" />
            </div>
            <div>
              <span className="label">Orders filled</span>
              <NumberText value={stats.ordersFilled} precision={0} />
            </div>
            <div>
              <span className="label">Resting orders</span>
              <NumberText value={stats.ordersResting} precision={0} />
            </div>
            <div>
              <span className="label">Average improvement</span>
              {stats.avgImprovementBps !== null ? <NumberText value={stats.avgImprovementBps / 100} suffix="%" signed tone="buy" /> : <strong className="number">—</strong>}
            </div>
            <div>
              <span className="label">P2P match rate</span>
              {stats.p2pMatchRateBps !== null ? <NumberText value={stats.p2pMatchRateBps / 100} suffix="%" /> : <strong className="number">—</strong>}
            </div>
          </section>
        ) : null}
      </main>
    </AppShell>
  );
}
