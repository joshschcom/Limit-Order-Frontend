"use client";

import { Activity, BarChart3, ShieldCheck, Triangle, Wifi, WifiOff } from "lucide-react";
import Link from "next/link";
import { useBlockNumber, useReadContract } from "wagmi";
import { seltraConfig, isConfiguredAddress, pairById, defaultTradePath } from "@/config/seltra.config";
import { seltraSettlementAbi } from "@/lib/abi";
import { bookDepthQuote, bookMid, useOrderbook, useQuote, useStats, useWsStatus } from "@/lib/market-data";
import { ThemeToggle } from "@/components/theme-controls";
import { WalletButton, WalletDialogProvider } from "@/components/wallet-button";

function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export function AppShell({ children, pairId, modeControl }: { children: React.ReactNode; pairId: string; modeControl?: React.ReactNode }) {
  const pair = pairById(pairId);
  const { data: fillsPaused } = useReadContract({
    address: seltraConfig.contracts.settlement,
    abi: seltraSettlementAbi,
    functionName: "fillsPaused",
    query: { enabled: isConfiguredAddress(seltraConfig.contracts.settlement) },
  });
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const { data: book, isError: bookError } = useOrderbook(pair.id);
  const { data: quote } = useQuote(pair.id);
  const { data: stats, isError: statsError } = useStats();
  const wsStatus = useWsStatus();

  const mid = bookMid(book);
  const depth = bookDepthQuote(book);
  const apiOffline = bookError && statsError;
  const live = wsStatus === "open";

  return (
    <WalletDialogProvider>
      <div className="app-shell">
        <header className="exchange-nav">
          <div className="exchange-nav-left">
            <Link className="brand" href="/" aria-label="Seltra home">
              <span className="brand-mark" />
              <span className="brand-word">Seltra</span>
            </Link>
            <nav className="nav-links" aria-label="Application">
              <Link href="/trade">Markets</Link>
              <Link href={defaultTradePath}>Trade</Link>
              <Link href="/orders">Orders</Link>
              <Link href="/stats">Stats</Link>
              <Link href="/docs">Docs</Link>
            </nav>
          </div>
          <div className="exchange-nav-actions">
            <ThemeToggle />
            {modeControl}
            <WalletButton />
          </div>
        </header>
        <div className="market-strip" aria-label="Market summary">
          <div className="market-selector-wrap">
            <span className="network-chip"><Triangle size={9} fill="currentColor" /> Avalanche</span>
            <select className="pair-select" value={pair.id} aria-label="Market pair" onChange={(event) => (window.location.href = `/trade/${event.target.value}`)}>
              {seltraConfig.pairs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="ticker-strip">
            <TickerItem label="Executable" value={quote ? `$${quote.price.toFixed(pair.pricePrecision)}` : "—"} />
            <TickerItem label="Book mid" value={mid !== undefined ? `$${mid.toFixed(pair.pricePrecision)}` : "—"} />
            <TickerItem label="Book depth" value={depth !== undefined ? compactUsd(depth) : "—"} />
            <TickerItem label="Resting orders" value={stats ? String(stats.ordersResting) : "—"} />
            <TickerItem label="Orders filled" value={stats ? String(stats.ordersFilled) : "—"} />
            <span className={`chip conn-chip ${apiOffline ? "offline" : live ? "live" : "connecting"}`} title={apiOffline ? "Cannot reach the Seltra orderbook service" : live ? "Live data stream connected" : "Connecting to the live data stream"}>
              {apiOffline ? <WifiOff size={11} /> : <Wifi size={11} />}
              {apiOffline ? "Offline" : live ? "Live" : "Connecting"}
            </span>
          </div>
        </div>
        {fillsPaused ? (
          <div className="pause-banner">
            <ShieldCheck size={16} />
            Fills are paused by the guardian. Your funds are in your wallet. You can still cancel orders.
          </div>
        ) : null}
        {children}
        <footer className="footer">
          <span className="footer-brand">Seltra</span>
          <span>Wallet-native limit orders</span>
          <span className="mono">{isConfiguredAddress(seltraConfig.contracts.settlement) ? seltraConfig.contracts.settlement : "Settlement not configured"}</span>
          <span className="heartbeat">
            <Activity size={13} />
            {!isConfiguredAddress(seltraConfig.contracts.settlement)
              ? "Guardian status unavailable"
              : fillsPaused
                ? "Guardian pause active"
                : "Guardian active / Fills live"}
          </span>
          <span className="heartbeat">
            <BarChart3 size={13} /> {blockNumber !== undefined ? `Block ${blockNumber.toString()}` : "Block —"}
          </span>
        </footer>
      </div>
    </WalletDialogProvider>
  );
}

function TickerItem({ label, value, tone }: { label: string; value: string; tone?: "buy" | "sell" }) {
  return (
    <span>
      <small>{label}</small>
      <strong className={`number ${tone ?? ""}`}>{value}</strong>
    </span>
  );
}
