"use client";

import { useQuery } from "@tanstack/react-query";
import { seltraApi } from "@/lib/api";

/**
 * Landing-page stats band. Hidden entirely when the API is unreachable or the
 * protocol has no activity yet — never zeros, never placeholders (design spec §4.4).
 */
export function LiveStrip() {
  const { data: stats } = useQuery({
    queryKey: ["seltra", "stats"],
    queryFn: () => seltraApi.getStats(),
    retry: 1,
    refetchInterval: 60_000,
  });

  if (!stats) return null;
  const hasActivity = stats.ordersFilled > 0 || Number(stats.totalVolumeQuote) > 0 || stats.ordersResting > 0;
  if (!hasActivity) return null;

  return (
    <section className="landing-stats" aria-label="Protocol statistics">
      <Stat label="Total volume" value={`$${Number(stats.totalVolumeQuote).toLocaleString()}`} />
      <Stat label="Orders filled" value={stats.ordersFilled.toLocaleString()} />
      <Stat label="Resting orders" value={stats.ordersResting.toLocaleString()} />
      {stats.avgImprovementBps !== null ? (
        <Stat label="Avg. improvement" value={`+${(stats.avgImprovementBps / 100).toFixed(2)}%`} tone="buy" />
      ) : null}
      {stats.p2pMatchRateBps !== null ? (
        <Stat label="P2P match rate" value={`${(stats.p2pMatchRateBps / 100).toFixed(1)}%`} />
      ) : null}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "buy" }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={`number ${tone ?? ""}`}>{value}</strong>
    </div>
  );
}
